/**
 * Failure memory and success patterns.
 *
 * A system that forgets re-tests "generic back-in-stock alerts for Shopify"
 * every few weeks, spends the same money, and gets the same silence. Failure
 * memory is the cheapest possible fix: store a normalized token set for every
 * dead idea and refuse structurally identical retries before a single call is
 * made.
 *
 * It is deliberately possible to escape. A retry with a MATERIALLY different
 * ICP, price, wedge type or distribution channel is a different experiment and
 * is allowed through — otherwise one bad campaign would permanently close a
 * category that was only mis-aimed.
 *
 * Success patterns do the mirror job: bias discovery toward what has actually
 * produced commitments. The bias is capped below 1 on purpose, because the
 * exploration reserve has to survive contact with a winner.
 */
import { getConfig } from '../../lib/config';
import { count, getDb, toNumber } from '../../lib/db';
import { newId } from '../../lib/hash';
import { createLogger } from '../../lib/logger';
import { AppError } from '../../lib/errors';
import { jaccard, normalizeTokens, parseJsonColumn, relativePriceGap } from './util';

const logger = createLogger('strategy:memory');

export interface FailureRecord {
  id: string;
  category: string;
  icp: string | null;
  wedge: string | null;
  priceMonthly: number | null;
  reasonFailed: string;
  sampleSize: number;
  lesson: string | null;
  avoidCategory: boolean;
}

interface FailureRow {
  id: string;
  ecosystem: string | null;
  category: string;
  icp: string | null;
  wedge: string | null;
  wedge_type: string | null;
  price_monthly: string | number | null;
  reason_failed: string;
  sample_size: string | number;
  similarity_tokens: unknown;
  lesson: string | null;
  avoid_category: boolean;
}

const FAILURE_COLUMNS =
  'id, ecosystem, category, icp, wedge, wedge_type, price_monthly, reason_failed, sample_size, similarity_tokens, lesson, avoid_category';

function toFailure(row: FailureRow): FailureRecord {
  return {
    id: row.id,
    category: row.category,
    icp: row.icp,
    wedge: row.wedge,
    priceMonthly: row.price_monthly === null ? null : toNumber(row.price_monthly),
    reasonFailed: row.reason_failed,
    sampleSize: toNumber(row.sample_size),
    lesson: row.lesson,
    avoidCategory: row.avoid_category === true,
  };
}

// --- material-change classifiers ---------------------------------------------

/**
 * A retry is only a new experiment if something that plausibly drives the
 * result changed. These two tables are intentionally small and literal; they
 * are a switch, not an understanding of language.
 */
const WEDGE_TYPE_KEYWORDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['notification', ['notify', 'notification', 'alert', 'reminder', 'back-in-stock', 'restock']],
  ['sync', ['sync', 'synchronise', 'synchronize', 'integration', 'connector', 'import', 'export']],
  ['reporting', ['report', 'reporting', 'analytic', 'dashboard', 'insight', 'forecast']],
  ['enforcement', ['enforce', 'minimum', 'restrict', 'block', 'limit', 'rule', 'validation', 'compliance']],
  ['pricing', ['pricing', 'price', 'discount', 'quote', 'margin', 'tier']],
  ['billing', ['billing', 'invoice', 'subscription', 'dunning', 'payment', 'refund']],
  ['inventory', ['inventory', 'stock', 'replenish', 'warehouse', 'fulfilment', 'fulfillment']],
  ['scheduling', ['schedule', 'scheduling', 'booking', 'appointment', 'calendar', 'shift']],
  ['support', ['support', 'ticket', 'helpdesk', 'faq', 'chat']],
];

const CHANNEL_KEYWORDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['email', ['email', 'outbound', 'cold', 'inbox', 'newsletter']],
  ['marketplace', ['marketplace', 'appstore', 'app-store', 'listing', 'directory']],
  ['community', ['community', 'forum', 'subreddit', 'reddit', 'slack', 'discord', 'group']],
  ['partner', ['partner', 'agency', 'reseller', 'referral', 'affiliate']],
  ['search', ['seo', 'search', 'content', 'blog', 'organic']],
  ['ads', ['ads', 'advert', 'advertising', 'ppc', 'campaign-ads']],
];

function classify(
  table: ReadonlyArray<readonly [string, readonly string[]]>,
  text: string | null | undefined,
): string | null {
  if (!text) return null;
  const haystack = text.toLowerCase();
  for (const [label, keywords] of table) {
    if (keywords.some((k) => haystack.includes(k))) return label;
  }
  return null;
}

