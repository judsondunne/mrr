/**
 * PUBLIC API — PRIORITY + CONCURRENCY. Owned by the supervisor agent.
 *
 * Three jobs, all deterministic:
 *   1. priorityFor()        — what outranks what. A prospect waiting on a reply
 *                             always beats discovering idea #5,000.
 *   2. getConcurrencyState/hasCapacityFor — the configured ceilings, counted in
 *                             SQL rather than guessed.
 *   3. rankOpportunities()  — which live opportunity deserves the next dollar.
 *
 * RANKING ALLOCATES RESOURCES. IT NEVER BYPASSES A VALIDATION GATE.
 * The top-ranked opportunity still has to pass all ten deterministic checks in
 * src/pipeline/validation/gate.ts, unchanged, before anything reaches the
 * owner. Nothing in this file imports that gate, mints a token, writes
 * opportunities.state, or feeds a score into a gate threshold — the score only
 * decides who gets looked at first.
 */
import { getConfig } from '../lib/config';
import { getDb, count, toNumber } from '../lib/db';
import { monthStart } from '../lib/cost';
import { createLogger } from '../lib/logger';
import { PRIORITY, type Priority, type WorkKind } from './types';

const logger = createLogger('autonomy:priority');

/**
 * Every work kind's place in the seven-level order.
 *
 * The two ends are load-bearing: PROCESS_INBOUND_REPLY is 1 because a real
 * person is waiting, and DISCOVER_OPPORTUNITIES / EXPAND_QUERIES are 7 because
 * there is always more to discover and it must never crowd out a live
 * conversation.
 */
const PRIORITY_BY_KIND: Record<WorkKind, Priority> = {
  // 1 — a real business wrote to us and is waiting.
  PROCESS_INBOUND_REPLY: PRIORITY.PROTECT_CONVERSATION,

  // 2 — something may already have won; find out and tell the owner.
  EVALUATE_CAMPAIGN: PRIORITY.EVALUATE_POTENTIAL_WINNER,
  REVALIDATE_FEASIBILITY: PRIORITY.EVALUATE_POTENTIAL_WINNER,
  REFRESH_EVIDENCE: PRIORITY.EVALUATE_POTENTIAL_WINNER,
  NOTIFY_VALIDATED: PRIORITY.EVALUATE_POTENTIAL_WINNER,

  // 4 — experiments already in flight. (3 is deliverability maintenance, which
  // the supervisor performs inline rather than queueing.)
  SEND_DUE_MESSAGES: PRIORITY.COMPLETE_ACTIVE_EXPERIMENT,
  SCHEDULE_FOLLOWUPS: PRIORITY.COMPLETE_ACTIVE_EXPERIMENT,

  // 5 — feeding the next experiment.
  DISCOVER_PROSPECTS: PRIORITY.PROSPECT_QUALIFIED_EXPERIMENT,
  QUALIFY_PROSPECTS: PRIORITY.PROSPECT_QUALIFIED_EXPERIMENT,
  PREPARE_CAMPAIGN: PRIORITY.PROSPECT_QUALIFIED_EXPERIMENT,

  // 6 — spending real money on finalists, plus learning from the dead.
  RESEARCH_STAGE: PRIORITY.DEEP_RESEARCH,
  POST_MORTEM: PRIORITY.DEEP_RESEARCH,

  // 7 — exploration, with whatever is left.
  DISCOVER_OPPORTUNITIES: PRIORITY.DISCOVERY_EXPLORATION,
  EXPAND_QUERIES: PRIORITY.DISCOVERY_EXPLORATION,
  EVALUATE_SOURCE: PRIORITY.DISCOVERY_EXPLORATION,
  PROPOSE_HYPOTHESIS: PRIORITY.DISCOVERY_EXPLORATION,
};

export function priorityFor(kind: WorkKind): number {
  return PRIORITY_BY_KIND[kind] ?? PRIORITY.DISCOVERY_EXPLORATION;
}

