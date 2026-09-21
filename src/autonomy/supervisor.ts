/**
 * PUBLIC API — THE SUPERVISOR. Owned by the supervisor agent.
 *
 * The brain. Runs frequently, decides what should happen next, and enqueues it
 * idempotently. The owner never invokes work directly.
 *
 * What this layer is:  deterministic scheduling. SQL counts, config ceilings,
 *                      a fixed priority order, and idempotency keys.
 * What it is NOT:      an LLM call site, a state writer, a gate, or a place
 *                      where a budget or a threshold can be widened. It only
 *                      decides WHEN existing jobs run.
 *
 * Every tick is safe to run concurrently and frequently: work is keyed by
 * `${kind}:${scope}:${bucket}`, so two ticks in the same window enqueue the
 * same row once, and the queue's unique index settles any race.
 */
import { getConfig, isShadowMode } from '../lib/config';
import { getDb, one, toNumber } from '../lib/db';
import { createLogger, errorToFields } from '../lib/logger';
import { recordAudit } from '../lib/audit';
import { remainingDailyEmailQuota } from '../lib/cost';
import { DEAD_STATES, isOpportunityState } from '../lib/state-machine';
import { runJob, type JobName } from '../jobs/registry';
import { flushPendingAutoReplies } from '../pipeline/outreach/index';
import { readyToBuildDedupeKey, notifyOwner } from '../pipeline/notify/index';

import { PRIORITY, type SpendPhase, type Subsystem, type WorkItem, type WorkKind } from './types';
import { hasCapacityFor, priorityFor, rankOpportunities, getConcurrencyState } from './priority';
import { availableForPhase, expectedInformationValue, getBudgetReport, type BudgetReport } from './budget';
import { autoStart } from './autostart';
import { runWatchdog } from './watchdog';
import { getRuntimeState, getSubsystemHealth, isOperational, recordHeartbeat } from './runtime';
import {
  archiveDeadLetter,
  claimNext,
  completeWork,
  enqueue,
  failWork,
  listDeadLetter,
  queueDepth,
  reviveDeadLetter,
} from './queue';
import { evaluateDeliverability, pauseSending, resumeSendingIfRecovered } from './deliverability';

const logger = createLogger('autonomy:supervisor');

export interface SupervisorDecision {
  kind: string;
  priority: number;
  reason: string;
  opportunityId: string | null;
  idempotencyKey: string;
}

export interface SupervisorReport {
  runtimeState: string;
  decisions: SupervisorDecision[];
  enqueued: number;
  skipped: Array<{ reason: string; count: number }>;
  executed: number;
  budgetRemainingUsd: number;
  outreachCapacityRemaining: number;
  deadLetterReviewed: number;
}

/** How much work one tick executes inline unless the caller says otherwise. */
const DEFAULT_MAX_WORK_ITEMS = 5;

/** How many candidates each decision step will look at in one tick. */
const SCAN_LIMIT = 25;

/**
 * Which sub-budget each kind of work draws on, and a deterministic estimate of
 * what one unit of it costs. The estimates only decide whether to SCHEDULE the
 * work; the real spend is metered and capped by lib/cost at call time.
 */
const PHASE_BY_KIND: Record<WorkKind, SpendPhase> = {
  PROCESS_INBOUND_REPLY: 'REPLY',
  SEND_DUE_MESSAGES: 'PROSPECTING',
  SCHEDULE_FOLLOWUPS: 'PROSPECTING',
  EVALUATE_CAMPAIGN: 'FINAL_ANALYSIS',
  REVALIDATE_FEASIBILITY: 'FINAL_ANALYSIS',
  REFRESH_EVIDENCE: 'FINAL_ANALYSIS',
  NOTIFY_VALIDATED: 'FINAL_ANALYSIS',
  QUALIFY_PROSPECTS: 'PROSPECTING',
  DISCOVER_PROSPECTS: 'PROSPECTING',
  PREPARE_CAMPAIGN: 'PROSPECTING',
  RESEARCH_STAGE: 'RESEARCH',
  DISCOVER_OPPORTUNITIES: 'DISCOVERY',
  EXPAND_QUERIES: 'DISCOVERY',
  EVALUATE_SOURCE: 'DISCOVERY',
  PROPOSE_HYPOTHESIS: 'DISCOVERY',
  POST_MORTEM: 'FINAL_ANALYSIS',
};

