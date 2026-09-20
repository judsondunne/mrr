/**
 * Campaign evaluation: the only code allowed to advance an opportunity toward
 * READY_TO_BUILD, and the code that kills campaigns that are not working.
 *
 * Every decision here is a comparison between a SQL count and a configured
 * threshold. Nothing in this file asks anything for an opinion.
 *
 * Idempotency: an opportunity that has already reached READY_TO_BUILD or
 * VALIDATION_FAILED is not in the active set, so re-running is a no-op — no
 * second transition, no second audit decision, and (because notification
 * dedupes on the opportunity) no second email.
 */
import { getConfig } from '../../lib/config.js';
import { getDb, toNumber } from '../../lib/db.js';
import { newId } from '../../lib/hash.js';
import { createLogger, errorToFields } from '../../lib/logger.js';
import { recordAudit, transitionOpportunity } from '../../lib/audit.js';
import { canTransitionCampaign, type CampaignState } from '../../lib/state-machine.js';
import type { RejectionReason } from '../../lib/contracts.js';
import {
  getAttemptedCount,
  getCampaignCounts,
  getPriceRejectionCount,
  getSnapshotExtras,
  getWrongPersonCount,
} from './counts.js';
import { evaluateGateAndMint } from './gate.js';
import type { CampaignCounts, GateEvaluation, HealthVerdict } from './types.js';

const logger = createLogger('validation:evaluate');
const ACTOR = 'evaluate_campaigns';

/** Campaign states that are still running and therefore still worth measuring. */
const ACTIVE_CAMPAIGN_STATES: readonly CampaignState[] = [
  'DRAFT',
  'READY',
  'BATCH_1',
  'BATCH_1_REVIEW',
  'BATCH_2',
  'BATCH_2_REVIEW',
  'SCALING',
  'HALTED',
];

/** Opportunity states in which a campaign's numbers can still change the outcome. */
const EVALUABLE_OPPORTUNITY_STATES: readonly string[] = ['CAMPAIGN_READY', 'VALIDATING'];

interface ActiveCampaignRow {
  campaign_id: string;
  campaign_state: string;
  opportunity_id: string;
  opportunity_state: string;
  price_monthly: string | number | null;
}

/**
 * Hard bounce / complaint / unsubscribe rates against config.health.
 * Rates are computed over messages that actually left the system.
 */
export async function checkCampaignHealth(campaignId: string): Promise<HealthVerdict> {
  const cfg = getConfig();
  const [counts, attempted] = await Promise.all([
    getCampaignCounts(campaignId),
    getAttemptedCount(campaignId),
  ]);

  const denominator = attempted > 0 ? attempted : 0;
  const rate = (n: number): number => (denominator > 0 ? n / denominator : 0);

  const hardBounceRate = rate(counts.hardBounced);
  const complaintRate = rate(counts.complained);
  const unsubscribeRate = rate(counts.unsubscribed);

  const reasons: string[] = [];
  if (hardBounceRate > cfg.health.maxHardBounceRate) {
    reasons.push(
      `hard bounce rate ${formatPct(hardBounceRate)} (${counts.hardBounced}/${denominator}) exceeds ${formatPct(cfg.health.maxHardBounceRate)}`,
    );
  }
  if (complaintRate > cfg.health.maxComplaintRate) {
    reasons.push(
      `complaint rate ${formatPct(complaintRate)} (${counts.complained}/${denominator}) exceeds ${formatPct(cfg.health.maxComplaintRate)}`,
    );
  }
  if (unsubscribeRate > cfg.health.maxUnsubscribeRate) {
    reasons.push(
      `unsubscribe rate ${formatPct(unsubscribeRate)} (${counts.unsubscribed}/${denominator}) exceeds ${formatPct(cfg.health.maxUnsubscribeRate)}`,
    );
  }

  return {
    healthy: reasons.length === 0,
    reason: reasons.length === 0 ? null : reasons.join('; '),
    hardBounceRate,
    complaintRate,
    unsubscribeRate,
  };
}