// --- concurrency ---------------------------------------------------------------

export interface ConcurrencyState {
  researchOpportunities: number;
  deepResearchOpportunities: number;
  activeValidations: number;
  unsentProspects: number;
  monthlyExperiments: number;
}

/** Opportunities that still consume research attention and research budget. */
const RESEARCH_STATES = ['DISCOVERED', 'CATEGORY_VERIFYING', 'CATEGORY_VERIFIED'] as const;

/** Campaign states that mean "this experiment is live". */
const ACTIVE_CAMPAIGN_STATES = [
  'READY',
  'BATCH_1',
  'BATCH_1_REVIEW',
  'BATCH_2',
  'BATCH_2_REVIEW',
  'SCALING',
] as const;

/** Research stage 3+ is where the expensive models start being used. */
const DEEP_RESEARCH_STAGE = 3;

function list(values: readonly string[], from = 1): { sql: string; params: string[] } {
  return {
    sql: values.map((_, i) => `$${i + from}`).join(','),
    params: [...values],
  };
}

export async function getConcurrencyState(): Promise<ConcurrencyState> {
  const research = list(RESEARCH_STATES);
  const active = list(ACTIVE_CAMPAIGN_STATES);

  const [researchOpportunities, deepResearchOpportunities, activeValidations, unsentProspects, monthlyExperiments] =
    await Promise.all([
      count(`SELECT COUNT(*) AS n FROM opportunities WHERE state IN (${research.sql})`, research.params),
      count(
        `SELECT COUNT(*) AS n FROM opportunities
          WHERE state IN (${research.sql}) AND research_stage >= $${research.params.length + 1}`,
        [...research.params, DEEP_RESEARCH_STAGE],
      ),
      count(
        `SELECT COUNT(DISTINCT opportunity_id) AS n FROM campaigns WHERE state IN (${active.sql})`,
        active.params,
      ),
      count(
        `SELECT COUNT(*) AS n FROM prospects p
          WHERE p.status = 'QUALIFIED'
            AND NOT EXISTS (
              SELECT 1 FROM messages m WHERE m.prospect_id = p.id AND m.direction = 'OUTBOUND'
            )`,
      ),
      count(`SELECT COUNT(*) AS n FROM campaigns WHERE created_at >= $1`, [monthStart().toISOString()]),
    ]);

  return {
    researchOpportunities,
    deepResearchOpportunities,
    activeValidations,
    unsentProspects,
    monthlyExperiments,
  };
}

/** False when a configured concurrency ceiling would be exceeded. */
export async function hasCapacityFor(kind: WorkKind): Promise<{ ok: boolean; reason: string | null }> {
  const { concurrency } = getConfig();
  const state = await getConcurrencyState();

  const deny = (reason: string) => ({ ok: false, reason });
  const ok = { ok: true, reason: null };

  switch (kind) {
    // Protecting a live conversation and evaluating a possible winner are
    // never rate-limited: they cost nothing and a person is waiting.
    case 'PROCESS_INBOUND_REPLY':
    case 'EVALUATE_CAMPAIGN':
    case 'REVALIDATE_FEASIBILITY':
    case 'REFRESH_EVIDENCE':
    case 'NOTIFY_VALIDATED':
    case 'SEND_DUE_MESSAGES':
    case 'SCHEDULE_FOLLOWUPS':
    case 'POST_MORTEM':
      return ok;

    case 'DISCOVER_OPPORTUNITIES':
    case 'EXPAND_QUERIES':
    case 'EVALUATE_SOURCE':
    case 'PROPOSE_HYPOTHESIS':
      return state.researchOpportunities >= concurrency.maxResearchOpportunities
        ? deny(
            `max research opportunities reached (${state.researchOpportunities}/${concurrency.maxResearchOpportunities})`,
          )
        : ok;

    case 'RESEARCH_STAGE':
      if (state.deepResearchOpportunities >= concurrency.maxDeepResearchOpportunities) {
        return deny(
          `max deep research reached (${state.deepResearchOpportunities}/${concurrency.maxDeepResearchOpportunities})`,
        );
      }
      return ok;

    case 'DISCOVER_PROSPECTS':
    case 'QUALIFY_PROSPECTS':
      return state.unsentProspects >= concurrency.maxUnsentProspects
        ? deny(`max unsent prospects reached (${state.unsentProspects}/${concurrency.maxUnsentProspects})`)
        : ok;

    case 'PREPARE_CAMPAIGN':
      if (state.activeValidations >= concurrency.maxActiveValidations) {
        return deny(
          `max active validations reached (${state.activeValidations}/${concurrency.maxActiveValidations})`,
        );
      }
      if (state.monthlyExperiments >= concurrency.maxMonthlyExperiments) {
        return deny(
          `max monthly experiments reached (${state.monthlyExperiments}/${concurrency.maxMonthlyExperiments})`,
        );
      }
      return ok;
  }
}