const ESTIMATED_COST_USD: Record<WorkKind, number> = {
  PROCESS_INBOUND_REPLY: 0.02,
  SEND_DUE_MESSAGES: 0.05,
  SCHEDULE_FOLLOWUPS: 0.03,
  EVALUATE_CAMPAIGN: 0, // pure SQL
  REVALIDATE_FEASIBILITY: 0.03,
  REFRESH_EVIDENCE: 0.03,
  NOTIFY_VALIDATED: 0.02,
  QUALIFY_PROSPECTS: 0.1,
  DISCOVER_PROSPECTS: 0.15,
  PREPARE_CAMPAIGN: 0.05,
  RESEARCH_STAGE: 0.08,
  DISCOVER_OPPORTUNITIES: 0.05,
  EXPAND_QUERIES: 0.02,
  EVALUATE_SOURCE: 0.02,
  PROPOSE_HYPOTHESIS: 0.03,
  POST_MORTEM: 0.02,
};

/** Which subsystem a kind of work depends on. Used for dead-letter triage. */
const SUBSYSTEM_BY_KIND: Record<WorkKind, Subsystem> = {
  PROCESS_INBOUND_REPLY: 'email_in',
  SEND_DUE_MESSAGES: 'email_out',
  SCHEDULE_FOLLOWUPS: 'email_out',
  EVALUATE_CAMPAIGN: 'campaigns',
  REVALIDATE_FEASIBILITY: 'research',
  REFRESH_EVIDENCE: 'research',
  NOTIFY_VALIDATED: 'email_out',
  QUALIFY_PROSPECTS: 'prospecting',
  DISCOVER_PROSPECTS: 'prospecting',
  PREPARE_CAMPAIGN: 'campaigns',
  RESEARCH_STAGE: 'research',
  DISCOVER_OPPORTUNITIES: 'discovery',
  EXPAND_QUERIES: 'discovery',
  EVALUATE_SOURCE: 'discovery',
  PROPOSE_HYPOTHESIS: 'llm',
  POST_MORTEM: 'database',
};

const ACTIVE_CAMPAIGN_STATES = "('READY','BATCH_1','BATCH_1_REVIEW','BATCH_2','BATCH_2_REVIEW','SCALING')";

// --- idempotency ----------------------------------------------------------------

/** UTC hour bucket, e.g. 2026-09-20-14. */
export function hourBucket(now = new Date()): string {
  const iso = now.toISOString();
  return `${iso.slice(0, 10)}-${iso.slice(11, 13)}`;
}

/** UTC day bucket, e.g. 2026-09-20. */
export function dayBucket(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Deterministic key for one logical unit of work in one time window. Two ticks
 * in the same window produce the same key, so the queue keeps exactly one row.
 */
export function idempotencyKeyFor(kind: WorkKind, scope: string, bucket: string): string {
  return `${kind}:${scope}:${bucket}`;
}

// --- tick bookkeeping -------------------------------------------------------------

interface Tick {
  decisions: SupervisorDecision[];
  skipped: Map<string, number>;
  enqueued: number;
  budget: BudgetReport;
  outreachHealthy: boolean;
}

function skip(tick: Tick, reason: string, n = 1): void {
  tick.skipped.set(reason, (tick.skipped.get(reason) ?? 0) + n);
}

/** Runs a sibling-owned call that must never be able to fail the whole tick. */
async function attempt<T>(tick: Tick, what: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    skip(tick, `${what} unavailable`);
    logger.warn(`${what} unavailable`, errorToFields(err));
    return null;
  }
}

/**
 * Mirrors canSpend() against a report already read this tick: the phase
 * allocation (with borrowing) AND the global remaining must both allow it.
 */
function affordable(tick: Tick, kind: WorkKind): boolean {
  const projected = ESTIMATED_COST_USD[kind];
  if (projected <= 0) return true;
  if (projected > tick.budget.globalRemainingUsd) return false;
  return projected <= availableForPhase(tick.budget, PHASE_BY_KIND[kind]);
}

interface Proposal {
  kind: WorkKind;
  scope: string;
  reason: string;
  opportunityId?: string | null;
  payload?: Record<string, unknown>;
  /** Overrides the kind's default priority when urgency differs. */
  priority?: number;
  bucket?: 'hour' | 'day';
  runAt?: Date;
  /** Skip the budget pre-check for work that protects a live conversation. */
  budgeted?: boolean;
}

/** Decide + enqueue one unit of work, idempotently. */
async function propose(tick: Tick, p: Proposal): Promise<boolean> {
  const capacity = await hasCapacityFor(p.kind);
  if (!capacity.ok) {
    skip(tick, capacity.reason ?? `${p.kind}: no capacity`);
    return false;
  }
  if (p.budgeted !== false && !affordable(tick, p.kind)) {
    skip(tick, `${PHASE_BY_KIND[p.kind]} budget exhausted`);
    return false;
  }

  const key = idempotencyKeyFor(p.kind, p.scope, p.bucket === 'day' ? dayBucket() : hourBucket());
  const decision: SupervisorDecision = {
    kind: p.kind,
    priority: p.priority ?? priorityFor(p.kind),
    reason: p.reason,
    opportunityId: p.opportunityId ?? null,
    idempotencyKey: key,
  };
  tick.decisions.push(decision);

  const result = await attempt(tick, 'queue', () =>
    enqueue({
      kind: p.kind,
      payload: p.payload ?? {},
      priority: decision.priority,
      idempotencyKey: key,
      opportunityId: decision.opportunityId,
      runAt: p.runAt,
    }),
  );
  if (result === null) return false;
  if (result.created) tick.enqueued += 1;
  else skip(tick, 'already queued');
  return result.created;
}