export function classifyWedgeType(text: string | null | undefined): string | null {
  return classify(WEDGE_TYPE_KEYWORDS, text);
}

export function classifyChannel(text: string | null | undefined): string | null {
  return classify(CHANNEL_KEYWORDS, text);
}

/** Below this, two ICP descriptions are describing different businesses. */
const SAME_ICP_THRESHOLD = 0.5;

/** A price that moves by half is a different offer, not the same one nudged. */
export const MATERIAL_PRICE_GAP = 0.5;

export interface MaterialChangeVerdict {
  material: boolean;
  reason: string | null;
}

export interface FailureCandidate {
  category: string;
  icp?: string | null;
  wedge?: string | null;
  priceMonthly?: number | null;
}

/**
 * Does this candidate differ from a past failure in a way that makes it worth
 * paying for again? Deterministic, and deliberately generous: the cost of one
 * extra experiment is far lower than the cost of permanently blacklisting a
 * category that failed for a fixable reason.
 */
export function materialChangeAgainst(
  candidate: FailureCandidate,
  failure: { icp: string | null; wedge: string | null; wedgeType?: string | null; priceMonthly: number | null },
): MaterialChangeVerdict {
  const candidateIcp = normalizeTokens(candidate.icp);
  const failureIcp = normalizeTokens(failure.icp);
  if (candidateIcp.length > 0 && failureIcp.length > 0) {
    const overlap = jaccard(candidateIcp, failureIcp);
    if (overlap < SAME_ICP_THRESHOLD) {
      return { material: true, reason: `different ICP ("${candidate.icp}" vs "${failure.icp}")` };
    }
  }

  const gap = relativePriceGap(candidate.priceMonthly ?? null, failure.priceMonthly);
  if (gap !== null && gap >= MATERIAL_PRICE_GAP) {
    return {
      material: true,
      reason: `price differs by ${Math.round(gap * 100)}% ($${candidate.priceMonthly} vs $${failure.priceMonthly})`,
    };
  }

  const candidateWedgeType = classifyWedgeType(candidate.wedge);
  const failureWedgeType = failure.wedgeType ?? classifyWedgeType(failure.wedge);
  if (candidateWedgeType && failureWedgeType && candidateWedgeType !== failureWedgeType) {
    return { material: true, reason: `different wedge type (${candidateWedgeType} vs ${failureWedgeType})` };
  }

  const candidateChannel = classifyChannel(candidate.wedge);
  const failureChannel = classifyChannel(failure.wedge);
  if (candidateChannel && failureChannel && candidateChannel !== failureChannel) {
    return { material: true, reason: `different distribution channel (${candidateChannel} vs ${failureChannel})` };
  }

  return { material: false, reason: null };
}

/** What would have to change before this idea is worth testing again. */
function retryConditions(priceMonthly: number | null): string {
  const cheaper = priceMonthly === null ? null : Math.round(priceMonthly * (1 - MATERIAL_PRICE_GAP));
  const dearer = priceMonthly === null ? null : Math.round(priceMonthly * (1 + MATERIAL_PRICE_GAP));
  return [
    'a materially different ICP',
    priceMonthly === null
      ? `a price at least ${MATERIAL_PRICE_GAP * 100}% away from the one tested`
      : `a price at or below $${cheaper} or at or above $${dearer}`,
    'a different wedge type',
    'a different distribution channel',
  ].join('; ');
}

// --- failure memory ------------------------------------------------------------

export async function recordFailure(params: {
  opportunityId: string | null;
  ecosystem: string | null;
  category: string;
  icp: string | null;
  wedge: string | null;
  wedgeType: string | null;
  priceMonthly: number | null;
  reasonFailed: string;
  sampleSize: number;
  campaignEvidence?: Record<string, unknown>;
  lesson?: string;
}): Promise<FailureRecord> {
  const category = params.category.trim();
  if (category === '') {
    throw new AppError('a failure record needs a category to be searchable', 'FAILURE_INVALID');
  }
  const tokens = normalizeTokens(category, params.icp, params.wedge);
  const id = newId('fail');
  const db = await getDb();
  const res = await db.query<FailureRow>(
    `INSERT INTO failure_memory
       (id, opportunity_id, ecosystem, category, icp, wedge, wedge_type, price_monthly,
        reason_failed, sample_size, campaign_evidence_json, similarity_tokens, lesson,
        avoid_category, retry_allowed_if)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,false,$14)
     RETURNING ${FAILURE_COLUMNS}`,
    [
      id,
      params.opportunityId,
      params.ecosystem,
      category,
      params.icp,
      params.wedge,
      params.wedgeType ?? classifyWedgeType(params.wedge),
      params.priceMonthly,
      params.reasonFailed,
      Math.max(0, Math.round(params.sampleSize)),
      JSON.stringify(params.campaignEvidence ?? {}),
      JSON.stringify(tokens),
      params.lesson ?? null,
      retryConditions(params.priceMonthly),
    ],
  );
  const row = res.rows[0];
  if (!row) throw new AppError('failed to write failure memory', 'FAILURE_WRITE_FAILED');
  logger.info('failure recorded', { failureId: id, category, tokens: tokens.length });
  return toFailure(row);
}