// --- ranking --------------------------------------------------------------------

export interface RankedOpportunity {
  opportunityId: string;
  score: number;
  factors: Record<string, number>;
}

/**
 * Weights for the observed factors below. They sum to 1, so a score is
 * directly comparable across opportunities and always lands in [0,1].
 */
const RANK_WEIGHTS = {
  categoryPaymentConfidence: 0.22,
  observedCommitmentRate: 0.2,
  qualifiedProspects: 0.18,
  priceAcceptance: 0.12,
  contactability: 0.1,
  mvpBuildDays: 0.1,
  expectedMrrPer100: 0.08,
} as const;

const EVIDENCE_CONFIDENCE_SCORE: Record<string, number> = { HIGH: 1, MEDIUM: 0.6, LOW: 0.2, NONE: 0 };

/** States worth spending anything on. Dead and finished ones are skipped. */
const RANKABLE_STATES = [
  'DISCOVERED',
  'CATEGORY_VERIFYING',
  'CATEGORY_VERIFIED',
  'WEDGE_GENERATED',
  'PROSPECTING',
  'CAMPAIGN_READY',
  'VALIDATING',
  'VALIDATION_STRONG',
] as const;

interface RankRow {
  id: string;
  evidence_confidence: string | null;
  estimated_build_days: number | string | null;
  proposed_price_monthly: number | string | null;
  qualified: number | string | null;
  contactable: number | string | null;
  delivered: number | string | null;
  committed: number | string | null;
  price_accepted: number | string | null;
}

/**
 * Scores every live opportunity on observed/verified facts only — counted
 * rows, never a model's opinion — and persists the score to
 * opportunities.rank_score so the dashboard and the supervisor agree.
 *
 * Again, and deliberately repeated next to the code: this ORDERS work. It does
 * not admit anything. A rank of 1.0 with zero commitments still fails the gate.
 */