// --- the tick ---------------------------------------------------------------------

/**
 * One supervisor tick: autostart if needed, watchdog, observe, rank, enqueue,
 * then drain some work within the tick so a healthy system needs no other
 * trigger. Safe to run concurrently — everything it does is idempotent.
 */
export async function runSupervisor(opts?: { maxWorkItems?: number }): Promise<SupervisorReport> {
  const cfg = getConfig();
  const maxWorkItems = Math.max(0, opts?.maxWorkItems ?? DEFAULT_MAX_WORK_ITEMS);

  const tick: Tick = {
    decisions: [],
    skipped: new Map(),
    enqueued: 0,
    budget: {
      globalBudgetUsd: 0,
      globalSpentUsd: 0,
      globalRemainingUsd: 0,
      phases: [],
      exhausted: true,
    },
    outreachHealthy: false,
  };

  // 1 + 2. Promote out of BLOCKED_CONFIGURATION on our own, then self-heal.
  await attempt(tick, 'autostart', () => autoStart());
  await attempt(tick, 'watchdog', () => runWatchdog());

  const snapshot = await attempt(tick, 'runtime state', () => getRuntimeState());
  const runtimeState = snapshot?.state ?? 'UNKNOWN';

  tick.budget = (await attempt(tick, 'budget', () => getBudgetReport())) ?? tick.budget;
  const outreachCapacityRemaining = (await attempt(tick, 'email quota', () => remainingDailyEmailQuota())) ?? 0;

  // 3. Not operational: report what we see and touch nothing.
  const operational = (await attempt(tick, 'runtime', () => isOperational())) ?? false;
  if (!operational) {
    logger.info('supervisor idle: runtime not operational', { runtimeState });
    skip(tick, `runtime not operational (${runtimeState})`);
    return report(tick, runtimeState, 0, 0, outreachCapacityRemaining);
  }

  // 4. Observe. Cheap, read-only, and logged so a tick can be explained later.
  const depth = (await attempt(tick, 'queue depth', () => queueDepth())) ?? {};
  const concurrency = await getConcurrencyState();
  const observation = {
    runtimeState,
    queueDepth: depth,
    ...concurrency,
    budgetRemainingUsd: tick.budget.globalRemainingUsd,
    outreachCapacityRemaining,
    deadLetter: toNumber(depth.DEAD_LETTER, 0),
    recentFailures: await recentJobFailures(),
  };
  logger.info('supervisor observation', observation);

  // 5. Decide, in strict priority order. Nothing below may pre-empt anything
  //    above it: discovery can never starve a prospect who is waiting.
  await decideProtectConversations(tick, cfg.replyLatencyTargetMinutes);
  await decidePotentialWinners(tick);
  tick.outreachHealthy = await maintainDeliverability(tick, runtimeState);
  await decideActiveExperiments(tick);
  await decideProspecting(tick);
  await decideDeepResearch(tick);
  await decideExploration(tick);

  // 6. Triage anything that died.
  const deadLetterReviewed = await triageDeadLetter(tick);

  // 7. Do some of the work now, so a healthy system needs no other trigger.
  const drained = await drainQueue(maxWorkItems);
  if (drained.failed > 0) skip(tick, 'work item failed', drained.failed);

  await attempt(tick, 'heartbeat', () =>
    recordHeartbeat({ subsystem: 'supervisor', status: 'OK', detail: { decisions: tick.decisions.length } }),
  );

  await recordAudit({
    entityType: 'system',
    eventType: 'DECISION',
    actor: 'supervisor',
    reason: 'supervisor tick',
    detail: {
      runtimeState,
      decisions: tick.decisions.length,
      enqueued: tick.enqueued,
      executed: drained.processed,
      failed: drained.failed,
      deadLetterReviewed,
      budgetRemainingUsd: tick.budget.globalRemainingUsd,
    },
  });

  return report(tick, runtimeState, drained.processed, deadLetterReviewed, outreachCapacityRemaining);
}

function report(
  tick: Tick,
  runtimeState: string,
  executed: number,
  deadLetterReviewed: number,
  outreachCapacityRemaining: number,
): SupervisorReport {
  return {
    runtimeState,
    decisions: tick.decisions,
    enqueued: tick.enqueued,
    skipped: [...tick.skipped.entries()].map(([reason, count]) => ({ reason, count })),
    executed,
    budgetRemainingUsd: tick.budget.globalRemainingUsd,
    outreachCapacityRemaining,
    deadLetterReviewed,
  };
}

