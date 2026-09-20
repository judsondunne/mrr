/**
 * PUBLIC API — CATEGORY VERIFICATION LAYER. Owned by the discovery agent.
 *
 * Reads what discovery already persisted (competitors, reviews, source
 * documents) and decides, with PURE CODE, whether businesses demonstrably
 * already pay in this category.
 *
 * Every state change goes through `transitionOpportunity()`. This file never
 * writes `opportunities.state` with raw SQL, and it never asks an LLM whether
 * a category is good.
 */
import { recordAudit, transitionOpportunity } from '../../lib/audit';
import { getConfig } from '../../lib/config';
import { getDb, toNumber } from '../../lib/db';
import { AppError } from '../../lib/errors';
import { createLogger } from '../../lib/logger';
import { dayStart } from '../../lib/cost';
import type {
  EvidenceConfidence,
  EvidenceItem,
  ExtractedReview,
  RejectionReason,
} from '../../lib/contracts';
import {
  assessCategoryEvidence,
  meetsConfidence,
  readCompetitorEvidenceJson,
  type CompetitorFacts,
  type EvidenceAssessment,
} from './evidence';
import { estimateBuildDays, evaluateRejectionRules, type RejectionSubject } from './rejection-rules';

const logger = createLogger('verification');
const ACTOR = 'verify_categories';

export interface VerificationOutcome {
  opportunityId: string;
  verified: boolean;
  confidence: EvidenceConfidence;
  strongEvidence: EvidenceItem[];
  supportingEvidence: EvidenceItem[];
  competitorCount: number;
  paidCompetitorCount: number;
  estimatedBuildDays: number | null;
  rejectionReason: RejectionReason | null;
  rejectionDetail: string | null;
}

// --- reading the persisted facts ---------------------------------------------

interface OpportunityRow {
  id: string;
  name: string;
  ecosystem: string;
  category: string;
  description: string;
  state: string;
}

interface CompetitorRow {
  id: string;
  name: string;
  url: string;
  current_pricing: string | null;
  free_plan_details: string | null;
  has_permanent_free_tier: boolean | null;
  review_count: number | null;
  rating: string | number | null;
  launch_age: string | null;
  evidence_json: unknown;
}

interface ReviewRow {
  competitor_id: string;
  source_url: string;
  rating: number | null;
  review_date: string | Date | null;
  merchant_name: string | null;
  merchant_domain_if_public: string | null;
  usage_duration: string | null;
  text: string;
  payment_signal: string | null;
  complaint_tags: unknown;
}

function toIsoDate(value: string | Date | null): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value.slice(0, 10);
}