function formatPct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/** Writes one campaign_metrics row. A time series, never an input to the gate. */
export async function snapshotCampaignMetrics(campaignId: string): Promise<void> {
  const [counts, extras] = await Promise.all([
    getCampaignCounts(campaignId),
    getSnapshotExtras(campaignId),
  ]);
  const db = await getDb();
  await db.query(
    `INSERT INTO campaign_metrics
       (id, campaign_id, sent, delivered, bounced, hard_bounced, replied, positive_replies,
        negative_replies, unsubscribed, complained, landing_visits, pilot_signups,
        explicit_price_acceptances, strong_commitments, unique_companies_committed)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      newId('met'),
      campaignId,
      extras.sent,
      counts.delivered,
      extras.bounced,
      counts.hardBounced,
      counts.replied,
      counts.positiveReplies,
      counts.negativeReplies,
      counts.unsubscribed,
      counts.complained,
      extras.landingVisits,
      extras.pilotSignups,
      extras.explicitPriceAcceptances,
      extras.strongCommitmentRows,
      counts.uniqueStrongCommitmentCompanies,
    ],
  );
}

export interface FailureVerdict {
  reason: RejectionReason;
  detail: string;
}

export interface FailureInputs {
  counts: CampaignCounts;
  health: HealthVerdict;
  attempted: number;
  priceRejections: number;
  wrongPerson: number;
  unmetSummary: string;
}

/**
 * Death rules. Deterministic, ordered most-specific first.
 *
 * Sample-size floors are derived from configuration rather than invented here:
 *   - health can kill early once a full first batch has gone out, or the moment
 *     anyone complains (the configured complaint ceiling is zero by default);
 *   - sentiment/price rules need at least `minUniqueStrongCommitments` replies
 *     before a majority means anything;
 *   - a campaign that has spent its whole send allowance without clearing the
 *     gate is finished, whatever the mix of replies.
 */
export function decideFailure(inputs: FailureInputs): FailureVerdict | null {
  const cfg = getConfig();
  const g = cfg.gate;
  const { counts, health, attempted, priceRejections, wrongPerson } = inputs;

  const healthMayKill = attempted >= cfg.initialEmailBatch || counts.complained > 0;
  if (!health.healthy && healthMayKill) {
    if (health.hardBounceRate > cfg.health.maxHardBounceRate) {
      return {
        reason: 'ICP_DISCOVERY_FAILED',
        detail: `prospect quality failure: ${health.reason} — the list is not the ICP we thought it was`,
      };
    }
    return { reason: 'CAMPAIGN_HEALTH_FAILURE', detail: `campaign health failure: ${health.reason}` };
  }

  // Below the standard evaluation volume nothing except a health failure may kill.
  if (counts.delivered < g.minDeliveredBeforeStandardEvaluation) return null;

  const minReplySample = g.minUniqueStrongCommitments;
  const majority = (n: number): boolean => counts.replied > 0 && n * 2 > counts.replied;

  if (
    counts.replied >= minReplySample &&
    majority(priceRejections) &&
    counts.uniquePriceAcceptanceCompanies === 0
  ) {
    return {
      reason: 'PRICE_REJECTION_DOMINANT',
      detail: `${priceRejections} of ${counts.replied} replies rejected the price and no company accepted it`,
    };
  }

  if (
    counts.replied >= minReplySample &&
    majority(counts.negativeReplies) &&
    counts.uniqueStrongCommitmentCompanies === 0
  ) {
    return {
      reason: 'NEGATIVE_SENTIMENT_DOMINANT',
      detail: `${counts.negativeReplies} of ${counts.replied} replies were negative and no company committed`,
    };
  }

  if (counts.replied >= minReplySample && majority(wrongPerson)) {
    return {
      reason: 'ICP_DISCOVERY_FAILED',
      detail: `${wrongPerson} of ${counts.replied} replies said we contacted the wrong kind of business`,
    };
  }

  if (counts.uniqueStrongCommitmentCompanies === 0 && counts.positiveReplies === 0) {
    return {
      reason: 'NO_MEANINGFUL_RESPONSE',
      detail: `${counts.delivered} emails delivered, ${counts.replied} replies, 0 positive replies and 0 companies with any commitment`,
    };
  }

  // The campaign has spent its entire send allowance and still cannot clear the gate.
  if (counts.delivered >= cfg.maxEmailsPerCampaign) {
    return {
      reason: 'NO_MEANINGFUL_RESPONSE',
      detail: `campaign exhausted its ${cfg.maxEmailsPerCampaign}-email allowance (${counts.delivered} delivered) without clearing the gate: ${inputs.unmetSummary}`,
    };
  }

  return null;
}

async function transitionCampaignIfLegal(
  campaignId: string,
  from: string,
  to: CampaignState,
  reason: string,
): Promise<boolean> {
  if (!ACTIVE_CAMPAIGN_STATES.includes(from as CampaignState)) return false;
  if (!canTransitionCampaign(from as CampaignState, to)) {
    logger.info('leaving campaign state alone; edge not legal', { campaignId, from, to });
    return false;
  }
  const db = await getDb();
  const terminal = to === 'COMPLETE' || to === 'FAILED';
  await db.query(
    terminal
      ? `UPDATE campaigns SET state = $2, updated_at = now(), ended_at = now() WHERE id = $1 AND state = $3`
      : `UPDATE campaigns SET state = $2, updated_at = now() WHERE id = $1 AND state = $3`,
    [campaignId, to, from],
  );
  await recordAudit({
    entityType: 'campaign',
    entityId: campaignId,
    eventType: 'STATE_TRANSITION',
    actor: ACTOR,
    fromState: from,
    toState: to,
    reason,
  });
  return true;
}

/**
 * Evaluates every active campaign.
 *
 * Pass  -> VALIDATING -> VALIDATION_STRONG -> READY_TO_BUILD, using the minted
 *          GateToken. Nothing else in the system can perform those two edges.
 * Fail  -> VALIDATION_FAILED with an exact RejectionReason and a detail string.
 * Else  -> left alone; the unmet checks are written to the audit trail so the
 *          dashboard can show WHY THIS IS NOT READY.
 */
export async function evaluateCampaigns(): Promise<GateEvaluation[]> {
  const db = await getDb();
  const cfg = getConfig();

  const activeStates = ACTIVE_CAMPAIGN_STATES.map((_, i) => `$${i + 1}`).join(', ');
  const oppStates = EVALUABLE_OPPORTUNITY_STATES.map(
    (_, i) => `$${i + 1 + ACTIVE_CAMPAIGN_STATES.length}`,
  ).join(', ');

  const res = await db.query<ActiveCampaignRow>(
    `SELECT c.id AS campaign_id, c.state AS campaign_state, c.price_monthly,
            o.id AS opportunity_id, o.state AS opportunity_state
       FROM campaigns c
       JOIN opportunities o ON o.id = c.opportunity_id
      WHERE c.state IN (${activeStates})
        AND o.state IN (${oppStates})
      ORDER BY c.created_at ASC, c.id ASC`,
    [...ACTIVE_CAMPAIGN_STATES, ...EVALUABLE_OPPORTUNITY_STATES],
  );

  const evaluations: GateEvaluation[] = [];

  for (const row of res.rows) {
    try {
      evaluations.push(await evaluateOne(row, cfg.gate.extremeValidation));
    } catch (err) {
      logger.error('campaign evaluation failed', {
        campaignId: row.campaign_id,
        opportunityId: row.opportunity_id,
        ...errorToFields(err),
      });
      await recordAudit({
        entityType: 'campaign',
        entityId: row.campaign_id,
        eventType: 'ERROR',
        actor: ACTOR,
        reason: 'evaluation failed',
        detail: errorToFields(err),
      });
    }
  }

  return evaluations;
}

async function evaluateOne(row: ActiveCampaignRow, extremeValidation: boolean): Promise<GateEvaluation> {
  const campaignId = row.campaign_id;
  const opportunityId = row.opportunity_id;

  await snapshotCampaignMetrics(campaignId);

  const [counts, health, attempted, priceRejections, wrongPerson] = await Promise.all([
    getCampaignCounts(campaignId),
    checkCampaignHealth(campaignId),
    getAttemptedCount(campaignId),
    getPriceRejectionCount(campaignId),
    getWrongPersonCount(campaignId),
  ]);

  // Outreach has been delivered, so the opportunity is genuinely under
  // measurement now. This edge is not gated; only the two states after it are.
  let opportunityState = row.opportunity_state;
  if (opportunityState === 'CAMPAIGN_READY' && counts.delivered > 0) {
    const moved = await transitionOpportunity({
      opportunityId,
      to: 'VALIDATING',
      actor: ACTOR,
      reason: `first outreach delivered (${counts.delivered}); measuring purchase intent`,
      detail: { campaignId, delivered: counts.delivered },
    });
    if (moved.moved) opportunityState = 'VALIDATING';
  }

  const { evaluation, token } = await evaluateGateAndMint(opportunityId);

  await recordAudit({
    entityType: 'opportunity',
    entityId: opportunityId,
    eventType: 'GATE_EVALUATION',
    actor: ACTOR,
    fromState: opportunityState,
    reason: evaluation.passed ? 'gate passed' : `gate not met: ${summarize(evaluation)}`,
    detail: {
      campaignId,
      passed: evaluation.passed,
      extremeValidation,
      counts,
      checks: evaluation.checks,
      unmetChecks: evaluation.unmetChecks.map((c) => c.id),
    },
  });

  if (evaluation.passed && token && opportunityState === 'VALIDATING') {
    await transitionOpportunity({
      opportunityId,
      to: 'VALIDATION_STRONG',
      actor: ACTOR,
      reason: 'every deterministic gate check passed',
      gateToken: token,
      detail: { campaignId, checks: evaluation.checks },
      set: { validation_score: Number(counts.positiveIntentRate.toFixed(3)) },
    });
    await transitionOpportunity({
      opportunityId,
      to: 'READY_TO_BUILD',
      actor: ACTOR,
      reason: `${counts.uniqueStrongCommitmentCompanies} unique companies committed, ${counts.uniquePriceAcceptanceCompanies} accepted the price`,
      gateToken: token,
      detail: { campaignId, checks: evaluation.checks },
    });
    await transitionCampaignIfLegal(
      campaignId,
      row.campaign_state,
      'COMPLETE',
      'opportunity reached READY_TO_BUILD',
    );
    logger.info('opportunity reached READY_TO_BUILD', { opportunityId, campaignId });
    return evaluation;
  }

  if (opportunityState !== 'VALIDATING') return evaluation;

  const failure = decideFailure({
    counts,
    health,
    attempted,
    priceRejections,
    wrongPerson,
    unmetSummary: summarize(evaluation),
  });

  if (failure) {
    await transitionOpportunity({
      opportunityId,
      to: 'VALIDATION_FAILED',
      actor: ACTOR,
      reason: `${failure.reason}: ${failure.detail}`,
      detail: { campaignId, counts, unmetChecks: evaluation.unmetChecks.map((c) => c.id) },
      set: { rejection_reason: failure.reason },
    });
    await recordAudit({
      entityType: 'opportunity',
      entityId: opportunityId,
      eventType: 'REJECTION',
      actor: ACTOR,
      reason: failure.reason,
      detail: { campaignId, detail: failure.detail, counts },
    });
    await transitionCampaignIfLegal(campaignId, row.campaign_state, 'FAILED', failure.reason);
    logger.info('campaign failed validation', {
      opportunityId,
      campaignId,
      reason: failure.reason,
      detail: failure.detail,
    });
  }

  return evaluation;
}

function summarize(evaluation: GateEvaluation): string {
  if (evaluation.unmetChecks.length === 0) return 'all checks met';
  return evaluation.unmetChecks.map((c) => c.detail).join('; ');
}

/** Convenience for the dashboard: the newest metrics row for a campaign. */
export async function getLatestMetrics(campaignId: string): Promise<Record<string, number> | null> {
  const db = await getDb();
  const res = await db.query<Record<string, string | number>>(
    `SELECT * FROM campaign_metrics WHERE campaign_id = $1 ORDER BY captured_at DESC LIMIT 1`,
    [campaignId],
  );
  const row = res.rows[0];
  if (!row) return null;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === 'id' || key === 'campaign_id' || key === 'captured_at') continue;
    out[key] = toNumber(value, 0);
  }
  return out;
}