// --- P1: protect live conversations -------------------------------------------------

/**
 * A real business wrote to us. Nothing else in this file may run before this.
 * Two triggers: an inbound reply that was never classified, and a prospect who
 * has been waiting longer than the reply-latency target.
 */
async function decideProtectConversations(tick: Tick, latencyMinutes: number): Promise<void> {
  const db = await getDb();

  const unprocessed = await db.query<{ campaign_id: string; opportunity_id: string }>(
    `SELECT DISTINCT m.campaign_id, c.opportunity_id
       FROM messages m
       JOIN campaigns c ON c.id = m.campaign_id
      WHERE m.direction = 'INBOUND'
        AND m.classification IS NULL
      LIMIT $1`,
    [SCAN_LIMIT],
  );
  for (const row of unprocessed.rows) {
    await propose(tick, {
      kind: 'PROCESS_INBOUND_REPLY',
      scope: row.campaign_id,
      reason: 'inbound reply has not been processed',
      opportunityId: row.opportunity_id,
      payload: { campaignId: row.campaign_id },
      budgeted: false, // never let a sub-budget silence someone who wrote to us
    });
  }

  const waiting = await db.query<{ campaign_id: string; opportunity_id: string }>(
    `SELECT DISTINCT m.campaign_id, c.opportunity_id
       FROM messages m
       JOIN campaigns c ON c.id = m.campaign_id
      WHERE m.direction = 'INBOUND'
        AND m.received_at IS NOT NULL
        AND m.received_at < now() - ($1::int * INTERVAL '1 minute')
        AND NOT EXISTS (
          SELECT 1 FROM messages o
           WHERE o.prospect_id = m.prospect_id
             AND o.direction = 'OUTBOUND'
             AND o.sent_at IS NOT NULL
             AND o.sent_at > m.received_at
        )
      LIMIT $2`,
    [Math.max(0, latencyMinutes), SCAN_LIMIT],
  );
  for (const row of waiting.rows) {
    await propose(tick, {
      kind: 'PROCESS_INBOUND_REPLY',
      scope: row.campaign_id,
      reason: `prospect waiting longer than ${latencyMinutes} minutes for a reply`,
      opportunityId: row.opportunity_id,
      payload: { campaignId: row.campaign_id },
      budgeted: false,
    });
  }
}

// --- P2: something may already have won ---------------------------------------------

/**
 * Campaigns whose observed counts suggest the gate might now pass, and
 * opportunities the gate has already passed.
 *
 * The comparison below is a SCHEDULING heuristic — "is it worth running the
 * evaluation?" — never a verdict. evaluate_campaigns re-reads every count and
 * the deterministic gate decides. No threshold here is widened or bypassed.
 */
async function decidePotentialWinners(tick: Tick): Promise<void> {
  const cfg = getConfig();
  const db = await getDb();

  const candidates = await db.query<{
    campaign_id: string;
    opportunity_id: string;
    delivered: string | number;
    committed: string | number;
  }>(
    `SELECT c.id AS campaign_id,
            c.opportunity_id,
            (SELECT COUNT(*) FROM messages m
              WHERE m.campaign_id = c.id AND m.direction = 'OUTBOUND' AND m.delivered_at IS NOT NULL) AS delivered,
            (SELECT COUNT(DISTINCT cm.company_key) FROM commitments cm WHERE cm.campaign_id = c.id) AS committed
       FROM campaigns c
       JOIN opportunities o ON o.id = c.opportunity_id
      WHERE c.state NOT IN ('COMPLETE','FAILED')
        AND o.state IN ('CAMPAIGN_READY','VALIDATING')
      LIMIT $1`,
    [SCAN_LIMIT],
  );

  for (const row of candidates.rows) {
    const delivered = toNumber(row.delivered, 0);
    const committed = toNumber(row.committed, 0);
    const worthEvaluating =
      delivered >= cfg.gate.minDeliveredBeforeStandardEvaluation ||
      committed >= cfg.gate.minUniqueStrongCommitments;
    if (!worthEvaluating) continue;
    await propose(tick, {
      kind: 'EVALUATE_CAMPAIGN',
      scope: row.campaign_id,
      reason: `counts may now satisfy the gate (delivered ${delivered}, committed companies ${committed})`,
      opportunityId: row.opportunity_id,
      payload: { campaignId: row.campaign_id },
      budgeted: false,
    });
  }

  // Gate already passed: confirm the thing is still real, then tell the owner.
  const validated = await db.query<{ id: string; state: string; feasibility_checked_at: string | null }>(
    `SELECT id, state, feasibility_checked_at
       FROM opportunities
      WHERE state IN ('VALIDATION_STRONG','READY_TO_BUILD')
      LIMIT $1`,
    [SCAN_LIMIT],
  );

  for (const row of validated.rows) {
    const checkedAt = row.feasibility_checked_at ? Date.parse(row.feasibility_checked_at) : NaN;
    const stale = !Number.isFinite(checkedAt) || Date.now() - checkedAt > 7 * 24 * 60 * 60 * 1000;
    if (stale) {
      await propose(tick, {
        kind: 'REVALIDATE_FEASIBILITY',
        scope: row.id,
        reason: 'about to recommend a build; re-check the product is still buildable',
        opportunityId: row.id,
      });
      await propose(tick, {
        kind: 'REFRESH_EVIDENCE',
        scope: row.id,
        reason: 'evidence behind a build recommendation must be current',
        opportunityId: row.id,
      });
    }
    if (row.state !== 'READY_TO_BUILD') continue;
    if (await alreadyNotified(row.id)) continue;
    await propose(tick, {
      kind: 'NOTIFY_VALIDATED',
      scope: row.id,
      reason: 'gate passed and the owner has not been told yet',
      opportunityId: row.id,
      // After feasibility, not before: the queue orders by next_retry_at.
      runAt: new Date(Date.now() + 60_000),
      budgeted: false,
    });
  }
}