function toStringArray(value: unknown): string[] {
  const raw = typeof value === 'string' ? safeParse(value) : value;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string');
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toPaymentSignal(raw: string | null): ExtractedReview['paymentSignal'] {
  return raw === 'PAID_PLAN_REFERENCED' || raw === 'EXCEEDS_FREE_TIER' ? raw : 'NONE';
}

async function loadFacts(opportunityId: string): Promise<CompetitorFacts[]> {
  const db = await getDb();
  const competitors = await db.query<CompetitorRow>(
    `SELECT id, name, url, current_pricing, free_plan_details, has_permanent_free_tier,
            review_count, rating, launch_age, evidence_json
       FROM competitors WHERE opportunity_id = $1 ORDER BY created_at`,
    [opportunityId],
  );
  if (competitors.rows.length === 0) return [];

  const ids = competitors.rows.map((c) => c.id);
  const placeholders = ids.map((_id, i) => `$${i + 1}`).join(',');
  const reviews = await db.query<ReviewRow>(
    `SELECT competitor_id, source_url, rating, review_date, merchant_name,
            merchant_domain_if_public, usage_duration, text, payment_signal, complaint_tags
       FROM reviews WHERE competitor_id IN (${placeholders}) ORDER BY created_at`,
    ids,
  );

  const byCompetitor = new Map<string, ExtractedReview[]>();
  for (const r of reviews.rows) {
    const list = byCompetitor.get(r.competitor_id) ?? [];
    list.push({
      sourceUrl: r.source_url,
      rating: r.rating === null ? null : toNumber(r.rating),
      reviewDate: toIsoDate(r.review_date),
      merchantName: r.merchant_name,
      merchantDomainIfPublic: r.merchant_domain_if_public,
      usageDuration: r.usage_duration,
      text: r.text,
      paymentSignal: toPaymentSignal(r.payment_signal),
      complaintTags: toStringArray(r.complaint_tags),
    });
    byCompetitor.set(r.competitor_id, list);
  }

  return competitors.rows.map((c) => {
    const facts = readCompetitorEvidenceJson(c.evidence_json);
    return {
      name: c.name,
      url: c.url,
      currentPricing: c.current_pricing,
      freePlanDetails: c.free_plan_details,
      hasPermanentFreeTier: c.has_permanent_free_tier,
      reviewCount: c.review_count,
      rating: c.rating === null ? null : toNumber(c.rating),
      launchAge: c.launch_age,
      paidPlanPrices: facts.paidPlanPrices,
      disclosureText: facts.description,
      observedAt: facts.observedAt,
      reviews: byCompetitor.get(c.id) ?? [],
    } satisfies CompetitorFacts;
  });
}

/** Everything already fetched about this category, for the rule corpus. */
function buildCorpus(facts: CompetitorFacts[]): string {
  const parts: string[] = [];
  for (const c of facts) {
    parts.push(c.name, c.currentPricing ?? '', c.freePlanDetails ?? '', c.disclosureText ?? '');
    for (const r of c.reviews.slice(0, 40)) parts.push(r.text);
  }
  return parts.filter(Boolean).join('\n').slice(0, 20_000);
}

// --- daily cap ---------------------------------------------------------------

/** Deep verifications already started today, counted from the audit trail. */
async function verificationsStartedToday(): Promise<number> {
  const db = await getDb();
  const res = await db.query<{ n: string | number }>(
    `SELECT COUNT(DISTINCT entity_id) AS n
       FROM audit_events
      WHERE entity_type = 'opportunity'
        AND event_type = 'STATE_TRANSITION'
        AND to_state = 'CATEGORY_VERIFYING'
        AND created_at >= $1`,
    [dayStart().toISOString()],
  );
  return toNumber(res.rows[0]?.n, 0);
}

// --- outcomes ----------------------------------------------------------------

function outcomeFrom(
  opportunityId: string,
  assessment: EvidenceAssessment,
  buildDays: number | null,
  rejection: { reason: RejectionReason; detail: string } | null,
): VerificationOutcome {
  return {
    opportunityId,
    verified: rejection === null,
    confidence: assessment.confidence,
    strongEvidence: assessment.strong,
    supportingEvidence: assessment.supporting,
    competitorCount: assessment.competitorCount,
    paidCompetitorCount: assessment.paidCompetitorCount,
    estimatedBuildDays: buildDays,
    rejectionReason: rejection?.reason ?? null,
    rejectionDetail: rejection?.detail ?? null,
  };
}

/**
 * Verifies exactly one opportunity. Moves it to VERIFIED or REJECTED.
 *
 * Order of operations matters: the cheap disqualifying rules run before any
 * evidence weighing, and the evidence bar is the last gate.
 */
export async function verifyOpportunity(opportunityId: string): Promise<VerificationOutcome> {
  const cfg = getConfig();
  const db = await getDb();

  const res = await db.query<OpportunityRow>(
    'SELECT id, name, ecosystem, category, description, state FROM opportunities WHERE id = $1',
    [opportunityId],
  );
  const opp = res.rows[0];
  if (!opp) {
    throw new AppError(`no opportunity ${opportunityId}`, 'NOT_FOUND', false, { opportunityId });
  }
  if (opp.state !== 'DISCOVERED' && opp.state !== 'CATEGORY_VERIFYING') {
    throw new AppError(
      `opportunity ${opportunityId} is in state ${opp.state}; category verification only runs from DISCOVERED`,
      'NOT_VERIFIABLE',
      false,
      { state: opp.state },
    );
  }

  await transitionOpportunity({
    opportunityId,
    to: 'CATEGORY_VERIFYING',
    actor: ACTOR,
    reason: 'deep category verification started',
  });

  const facts = await loadFacts(opportunityId);
  const subject: RejectionSubject = {
    name: opp.name,
    category: opp.category,
    description: opp.description,
    corpus: buildCorpus(facts),
    competitorCount: facts.length,
  };

  const estimate = estimateBuildDays(subject);
  const verdict = evaluateRejectionRules({ ...subject, estimatedBuildDays: estimate.days });
  const assessment = assessCategoryEvidence(facts);

  const reject = async (reason: RejectionReason, detail: string): Promise<VerificationOutcome> => {
    await transitionOpportunity({
      opportunityId,
      to: 'CATEGORY_REJECTED',
      actor: ACTOR,
      reason: detail,
      set: {
        rejection_reason: reason,
        evidence_confidence: assessment.confidence,
        estimated_build_days: estimate.days,
      },
      detail: {
        reason,
        penalty: verdict.penalty,
        rules: verdict.matches.map((m) => m.ruleId),
        confidence: assessment.confidence,
        evidenceReasons: assessment.reasons,
        buildDrivers: estimate.drivers,
      },
    });
    await recordAudit({
      entityType: 'opportunity',
      entityId: opportunityId,
      eventType: 'REJECTION',
      actor: ACTOR,
      reason: detail,
      detail: { reason, evidence: assessment.all.slice(0, 20) },
    });
    logger.info('category rejected', { opportunityId, reason, detail });
    return outcomeFrom(opportunityId, assessment, estimate.days, { reason, detail });
  };

  if (verdict.rejected && verdict.reason) {
    return reject(verdict.reason, `${verdict.ruleId}: ${verdict.detail}`);
  }

  if (assessment.confidence === 'NONE') {
    return reject(
      'NO_PAYMENT_EVIDENCE',
      facts.length === 0
        ? 'no competitor listings were captured, so there is no evidence anyone pays'
        : `no payment evidence found across ${facts.length} competitor listing(s)`,
    );
  }

  const required = cfg.gate.requiredCategoryEvidenceConfidence;
  if (!meetsConfidence(assessment.confidence, required)) {
    const reason: RejectionReason =
      assessment.strong.length === 0 ? 'ONLY_WEAK_EVIDENCE' : 'NO_PAYMENT_EVIDENCE';
    return reject(
      reason,
      `evidence confidence ${assessment.confidence} is below the required ${required}: ${assessment.reasons.join('; ')}`,
    );
  }

  await transitionOpportunity({
    opportunityId,
    to: 'CATEGORY_VERIFIED',
    actor: ACTOR,
    reason: `payment evidence ${assessment.confidence}: ${assessment.reasons.join('; ')}`,
    set: {
      evidence_confidence: assessment.confidence,
      estimated_build_days: estimate.days,
      rejection_reason: null,
    },
    detail: {
      confidence: assessment.confidence,
      strongEvidence: assessment.strong.slice(0, 10),
      supportingEvidence: assessment.supporting.slice(0, 10),
      paidCompetitorCount: assessment.paidCompetitorCount,
      buildDrivers: estimate.drivers,
      penalty: verdict.penalty,
    },
  });

  logger.info('category verified', {
    opportunityId,
    confidence: assessment.confidence,
    paidCompetitors: assessment.paidCompetitorCount,
    estimatedBuildDays: estimate.days,
  });
  return outcomeFrom(opportunityId, assessment, estimate.days, null);
}

/**
 * Verifies up to `limit` opportunities sitting in DISCOVERED.
 * Respects `DEEP_VERIFICATIONS_PER_DAY`; work already done today counts.
 */
export async function verifyCategories(limit: number): Promise<VerificationOutcome[]> {
  const cfg = getConfig();
  if (cfg.killSwitch) {
    logger.warn('KILL_SWITCH is on; verification skipped');
    return [];
  }

  const alreadyToday = await verificationsStartedToday();
  const remaining = Math.max(0, cfg.deepVerificationsPerDay - alreadyToday);
  const cap = Math.max(0, Math.min(limit, remaining));
  if (cap === 0) {
    logger.info('daily deep-verification cap reached', {
      alreadyToday,
      perDay: cfg.deepVerificationsPerDay,
    });
    return [];
  }

  const db = await getDb();
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM opportunities
      WHERE state IN ('DISCOVERED','CATEGORY_VERIFYING')
      ORDER BY created_at
      LIMIT $1`,
    [cap],
  );

  const outcomes: VerificationOutcome[] = [];
  for (const row of rows.rows) {
    try {
      outcomes.push(await verifyOpportunity(row.id));
    } catch (err) {
      logger.error('verification failed for opportunity', { opportunityId: row.id, err: String(err) });
      await recordAudit({
        entityType: 'opportunity',
        entityId: row.id,
        eventType: 'ERROR',
        actor: ACTOR,
        reason: 'verification threw',
        detail: { error: String(err) },
      });
    }
  }
  return outcomes;
}

export {
  assessCategoryEvidence,
  classifyCompetitorEvidence,
  classifyResearchEvidence,
  meetsConfidence,
} from './evidence';
export type { CompetitorFacts, EvidenceAssessment } from './evidence';
export {
  ALL_RULES,
  estimateBuildDays,
  evaluateRejectionRules,
  REJECT_PENALTY_THRESHOLD,
} from './rejection-rules';
export type { RejectionSubject, RejectionVerdict, RuleMatch } from './rejection-rules';