/** Most recent failures first. The cap keeps the scan bounded as memory grows. */
const FAILURE_SCAN_LIMIT = 500;

/**
 * Structural similarity against past failures. Blocks rediscovering the same
 * dead idea weekly unless the new hypothesis contains a MATERIAL change
 * (different ICP, very different price, different wedge, different channel).
 */
export async function findSimilarFailure(candidate: {
  category: string;
  icp?: string | null;
  wedge?: string | null;
  priceMonthly?: number | null;
}): Promise<{ failure: FailureRecord; similarity: number } | null> {
  const threshold = getConfig().learning.failureSimilarityThreshold;
  const candidateTokens = normalizeTokens(candidate.category, candidate.icp, candidate.wedge);
  if (candidateTokens.length === 0) return null;

  const db = await getDb();
  const res = await db.query<FailureRow>(
    `SELECT ${FAILURE_COLUMNS} FROM failure_memory ORDER BY created_at DESC LIMIT ${FAILURE_SCAN_LIMIT}`,
  );

  let best: { failure: FailureRecord; similarity: number } | null = null;
  for (const row of res.rows) {
    const tokens = parseJsonColumn<string[]>(row.similarity_tokens, []);
    const similarity = jaccard(
      candidateTokens,
      tokens.length > 0 ? tokens : normalizeTokens(row.category, row.icp, row.wedge),
    );
    if (similarity < threshold) continue;

    const verdict = materialChangeAgainst(candidate, {
      icp: row.icp,
      wedge: row.wedge,
      wedgeType: row.wedge_type,
      priceMonthly: row.price_monthly === null ? null : toNumber(row.price_monthly),
    });
    if (verdict.material) {
      logger.debug('similar failure defeated by a material change', {
        failureId: row.id,
        similarity,
        change: verdict.reason,
      });
      continue;
    }
    if (!best || similarity > best.similarity) {
      best = { failure: toFailure(row), similarity };
    }
  }
  return best;
}

/** Categories a post-mortem concluded should not be re-entered at all. */
export async function isAvoidedCategory(category: string): Promise<FailureRecord | null> {
  const db = await getDb();
  const res = await db.query<FailureRow>(
    `SELECT ${FAILURE_COLUMNS} FROM failure_memory
      WHERE avoid_category AND lower(category) = lower($1)
      ORDER BY created_at DESC LIMIT 1`,
    [category.trim()],
  );
  const row = res.rows[0];
  return row ? toFailure(row) : null;
}

// --- success patterns -----------------------------------------------------------

interface OpportunityRow {
  id: string;
  name: string;
  ecosystem: string;
  category: string;
  description: string;
  state: string;
  proposed_wedge: string | null;
  target_customer: string | null;
  proposed_price_monthly: string | number | null;
  evidence_confidence: string | null;
  rejection_reason: string | null;
}

const OPPORTUNITY_COLUMNS =
  'id, name, ecosystem, category, description, state, proposed_wedge, target_customer, proposed_price_monthly, evidence_confidence, rejection_reason';

async function loadOpportunity(opportunityId: string): Promise<OpportunityRow> {
  const db = await getDb();
  const res = await db.query<OpportunityRow>(
    `SELECT ${OPPORTUNITY_COLUMNS} FROM opportunities WHERE id = $1`,
    [opportunityId],
  );
  const row = res.rows[0];
  if (!row) throw new AppError(`opportunity ${opportunityId} does not exist`, 'OPPORTUNITY_MISSING');
  return row;
}

interface CampaignEvidence {
  campaigns: number;
  qualifiedProspects: number;
  delivered: number;
  replies: number;
  negativeReplies: number;
  committedCompanies: number;
  commitmentsByType: Record<string, number>;
  competitors: number;
  reviews: number;
  priceMonthly: number | null;
}