async function alreadyNotified(opportunityId: string): Promise<boolean> {
  const row = await one<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM owner_notifications WHERE dedupe_key = $1 AND sent_at IS NOT NULL`,
    [readyToBuildDedupeKey(opportunityId)],
  );
  return toNumber(row?.n, 0) > 0;
}

// --- P3: deliverability maintenance ----------------------------------------------

/**
 * Volume is earned, not assumed. This runs before any outbound work is
 * scheduled and gates it: if we cannot confirm the sending reputation is
 * healthy, nothing outbound is queued this tick. Failing closed is the whole
 * point — the alternative is burning the domain.
 */
async function maintainDeliverability(tick: Tick, runtimeState: string): Promise<boolean> {
  if (isShadowMode()) {
    skip(tick, 'outreach disabled (shadow mode)');
    return false;
  }

  if (runtimeState === 'PAUSED_DELIVERABILITY') {
    const resumed = await attempt(tick, 'deliverability resume', () => resumeSendingIfRecovered());
    if (!resumed?.resumed) {
      skip(tick, 'sending paused for deliverability');
      return false;
    }
  }

  const verdict = await attempt(tick, 'deliverability check', () => evaluateDeliverability());
  if (!verdict) return false;

  tick.decisions.push({
    kind: 'DELIVERABILITY_MAINTENANCE',
    priority: PRIORITY.MAINTAIN_DELIVERABILITY,
    reason: verdict.reason ?? (verdict.healthy ? 'sending reputation healthy' : 'sending reputation degraded'),
    opportunityId: null,
    idempotencyKey: `DELIVERABILITY_MAINTENANCE:global:${hourBucket()}`,
  });

  if (verdict.shouldPause) {
    await attempt(tick, 'deliverability pause', () =>
      pauseSending(verdict.reason ?? 'deliverability ceiling breached'),
    );
    return false;
  }
  return verdict.healthy;
}

// --- P4: experiments already in flight ---------------------------------------------

async function decideActiveExperiments(tick: Tick): Promise<void> {
  if (!tick.outreachHealthy) return;
  const cfg = getConfig();
  const db = await getDb();

  const sending = await db.query<{ id: string; opportunity_id: string; pending: string | number }>(
    `SELECT c.id, c.opportunity_id,
            (SELECT COUNT(*) FROM messages m
              WHERE m.campaign_id = c.id AND m.direction = 'OUTBOUND' AND m.status IN ('PENDING','DRAFTED')) AS pending
       FROM campaigns c
      WHERE c.state IN ${ACTIVE_CAMPAIGN_STATES}
      LIMIT $1`,
    [SCAN_LIMIT],
  );

  for (const row of sending.rows) {
    if (toNumber(row.pending, 0) > 0) {
      await propose(tick, {
        kind: 'SEND_DUE_MESSAGES',
        scope: row.id,
        reason: 'campaign has drafted messages waiting to go out',
        opportunityId: row.opportunity_id,
        payload: { campaignId: row.id },
      });
    }
  }

  const followups = await db.query<{ id: string; opportunity_id: string }>(
    `SELECT DISTINCT c.id, c.opportunity_id
       FROM campaigns c
       JOIN messages m ON m.campaign_id = c.id
      WHERE c.state IN ${ACTIVE_CAMPAIGN_STATES}
        AND m.direction = 'OUTBOUND'
        AND m.sequence_step = 0
        AND m.delivered_at IS NOT NULL
        AND m.delivered_at < now() - ($1::int * INTERVAL '1 day')
        AND NOT EXISTS (
          SELECT 1 FROM messages r
           WHERE r.prospect_id = m.prospect_id AND r.direction = 'INBOUND'
        )
      LIMIT $2`,
    [Math.max(0, cfg.followup1DelayDays), SCAN_LIMIT],
  );

  for (const row of followups.rows) {
    await propose(tick, {
      kind: 'SCHEDULE_FOLLOWUPS',
      scope: row.id,
      reason: 'delivered messages are past the follow-up delay with no reply',
      opportunityId: row.opportunity_id,
      payload: { campaignId: row.id },
    });
  }
}

// --- P5: feed the next experiment ---------------------------------------------------

async function decideProspecting(tick: Tick): Promise<void> {
  const db = await getDb();

  const needProspects = await db.query<{ id: string; state: string; unqualified: string | number }>(
    `SELECT o.id, o.state,
            (SELECT COUNT(*) FROM prospects p
              WHERE p.opportunity_id = o.id AND p.status IN ('DISCOVERED','QUALIFYING')) AS unqualified
       FROM opportunities o
      WHERE o.state IN ('WEDGE_GENERATED','PROSPECTING')
      ORDER BY o.rank_score DESC, o.created_at ASC
      LIMIT $1`,
    [SCAN_LIMIT],
  );

  for (const row of needProspects.rows) {
    if (toNumber(row.unqualified, 0) > 0) {
      await propose(tick, {
        kind: 'QUALIFY_PROSPECTS',
        scope: row.id,
        reason: 'discovered prospects are waiting to be qualified',
        opportunityId: row.id,
      });
      continue;
    }
    await propose(tick, {
      kind: 'DISCOVER_PROSPECTS',
      scope: row.id,
      reason: 'campaign-ready wedge still needs qualified prospects',
      opportunityId: row.id,
    });
  }

  const readyForCampaign = await db.query<{ id: string }>(
    `SELECT o.id
       FROM opportunities o
      WHERE o.state = 'CAMPAIGN_READY'
        AND NOT EXISTS (SELECT 1 FROM campaigns c WHERE c.opportunity_id = o.id)
      ORDER BY o.rank_score DESC, o.created_at ASC
      LIMIT $1`,
    [SCAN_LIMIT],
  );

  for (const row of readyForCampaign.rows) {
    await propose(tick, {
      kind: 'PREPARE_CAMPAIGN',
      scope: row.id,
      reason: 'enough qualified prospects to run an experiment',
      opportunityId: row.id,
    });
  }
}

// --- P6: deep research on finalists --------------------------------------------------

/**
 * Spend real research money only on the best-ranked finalists, and only as
 * many as the concurrency ceiling allows. Ordered by information-per-dollar so
 * "$0.02 to learn something decisive" beats "$0.40 more on a weak category".
 */
async function decideDeepResearch(tick: Tick): Promise<void> {
  const cfg = getConfig();
  const concurrency = await getConcurrencyState();
  const slots = cfg.concurrency.maxDeepResearchOpportunities - concurrency.deepResearchOpportunities;
  if (slots <= 0) {
    skip(tick, 'max deep research reached');
    return;
  }

  await rankOpportunities(SCAN_LIMIT);

  const db = await getDb();
  const candidates = await db.query<{ id: string }>(
    `SELECT id FROM opportunities
      WHERE state IN ('DISCOVERED','CATEGORY_VERIFYING','CATEGORY_VERIFIED')
      ORDER BY rank_score DESC, created_at ASC
      LIMIT $1`,
    [SCAN_LIMIT],
  );

  const scored: Array<{ id: string; eiv: number }> = [];
  for (const row of candidates.rows) {
    scored.push({ id: row.id, eiv: await expectedInformationValue(row.id) });
  }
  scored.sort((a, b) => b.eiv - a.eiv || a.id.localeCompare(b.id));

  let used = 0;
  for (const candidate of scored) {
    if (used >= slots) break;
    if (candidate.eiv <= 0) continue;
    const enqueued = await propose(tick, {
      kind: 'RESEARCH_STAGE',
      scope: candidate.id,
      reason: `finalist by information value (${candidate.eiv})`,
      opportunityId: candidate.id,
      payload: { expectedInformationValue: candidate.eiv },
    });
    if (enqueued) used += 1;
  }

  // Learn from the dead before discovering more. A post-mortem is what stops
  // the same failed idea being rediscovered next week.
  const failed = await db.query<{ id: string }>(
    `SELECT o.id FROM opportunities o
      WHERE o.state IN ('VALIDATION_FAILED','PROSPECTABILITY_REJECTED')
        AND NOT EXISTS (SELECT 1 FROM failure_memory f WHERE f.opportunity_id = o.id)
      LIMIT 5`,
  );
  for (const row of failed.rows) {
    await propose(tick, {
      kind: 'POST_MORTEM',
      scope: row.id,
      reason: 'failed experiment has no recorded lesson yet',
      opportunityId: row.id,
      bucket: 'day',
    });
  }
}

// --- P7: exploration, with whatever is left -------------------------------------------

async function decideExploration(tick: Tick): Promise<void> {
  await propose(tick, {
    kind: 'DISCOVER_OPPORTUNITIES',
    scope: 'global',
    reason: 'capacity and discovery budget remain',
  });

  await propose(tick, {
    kind: 'EXPAND_QUERIES',
    scope: 'global',
    reason: 'derive new query families from what actually produced commitments',
    bucket: 'day',
  });

  const db = await getDb();
  const unverified = await db.query<{ id: string }>(
    `SELECT id FROM source_registry WHERE status = 'UNVERIFIED' AND enabled ORDER BY created_at ASC LIMIT 1`,
  );
  for (const row of unverified.rows) {
    await propose(tick, {
      kind: 'EVALUATE_SOURCE',
      scope: row.id,
      reason: 'an unverified source cannot be trusted until it is tested',
      payload: { sourceId: row.id },
      bucket: 'day',
    });
  }

  await propose(tick, {
    kind: 'PROPOSE_HYPOTHESIS',
    scope: 'global',
    reason: 'reserved exploration share of the strategy allocation',
    bucket: 'day',
  });
}

// --- dead-letter triage -----------------------------------------------------------

/**
 * Three branches, decided on facts:
 *   - the opportunity is dead        → archive, we are not paying for it again
 *   - the dependency is healthy now  → revive, it was a transient outage
 *   - otherwise                      → escalate ONCE, a human has to look
 */
async function triageDeadLetter(tick: Tick): Promise<number> {
  const items = await attempt(tick, 'dead-letter', () => listDeadLetter(20));
  if (!items || items.length === 0) return 0;

  const health = (await attempt(tick, 'subsystem health', () => getSubsystemHealth())) ?? [];
  let reviewed = 0;

  for (const item of items) {
    reviewed += 1;
    if (await opportunityIsDead(item.opportunityId)) {
      await attempt(tick, 'dead-letter archive', () =>
        archiveDeadLetter(item.id, 'opportunity is no longer worth pursuing'),
      );
      continue;
    }

    const subsystem = SUBSYSTEM_BY_KIND[item.kind] ?? 'scheduler';
    const status = health.find((h) => h.subsystem === subsystem)?.status ?? 'UNKNOWN';
    if (status === 'OK') {
      await attempt(tick, 'dead-letter revive', () =>
        reviveDeadLetter(item.id, `${subsystem} is healthy again`),
      );
      continue;
    }

    await escalateOnce(tick, item, subsystem, status);
  }

  return reviewed;
}

async function opportunityIsDead(opportunityId: string | null): Promise<boolean> {
  if (!opportunityId) return false;
  const row = await one<{ state: string }>('SELECT state FROM opportunities WHERE id = $1', [opportunityId]);
  if (!row) return true; // the row is gone; nothing to pursue
  return isOpportunityState(row.state) && DEAD_STATES.has(row.state);
}

/**
 * One notification per dead item, ever. The owner is told when a machine
 * cannot fix something itself — never as a running commentary.
 */
async function escalateOnce(
  tick: Tick,
  item: WorkItem,
  subsystem: Subsystem,
  status: string,
): Promise<void> {
  await attempt(tick, 'escalation', () =>
    notifyOwner({
      kind: 'JOB_FAILURE',
      subject: `MRR Validator: ${item.kind} needs a human`,
      body:
        `Work item ${item.id} (${item.kind}) dead-lettered after ${item.attempts} attempts and ` +
        `automatic recovery did not help.\n\n` +
        `Reason: ${item.deadLetterReason ?? item.lastError ?? 'unknown'}\n` +
        `Dependency: ${subsystem} (${status})\n\n` +
        `Nothing else is blocked — the rest of the system continues. No further ` +
        `alerts will be sent for this item.`,
      dedupeKey: `DEAD_LETTER:${item.id}`,
      detail: { workItemId: item.id, kind: item.kind, subsystem, status },
    }),
  );
  skip(tick, 'dead-letter escalated');
}

// --- execution ---------------------------------------------------------------------

/** Executes queued work items. Exposed separately for tests and the simulator. */
export async function drainQueue(maxItems: number): Promise<{ processed: number; failed: number }> {
  const workerId = `supervisor:${process.pid}`;
  let processed = 0;
  let failed = 0;

  for (let i = 0; i < maxItems; i += 1) {
    let item: WorkItem | null;
    try {
      item = await claimNext(workerId);
    } catch (err) {
      logger.warn('queue claim unavailable', errorToFields(err));
      break;
    }
    if (!item) break;

    // One failing item fails ONLY that item. The tick always finishes.
    try {
      await executeWork(item);
      await completeWork(item.id);
      processed += 1;
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      logger.error('work item failed', { id: item.id, kind: item.kind, error: message });
      try {
        await failWork(item.id, message);
      } catch (failErr) {
        logger.error('could not record work failure', errorToFields(failErr));
      }
    }
  }

  return { processed, failed };
}

/**
 * WorkKind → the existing job or pipeline function that does the work.
 *
 * This is a dispatch table and nothing more. No pipeline logic is
 * reimplemented here: where a job already exists it is run through the normal
 * runner (locking, job_runs, budget halts, kill switch), and where the work
 * belongs to another autonomy module its published contract is called.
 */
async function executeWork(item: WorkItem): Promise<void> {
  switch (item.kind) {
    case 'PROCESS_INBOUND_REPLY': {
      // Replies are classified by the inbound webhook; what can be left
      // waiting is the drafted answer. flushPendingAutoReplies keeps every
      // send rule (window, caps, suppression, shadow mode).
      await flushPendingAutoReplies();
      return;
    }
    case 'SEND_DUE_MESSAGES':
      return runJobOrThrow('send_due_messages');
    case 'SCHEDULE_FOLLOWUPS':
      return runJobOrThrow('schedule_followups');
    case 'EVALUATE_CAMPAIGN':
      return runJobOrThrow('evaluate_campaigns');
    case 'NOTIFY_VALIDATED':
      return runJobOrThrow('notify_validated_opportunities');
    case 'DISCOVER_PROSPECTS':
      return runJobOrThrow('discover_prospects');
    case 'QUALIFY_PROSPECTS':
      return runJobOrThrow('qualify_prospects');
    case 'PREPARE_CAMPAIGN':
      return runJobOrThrow('prepare_campaigns');
    case 'DISCOVER_OPPORTUNITIES':
      return runJobOrThrow('discover_opportunities');

    case 'RESEARCH_STAGE': {
      const job = await researchJobFor(item.opportunityId);
      // The opportunity moved on since this was queued: nothing to do, and
      // failing it would only dead-letter work that is already done.
      if (!job) return;
      return runJobOrThrow(job);
    }

    case 'REVALIDATE_FEASIBILITY': {
      if (!item.opportunityId) return;
      const { revalidateFeasibility } = await import('./feasibility');
      await revalidateFeasibility(item.opportunityId);
      return;
    }
    case 'REFRESH_EVIDENCE': {
      if (!item.opportunityId) return;
      const { refreshStaleEvidence } = await import('./provenance');
      await refreshStaleEvidence(item.opportunityId);
      return;
    }
    case 'EXPAND_QUERIES': {
      const { expandQueryFamilies } = await import('./discovery/index');
      await expandQueryFamilies(5);
      return;
    }
    case 'EVALUATE_SOURCE': {
      const sourceId = typeof item.payload.sourceId === 'string' ? item.payload.sourceId : null;
      if (!sourceId) return;
      const { evaluateSource } = await import('./discovery/index');
      await evaluateSource(sourceId);
      return;
    }
    case 'PROPOSE_HYPOTHESIS': {
      const { proposeHypotheses } = await import('./strategy/index');
      await proposeHypotheses(3);
      return;
    }
    case 'POST_MORTEM': {
      if (!item.opportunityId) return;
      const { writePostMortem } = await import('./strategy/index');
      await writePostMortem(item.opportunityId);
      return;
    }
  }
}

/** Which existing research job moves this opportunity forward, if any. */
async function researchJobFor(opportunityId: string | null): Promise<JobName | null> {
  if (!opportunityId) return 'verify_categories';
  const row = await one<{ state: string }>('SELECT state FROM opportunities WHERE id = $1', [opportunityId]);
  if (!row) return null;
  if (row.state === 'DISCOVERED' || row.state === 'CATEGORY_VERIFYING') return 'verify_categories';
  if (row.state === 'CATEGORY_VERIFIED') return 'generate_wedges';
  return null;
}

/**
 * SKIPPED means a control-plane switch or another runner said no. That is a
 * correct outcome, not a failure — retrying it would only burn attempts.
 */
async function runJobOrThrow(name: JobName): Promise<void> {
  const summary = await runJob(name);
  if (summary.status === 'FAILED' || summary.status === 'HALTED_BUDGET') {
    throw new Error(`${name} ${summary.status}: ${summary.error ?? 'unknown error'}`);
  }
}

// --- observation helpers -------------------------------------------------------------

async function recentJobFailures(): Promise<number> {
  const row = await one<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM job_runs
      WHERE status = 'FAILED' AND started_at >= now() - INTERVAL '24 hours'`,
  );
  return toNumber(row?.n, 0);
}