export async function rankOpportunities(limit: number): Promise<RankedOpportunity[]> {
  const cfg = getConfig();
  const states = list(RANKABLE_STATES);
  const db = await getDb();

  const res = await db.query<RankRow>(
    `SELECT o.id,
            o.evidence_confidence,
            o.estimated_build_days,
            o.proposed_price_monthly,
            (SELECT COUNT(*) FROM prospects p
              WHERE p.opportunity_id = o.id
                AND p.status IN ('QUALIFIED','CONTACTED','REPLIED','COMMITTED')) AS qualified,
            (SELECT COUNT(*) FROM prospects p
              WHERE p.opportunity_id = o.id
                AND p.contact_email IS NOT NULL
                AND p.email_is_public
                AND p.status IN ('QUALIFIED','CONTACTED','REPLIED','COMMITTED')) AS contactable,
            (SELECT COUNT(*) FROM messages m
               JOIN campaigns c ON c.id = m.campaign_id
              WHERE c.opportunity_id = o.id
                AND m.direction = 'OUTBOUND'
                AND m.delivered_at IS NOT NULL) AS delivered,
            (SELECT COUNT(DISTINCT cm.company_key) FROM commitments cm
               JOIN campaigns c ON c.id = cm.campaign_id
              WHERE c.opportunity_id = o.id) AS committed,
            (SELECT COUNT(DISTINCT cm.company_key) FROM commitments cm
               JOIN campaigns c ON c.id = cm.campaign_id
              WHERE c.opportunity_id = o.id
                AND cm.type = 'EXPLICIT_PRICE_ACCEPTANCE') AS price_accepted
       FROM opportunities o
      WHERE o.state IN (${states.sql})`,
    states.params,
  );

  const maxBuildDays = Math.max(1, cfg.gate.maxMvpBuildDays);
  // The MRR/100 a campaign that only just clears the gate would produce.
  // A normaliser derived from existing thresholds — it never changes one.
  const gateReferenceCommitmentRate =
    cfg.gate.minUniqueStrongCommitments / Math.max(1, cfg.gate.minDeliveredBeforeStandardEvaluation);

  const ranked: RankedOpportunity[] = res.rows.map((row) => {
    const qualified = toNumber(row.qualified, 0);
    const contactable = toNumber(row.contactable, 0);
    const delivered = toNumber(row.delivered, 0);
    const committed = toNumber(row.committed, 0);
    const priceAccepted = toNumber(row.price_accepted, 0);
    const price = toNumber(row.proposed_price_monthly, 0);
    const buildDays = row.estimated_build_days === null ? null : toNumber(row.estimated_build_days, 0);

    const commitmentRate = delivered > 0 ? committed / delivered : 0;
    const mrrPer100 = price > 0 ? commitmentRate * 100 * price : 0;
    const referenceMrrPer100 = price > 0 ? gateReferenceCommitmentRate * 100 * price : 0;

    const factors: Record<string, number> = {
      categoryPaymentConfidence: EVIDENCE_CONFIDENCE_SCORE[row.evidence_confidence ?? 'NONE'] ?? 0,
      observedCommitmentRate: clamp01(commitmentRate / Math.max(1e-9, gateReferenceCommitmentRate)),
      qualifiedProspects: clamp01(qualified / Math.max(1, cfg.gate.minQualifiedProspects)),
      priceAcceptance: clamp01(priceAccepted / Math.max(1, cfg.gate.minUniquePriceAcceptances)),
      contactability: qualified > 0 ? clamp01(contactable / qualified) : 0,
      mvpBuildDays: buildDaysScore(buildDays, maxBuildDays),
      expectedMrrPer100: referenceMrrPer100 > 0 ? clamp01(mrrPer100 / referenceMrrPer100) : 0,
    };

    let score = 0;
    for (const [key, weight] of Object.entries(RANK_WEIGHTS)) {
      score += weight * (factors[key] ?? 0);
    }

    return { opportunityId: row.id, score: round5(clamp01(score)), factors };
  });

  ranked.sort((a, b) => b.score - a.score || a.opportunityId.localeCompare(b.opportunityId));

  for (const item of ranked) {
    // Only the score column. State belongs to the state machine alone.
    await db.query(`UPDATE opportunities SET rank_score = $2 WHERE id = $1`, [
      item.opportunityId,
      item.score,
    ]);
  }

  logger.info('opportunities ranked', { ranked: ranked.length, returned: Math.min(ranked.length, Math.max(0, limit)) });
  return limit >= 0 ? ranked.slice(0, limit) : ranked;
}

/**
 * An MVP that cannot be built inside the configured window is worth nothing to
 * rank highly — the gate would reject it anyway. Unknown is mildly pessimistic.
 */
function buildDaysScore(days: number | null, maxBuildDays: number): number {
  if (days === null || !Number.isFinite(days)) return 0.4;
  if (days > maxBuildDays) return 0;
  return clamp01(1 - Math.max(0, days - 1) / (2 * maxBuildDays));
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function round5(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}