/** Everything measured about an opportunity, read straight out of the tables. */
async function collectEvidence(opportunityId: string, fallbackPrice: number | null): Promise<CampaignEvidence> {
  const db = await getDb();
  const [campaigns, qualifiedProspects, delivered, replies, negativeReplies, committedCompanies, competitors, reviews] =
    await Promise.all([
      count('SELECT COUNT(*) AS n FROM campaigns WHERE opportunity_id = $1', [opportunityId]),
      count(
        `SELECT COUNT(*) AS n FROM prospects
          WHERE opportunity_id = $1 AND status IN ('QUALIFIED','CONTACTED','REPLIED','COMMITTED')`,
        [opportunityId],
      ),
      count(
        `SELECT COUNT(*) AS n FROM messages m JOIN campaigns c ON c.id = m.campaign_id
          WHERE c.opportunity_id = $1 AND m.direction = 'OUTBOUND' AND m.delivered_at IS NOT NULL`,
        [opportunityId],
      ),
      count(
        `SELECT COUNT(*) AS n FROM messages m JOIN campaigns c ON c.id = m.campaign_id
          WHERE c.opportunity_id = $1 AND m.direction = 'INBOUND'`,
        [opportunityId],
      ),
      count(
        `SELECT COUNT(*) AS n FROM messages m JOIN campaigns c ON c.id = m.campaign_id
          WHERE c.opportunity_id = $1 AND m.direction = 'INBOUND'
            AND m.classification IN ('NOT_INTERESTED','UNSUBSCRIBE')`,
        [opportunityId],
      ),
      count(
        `SELECT COUNT(DISTINCT cm.company_key) AS n FROM commitments cm
           JOIN campaigns c ON c.id = cm.campaign_id
          WHERE c.opportunity_id = $1`,
        [opportunityId],
      ),
      count('SELECT COUNT(*) AS n FROM competitors WHERE opportunity_id = $1', [opportunityId]),
      count(
        `SELECT COUNT(*) AS n FROM reviews r JOIN competitors k ON k.id = r.competitor_id
          WHERE k.opportunity_id = $1`,
        [opportunityId],
      ),
    ]);

  const byType = await db.query<{ type: string; n: string | number }>(
    `SELECT cm.type AS type, COUNT(DISTINCT cm.company_key) AS n
       FROM commitments cm JOIN campaigns c ON c.id = cm.campaign_id
      WHERE c.opportunity_id = $1
      GROUP BY cm.type`,
    [opportunityId],
  );
  const commitmentsByType: Record<string, number> = {};
  for (const row of byType.rows) commitmentsByType[row.type] = toNumber(row.n);

  const priceRow = await db.query<{ price_monthly: string | number | null }>(
    'SELECT price_monthly FROM campaigns WHERE opportunity_id = $1 ORDER BY created_at DESC LIMIT 1',
    [opportunityId],
  );
  const campaignPrice = priceRow.rows[0]?.price_monthly ?? null;

  return {
    campaigns,
    qualifiedProspects,
    delivered,
    replies,
    negativeReplies,
    committedCompanies,
    commitmentsByType,
    competitors,
    reviews,
    priceMonthly: campaignPrice === null ? fallbackPrice : toNumber(campaignPrice),
  };
}

export async function recordSuccessPattern(opportunityId: string): Promise<void> {
  const opportunity = await loadOpportunity(opportunityId);
  const price =
    opportunity.proposed_price_monthly === null ? null : toNumber(opportunity.proposed_price_monthly);
  const evidence = await collectEvidence(opportunityId, price);

  // A winner is a thing companies committed to. Nothing else qualifies — not a
  // high score, not a confident summary, not an encouraging reply.
  if (evidence.committedCompanies < 1) {
    logger.warn('refusing to record a success pattern with no measured commitments', {
      opportunityId,
      state: opportunity.state,
    });
    return;
  }

  const tokens = normalizeTokens(
    opportunity.ecosystem,
    opportunity.category,
    opportunity.target_customer,
    opportunity.proposed_wedge,
  );
  const commitmentRate =
    evidence.delivered > 0 ? evidence.committedCompanies / evidence.delivered : null;

  const db = await getDb();
  await db.query(
    `INSERT INTO success_patterns
       (id, opportunity_id, ecosystem, category, icp, wedge_type, price_monthly,
        contact_role, source, pattern_tokens, commitment_rate, evidence_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      newId('win'),
      opportunityId,
      opportunity.ecosystem,
      opportunity.category,
      opportunity.target_customer,
      classifyWedgeType(opportunity.proposed_wedge),
      evidence.priceMonthly,
      null,
      null,
      JSON.stringify(tokens),
      commitmentRate,
      JSON.stringify({
        delivered: evidence.delivered,
        replies: evidence.replies,
        committedCompanies: evidence.committedCompanies,
        commitmentsByType: evidence.commitmentsByType,
        state: opportunity.state,
      }),
    ],
  );
  logger.info('success pattern recorded', {
    opportunityId,
    tokens: tokens.length,
    committedCompanies: evidence.committedCompanies,
  });
}

/** How many tokens discovery is allowed to lean on. Enough to steer, not enough to tunnel. */
const MAX_BIAS_TOKENS = 40;

/** Tokens from past winners, used to bias discovery toward adjacent patterns. */
export async function getSuccessBias(): Promise<{ tokens: string[]; weight: number }> {
  const db = await getDb();
  const res = await db.query<{ pattern_tokens: unknown }>(
    'SELECT pattern_tokens FROM success_patterns ORDER BY created_at DESC LIMIT 100',
  );
  if (res.rows.length === 0) return { tokens: [], weight: 0 };

  const frequency = new Map<string, number>();
  for (const row of res.rows) {
    for (const token of parseJsonColumn<string[]>(row.pattern_tokens, [])) {
      frequency.set(token, (frequency.get(token) ?? 0) + 1);
    }
  }
  const tokens = [...frequency.entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))
    .slice(0, MAX_BIAS_TOKENS)
    .map(([token]) => token);

  // Hard ceiling below 1: the exploration reserve must survive success, or the
  // system spends the rest of its life in the first niche that worked.
  const cap = 1 - getConfig().learning.explorationRatio;
  const n = res.rows.length;
  const weight = Math.min(cap, n / (n + 5));
  return { tokens, weight };
}

// --- post mortem ------------------------------------------------------------------

/** Reasons that condemn the whole category, not just this attempt at it. */
const CATEGORY_KILLING_REASONS: ReadonlySet<string> = new Set([
  'NO_PAYMENT_EVIDENCE',
  'ONLY_WEAK_EVIDENCE',
  'DOMINATED_BY_FREE_NATIVE_FEATURE',
  'NEGATIVE_SENTIMENT_DOMINANT',
]);

function describeCommitments(byType: Record<string, number>): string {
  const entries = Object.entries(byType).filter(([, n]) => n > 0);
  if (entries.length === 0) return 'none';
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `${type} x${n} unique ${n === 1 ? 'company' : 'companies'}`)
    .join(', ');
}

function deriveFailureReason(opportunity: OpportunityRow, evidence: CampaignEvidence, minDelivered: number): string {
  if (opportunity.rejection_reason) return opportunity.rejection_reason;
  if (evidence.campaigns === 0) return 'NEVER_REACHED_A_CAMPAIGN';
  if (evidence.delivered === 0) return 'NOTHING_WAS_DELIVERED';
  if (evidence.committedCompanies === 0) {
    return evidence.delivered >= minDelivered ? 'NO_MEANINGFUL_RESPONSE' : 'INSUFFICIENT_SAMPLE';
  }
  return 'BELOW_GATE_THRESHOLDS';
}

/**
 * Written for every failed experiment. The owner never receives these.
 *
 * That is the whole point: the machine writes down what it learned so the next
 * decision is better, and the person is not asked to read another report about
 * an idea that did not work. Nothing in this function touches
 * `owner_notifications`.
 */
export async function writePostMortem(opportunityId: string): Promise<{ id: string; lesson: string }> {
  const cfg = getConfig();
  const opportunity = await loadOpportunity(opportunityId);
  const proposedPrice =
    opportunity.proposed_price_monthly === null ? null : toNumber(opportunity.proposed_price_monthly);
  const evidence = await collectEvidence(opportunityId, proposedPrice);
  const minDelivered = cfg.gate.minDeliveredBeforeStandardEvaluation;
  const reasonFailed = deriveFailureReason(opportunity, evidence, minDelivered);

  const price = evidence.priceMonthly;
  const wedgeType = classifyWedgeType(opportunity.proposed_wedge);
  const avoidCategory =
    CATEGORY_KILLING_REASONS.has(reasonFailed) ||
    (evidence.delivered >= minDelivered && evidence.committedCompanies === 0);

  const lesson = [
    `POST-MORTEM — ${opportunity.name} (${opportunity.ecosystem}/${opportunity.category})`,
    '',
    `WHY IT WAS TESTED: ${opportunity.description || 'no description recorded'}. ` +
      `Category evidence confidence at the time: ${opportunity.evidence_confidence ?? 'none recorded'}.`,
    `EVIDENCE THAT EXISTED: ${evidence.competitors} competitor(s) examined, ` +
      `${evidence.reviews} review(s) extracted, ${evidence.qualifiedProspects} qualified prospect(s) found.`,
    `WHAT WAS TRIED: wedge "${opportunity.proposed_wedge ?? 'none recorded'}"` +
      `${wedgeType ? ` (${wedgeType} type)` : ''} aimed at "${opportunity.target_customer ?? 'no ICP recorded'}"` +
      `${price === null ? ' with no price' : ` at $${price}/month`} across ${evidence.campaigns} campaign(s).`,
    `SAMPLE SIZE: ${evidence.delivered} delivered message(s); the standard evaluation floor is ${minDelivered}.`,
    `RESULTS: ${evidence.replies} repl(y/ies) (${evidence.negativeReplies} negative), ` +
      `${evidence.committedCompanies} unique committed compan(y/ies) — ${describeCommitments(evidence.commitmentsByType)}.`,
    `WHY IT FAILED: ${reasonFailed}.` +
      (evidence.delivered < minDelivered && evidence.delivered > 0
        ? ' Note the sample never reached the evaluation floor, so this is weak evidence about the idea and strong evidence about the execution.'
        : ''),
    `WHAT WAS LEARNED: ${learning(opportunity, evidence, minDelivered)}`,
    `AVOID THE CATEGORY: ${avoidCategory ? 'yes' : 'no'} — ${
      avoidCategory
        ? 'the category itself did not respond at a fair sample size, or its evidence never supported payment.'
        : 'the failure is attributable to this attempt, not to the category.'
    }`,
    `WORTH RETESTING ONLY WITH: ${retryConditions(price)}.`,
  ].join('\n');

  const db = await getDb();
  const existing = await db.query<{ id: string }>(
    'SELECT id FROM failure_memory WHERE opportunity_id = $1 ORDER BY created_at DESC LIMIT 1',
    [opportunityId],
  );
  const campaignEvidence: Record<string, unknown> = { ...evidence };

  const existingId = existing.rows[0]?.id;
  if (existingId) {
    await db.query(
      `UPDATE failure_memory
          SET lesson = $2,
              sample_size = $3,
              campaign_evidence_json = $4,
              avoid_category = $5,
              retry_allowed_if = $6
        WHERE id = $1`,
      [existingId, lesson, evidence.delivered, JSON.stringify(campaignEvidence), avoidCategory, retryConditions(price)],
    );
    logger.info('post-mortem written', { opportunityId, failureId: existingId, avoidCategory });
    return { id: existingId, lesson };
  }

  const record = await recordFailure({
    opportunityId,
    ecosystem: opportunity.ecosystem,
    category: opportunity.category,
    icp: opportunity.target_customer,
    wedge: opportunity.proposed_wedge,
    wedgeType,
    priceMonthly: price,
    reasonFailed,
    sampleSize: evidence.delivered,
    campaignEvidence,
    lesson,
  });
  if (avoidCategory) {
    await db.query('UPDATE failure_memory SET avoid_category = true WHERE id = $1', [record.id]);
  }
  logger.info('post-mortem written', { opportunityId, failureId: record.id, avoidCategory });
  return { id: record.id, lesson };
}

function learning(opportunity: OpportunityRow, evidence: CampaignEvidence, minDelivered: number): string {
  if (evidence.campaigns === 0) {
    return 'the idea died before contact with a real prospect, so it says nothing about demand — only about prospectability or research cost.';
  }
  if (evidence.delivered < minDelivered) {
    return `only ${evidence.delivered} of the ${minDelivered} messages needed for a fair read were delivered; fix reachability before concluding anything about ${opportunity.category}.`;
  }
  if (evidence.replies === 0) {
    return 'a full batch produced zero replies, which points at the offer or the list rather than at the price.';
  }
  if (evidence.committedCompanies === 0) {
    return `${evidence.replies} businesses engaged but none committed: interest existed, willingness to pay for this specific wedge did not.`;
  }
  return `${evidence.committedCompanies} companies committed but the deterministic gate was still not met; the wedge has a pulse and the aim or the sample was wrong.`;
}
