/**
 * Every scheduled job.
 *
 * `supervisor` is the autonomous loop and the only thing that strictly needs a
 * timer; it decides what happens next and drains its own work queue. The named
 * pipeline jobs remain individually addressable so one stage can be run or
 * retried on its own, and the three cadence jobs carry the low-frequency
 * strategy work that must not delay a prospect reply.
 *
 * Every job is idempotent and safe to rerun. Duplicate scheduler executions
 * are prevented by the job lock plus per-message idempotency keys.
 *
 * Shadow mode (`AUTONOMY_ENABLED=false`) lets research jobs run but blocks
 * anything that reaches the outside world. `OUTREACH_ENABLED` gates sending
 * separately, so research can be fully autonomous with zero outbound email.
 */
import { getConfig, isShadowMode } from '../lib/config';
import { getDb } from '../lib/db';
import { createLogger } from '../lib/logger';
import { SafetyError } from '../lib/errors';
import { recordAudit } from '../lib/audit';
import { getBudgetSnapshot } from '../lib/cost';
import { runJobSafely, type JobFn, type JobResult, type JobRunSummary } from './runner';

import { discoverOpportunities } from '../pipeline/discovery/index';
import { verifyCategories } from '../pipeline/verification/index';
import { generateWedges } from '../pipeline/wedge/index';
import { discoverProspects, qualifyProspects } from '../pipeline/prospecting/index';
import {
  prepareCampaigns,
  sendDueMessages,
  scheduleFollowups,
  flushPendingAutoReplies,
} from '../pipeline/outreach/index';
import { evaluateCampaigns } from '../pipeline/validation/index';
import { notifyValidatedOpportunities } from '../pipeline/notify/index';
import { generateBuildSpec } from '../pipeline/buildspec/index';

// The autonomy plane. These are imported here, in the job registry, because the
// registry is the ONLY thing the scheduler can reach: `runSupervisor` used to be
// called from the simulation and nowhere else, which left the entire adaptive
// subsystem inert in production.
import { runSupervisor } from '../autonomy/supervisor';
import { releaseStaleClaims, listDeadLetter, archiveDeadLetter, queueDepth } from '../autonomy/queue';
import { expandQueryFamilies, seedQueryFamilies } from '../autonomy/discovery/queries';
import { seedSources, listSources } from '../autonomy/discovery/sources';
import { proposeHypotheses } from '../autonomy/strategy/propose';
import {
  runCalibration,
  recordCalibrationRun,
  isConfigurationAcceptable,
  REPLY_CLASSIFIER_PROMPT_ID,
} from '../autonomy/calibration';
import { getBudgetReport, currentPeriod } from '../autonomy/budget';
import { getRuntimeState, getSubsystemHealth } from '../autonomy/runtime';
import { outreachPermitted } from '../autonomy/readiness';
import { reconcileDelivery, pollInbound, inboundIsConfigured } from '../pipeline/outreach/polling';

/** How many discovery query families one daily cadence may expand. */
const DAILY_QUERY_EXPANSION_LIMIT = 5;
/** How many strategy hypotheses one weekly retrospective may propose. */
const WEEKLY_HYPOTHESIS_LIMIT = 5;

const logger = createLogger('jobs:registry');

export const JOB_NAMES = [
  // The autonomous loop. `supervisor` is what the deployed scheduler actually
  // posts (.github/workflows/supervisor.yml); it must be a real job name or the
  // cron route answers UNKNOWN_JOB and nothing on a timer ever runs.
  'supervisor',
  'daily_strategy',
  'weekly_retrospective',
  'monthly_maintenance',
  // Polling replaces webhooks: no public endpoint, no tunnel, no ingress.
  'reconcile_delivery',
  'poll_inbound',
  'discover_opportunities',
  'verify_categories',
  'generate_wedges',
  'discover_prospects',
  'qualify_prospects',
  'prepare_campaigns',
  'send_due_messages',
  'schedule_followups',
  'evaluate_campaigns',
  'cleanup_stale_opportunities',
  'recalculate_costs',
  'notify_validated_opportunities',
] as const;

export type JobName = (typeof JOB_NAMES)[number];

export function isJobName(v: string): v is JobName {
  return (JOB_NAMES as readonly string[]).includes(v);
}

/** Jobs that may reach a prospect's inbox. Blocked unless outreach is enabled. */
const OUTBOUND_JOBS: ReadonlySet<JobName> = new Set<JobName>([
  'send_due_messages',
  'schedule_followups',
]);

function requireOutreach(name: JobName): void {
  const cfg = getConfig();
  if (!OUTBOUND_JOBS.has(name)) return;
  if (!cfg.autonomyEnabled) {
    throw new SafetyError(`${name} blocked: AUTONOMY_ENABLED is false (shadow mode)`);
  }
  if (!cfg.outreachEnabled) {
    throw new SafetyError(`${name} blocked: OUTREACH_ENABLED is false`);
  }
}

const JOBS: Record<JobName, JobFn> = {
  /**
   * One supervisor tick — the autonomous loop itself.
   *
   * This is the job the deployed scheduler posts every 15 minutes. It is the
   * only production path into autostart, the watchdog, work selection, the
   * durable queue and the staged-research ladder. `runSupervisor` performs
   * autostart and the watchdog internally, so a fresh deployment reaches
   * RUNNING on its own first tick without an operator command.
   */
  supervisor: async () => {
    const report = await runSupervisor();
    return {
      recordsProcessed: report.enqueued + report.executed,
      detail: {
        runtimeState: report.runtimeState,
        enqueued: report.enqueued,
        executed: report.executed,
        decisions: report.decisions.length,
        skipped: report.skipped,
        budgetRemainingUsd: report.budgetRemainingUsd,
        outreachCapacityRemaining: report.outreachCapacityRemaining,
        deadLetterReviewed: report.deadLetterReviewed,
      },
    };
  },

  /**
   * Daily: keep the adaptive planes fed. Discovery query families and the
   * source registry are seeded/expanded here, price experiments are ensured,
   * and the durable queue's stale claims and dead letters are reviewed.
   */
  daily_strategy: async () => {
    const sources = await seedSources();
    const families = await seedQueryFamilies();
    const expansion = await expandQueryFamilies(DAILY_QUERY_EXPANSION_LIMIT);
    const released = await releaseStaleClaims();
    const dead = await listDeadLetter(50);
    const depth = await queueDepth();
    const budget = await getBudgetReport();

    const detail = {
      sourcesSeeded: sources.created,
      queryFamiliesSeeded: families.created,
      queryFamiliesExpanded: expansion.expanded,
      queryFamiliesDeprioritized: expansion.deprioritized,
      staleClaimsReleased: released,
      deadLetterDepth: dead.length,
      queueDepth: depth,
      budgetRemainingUsd: budget.globalRemainingUsd,
    };

    await recordAudit({
      entityType: 'system',
      eventType: 'DECISION',
      actor: 'daily_strategy',
      reason: 'daily strategy cadence',
      detail,
    });

    return {
      recordsProcessed: sources.created + families.created + expansion.expanded,
      detail,
    };
  },

  /**
   * Weekly: strategy retrospective. Re-proposes hypotheses from accumulated
   * outcomes, re-runs prompt calibration against the fixture set, and records
   * whether the current configuration is still acceptable.
   */
  weekly_retrospective: async () => {
    const hypotheses = await proposeHypotheses(WEEKLY_HYPOTHESIS_LIMIT);
    const results = await runCalibration();
    for (const result of results) await recordCalibrationRun(result);
    const acceptable = await isConfigurationAcceptable(REPLY_CLASSIFIER_PROMPT_ID);
    const sources = await listSources();

    const detail = {
      hypothesesProposed: hypotheses.proposed,
      hypothesesAdmitted: hypotheses.admitted,
      hypothesesRejected: hypotheses.rejected.length,
      calibrationRuns: results.length,
      calibrationAccuracy: results[0]?.accuracy ?? null,
      calibrationAcceptable: acceptable,
      sourcesTracked: sources.length,
    };

    await recordAudit({
      entityType: 'system',
      eventType: 'DECISION',
      actor: 'weekly_retrospective',
      reason: 'weekly retrospective cadence',
      detail,
    });

    return { recordsProcessed: hypotheses.admitted, detail };
  },

  /**
   * Monthly: housekeeping. Archives dead-letter items that have been reviewed,
   * runs the stale-opportunity cleanup, and records the budget period roll.
   */
  monthly_maintenance: async () => {
    const cleanup = await cleanupStaleOpportunities();
    const dead = await listDeadLetter(200);
    for (const item of dead) {
      await archiveDeadLetter(item.id, 'monthly maintenance: reviewed and archived');
    }
    const budget = await getBudgetReport();
    const runtime = await getRuntimeState();
    const health = await getSubsystemHealth();

    const detail = {
      archivedOpportunities: cleanup.recordsProcessed,
      deadLetterArchived: dead.length,
      budgetPeriod: currentPeriod(),
      budgetRemainingUsd: budget.globalRemainingUsd,
      runtimeState: runtime.state,
      degradedSubsystems: health.filter((h) => h.status !== 'OK').map((h) => h.subsystem),
    };

    await recordAudit({
      entityType: 'system',
      eventType: 'DECISION',
      actor: 'monthly_maintenance',
      reason: 'monthly maintenance cadence',
      detail,
    });

    return { recordsProcessed: cleanup.recordsProcessed + dead.length, detail };
  },

  /** Real delivery state, pulled from Resend. Never inferred locally. */
  reconcile_delivery: async () => {
    const res = await reconcileDelivery(100);
    return {
      recordsProcessed: res.updated,
      detail: { ...res },
    };
  },

  /**
   * Real replies, pulled from the Resend inbox, threaded, classified and fed
   * into the validation ladder. This is the half that makes validation
   * possible at all: a system that cannot hear an answer cannot validate.
   */
  poll_inbound: async () => {
    const configured = await inboundIsConfigured();
    if (!configured.ok) {
      throw new SafetyError(`poll_inbound blocked: ${configured.reason}`);
    }
    const res = await pollInbound(50);
    return {
      recordsProcessed: res.processed,
      detail: { ...res },
    };
  },

  discover_opportunities: async () => {
    const cfg = getConfig();
    const res = await discoverOpportunities(cfg.discoveryCandidatesPerDay);
    return {
      recordsProcessed: res.opportunitiesCreated,
      detail: {
        candidatesFound: res.candidatesFound,
        duplicatesSkipped: res.duplicatesSkipped,
      },
    };
  },

  verify_categories: async () => {
    const cfg = getConfig();
    const outcomes = await verifyCategories(cfg.deepVerificationsPerDay);
    return {
      recordsProcessed: outcomes.length,
      detail: {
        verified: outcomes.filter((o) => o.verified).length,
        rejected: outcomes.filter((o) => !o.verified).length,
      },
    };
  },

  generate_wedges: async () => {
    const results = await generateWedges(getConfig().deepVerificationsPerDay);
    return {
      recordsProcessed: results.length,
      detail: { generated: results.filter((r) => r.wedge !== null).length },
    };
  },

  discover_prospects: async () => {
    const results = await discoverProspects(getConfig().maxActiveValidations);
    return {
      recordsProcessed: results.reduce((n, r) => n + r.discovered, 0),
      detail: { opportunities: results.length },
    };
  },

  qualify_prospects: async () => {
    const results = await qualifyProspects(getConfig().maxActiveValidations);
    return {
      recordsProcessed: results.reduce((n, r) => n + r.qualified, 0),
      detail: {
        opportunities: results.length,
        rejected: results.filter((r) => r.rejected).length,
      },
    };
  },

  prepare_campaigns: async () => {
    const results = await prepareCampaigns(getConfig().maxActiveValidations);
    return {
      recordsProcessed: results.reduce((n, r) => n + r.drafted, 0),
      detail: { campaigns: results.filter((r) => r.campaignId !== null).length },
    };
  },

  send_due_messages: async () => {
    requireOutreach('send_due_messages');

    // The readiness gate is machine-enforced here, at the one place real mail
    // can leave. Configuration proving intent is not enough: this refuses to
    // send until a genuine Resend delivery event and a genuine inbound reply
    // have actually been seen, because a system that cannot hear an answer
    // cannot validate anything and should not be cold-emailing strangers.
    // A canary aimed at OWNER_TEST_EMAIL runs under the owner-test scope; the
    // autonomous loop always runs under the full one.
    const scope = process.env.OUTREACH_SCOPE === 'OWNER_TEST' ? 'OWNER_TEST' : 'REAL_PROSPECTS';
    const permitted = await outreachPermitted(scope);
    if (!permitted.allowed) {
      throw new SafetyError(`send_due_messages blocked: ${permitted.reason}`);
    }
    const results = await sendDueMessages();
    // Auto-replies are kept off the campaign batch quota (answering someone
    // who wrote to us is not cold outreach), so they need flushing here or a
    // reply drafted outside the sending window would never go out at all.
    const autoReplies = await flushPendingAutoReplies();
    return {
      recordsProcessed: results.reduce((n, r) => n + r.sent, 0) + autoReplies.sent,
      detail: {
        campaigns: results.length,
        failed: results.reduce((n, r) => n + r.failed, 0),
        halted: results.filter((r) => r.haltedReason !== null).map((r) => r.haltedReason),
        autoRepliesSent: autoReplies.sent,
        autoRepliesPending: autoReplies.skipped,
      },
    };
  },

  schedule_followups: async () => {
    requireOutreach('schedule_followups');
    const res = await scheduleFollowups();
    return { recordsProcessed: res.queued };
  },

  evaluate_campaigns: async () => {
    const evaluations = await evaluateCampaigns();
    return {
      recordsProcessed: evaluations.length,
      detail: { passed: evaluations.filter((e) => e.passed).length },
    };
  },

  cleanup_stale_opportunities: async () => cleanupStaleOpportunities(),

  recalculate_costs: async () => {
    const snap = await getBudgetSnapshot();
    logger.info('budget snapshot', { ...snap });
    return { recordsProcessed: 1, detail: { ...snap } };
  },

  notify_validated_opportunities: async () => {
    // The owner's email points at validated/<slug>/, so the export has to
    // exist before the email goes out. Generation is idempotent and reruns
    // safely, including for an opportunity notified on an earlier run.
    const specs = await generateBuildSpecsForValidated();
    const res = await notifyValidatedOpportunities();
    return {
      recordsProcessed: res.sent,
      detail: { buildSpecsWritten: specs.length, directories: specs },
    };
  },
};

/**
 * Archives long-dead opportunities and prunes expired lock/cache rows.
 * Pure SQL, no LLM, no network. Touches only rows already past their expiry.
 */
async function cleanupStaleOpportunities(): Promise<JobResult> {
  const db = await getDb();

  const dead = await db.query<{ id: string; state: string }>(
    `SELECT id, state FROM opportunities
      WHERE state IN ('CATEGORY_REJECTED','PROSPECTABILITY_REJECTED','VALIDATION_FAILED')
        AND updated_at < now() - INTERVAL '14 days'
      LIMIT 200`,
  );

  const { transitionOpportunity } = await import('../lib/audit');
  for (const row of dead.rows) {
    await transitionOpportunity({
      opportunityId: row.id,
      to: 'ARCHIVED',
      actor: 'cleanup_stale_opportunities',
      reason: 'dead for 14 days',
    }).catch((err) => logger.warn('archive failed', { id: row.id, err: String(err) }));
  }

  const staleLocks = await db.query(`DELETE FROM job_locks WHERE expires_at < now()`);
  const staleCache = await db.query(`DELETE FROM search_cache WHERE expires_at < now()`);

  // An opportunity stuck mid-pipeline for a month is a bug signal, not garbage.
  const stuck = await db.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM opportunities
      WHERE state IN ('CATEGORY_VERIFYING','PROSPECTING','VALIDATING')
        AND updated_at < now() - INTERVAL '30 days'`,
  );

  await recordAudit({
    entityType: 'system',
    eventType: 'DECISION',
    actor: 'cleanup_stale_opportunities',
    reason: 'periodic cleanup',
    detail: {
      archived: dead.rows.length,
      staleLocksRemoved: staleLocks.rowCount,
      expiredSearchCache: staleCache.rowCount,
      stuckOpportunities: stuck.rows[0]?.n ?? '0',
    },
  });

  return {
    recordsProcessed: dead.rows.length,
    detail: { staleLocksRemoved: staleLocks.rowCount, expiredSearchCache: staleCache.rowCount },
  };
}

/**
 * Writes the hand-off directory for every READY_TO_BUILD opportunity.
 *
 * Kept here rather than inside the notifier because it is a side effect on the
 * filesystem, not part of composing an email — and because it must still run
 * for an opportunity whose notification was already sent (otherwise a crash
 * between the two steps would leave the export permanently missing).
 */
async function generateBuildSpecsForValidated(): Promise<string[]> {
  const db = await getDb();
  const res = await db.query<{ id: string }>(
    `SELECT id FROM opportunities WHERE state = 'READY_TO_BUILD'`,
  );
  const written: string[] = [];
  for (const row of res.rows) {
    try {
      const spec = await generateBuildSpec(row.id);
      written.push(spec.directory);
      logger.info('build spec written', { opportunityId: row.id, directory: spec.directory });
    } catch (err) {
      // A failed export must not block the notification the owner is waiting for.
      logger.error('build spec generation failed', { opportunityId: row.id, err: String(err) });
    }
  }
  return written;
}

/** Runs one job by name, with locking, job_runs recording and error capture. */
export async function runJob(name: string): Promise<JobRunSummary> {
  if (!isJobName(name)) {
    throw new SafetyError(`unknown job: ${name}`, { known: JOB_NAMES });
  }
  return runJobSafely(name, JOBS[name]);
}

/**
 * The full daily pipeline, in dependency order. Each job is independently
 * locked and recorded, so a failure in one does not prevent the others.
 */
export const PIPELINE_ORDER: readonly JobName[] = [
  'discover_opportunities',
  'verify_categories',
  'generate_wedges',
  'discover_prospects',
  'qualify_prospects',
  'prepare_campaigns',
  'send_due_messages',
  'schedule_followups',
  'evaluate_campaigns',
  'notify_validated_opportunities',
  'recalculate_costs',
  'cleanup_stale_opportunities',
];

export async function runPipeline(jobs: readonly JobName[] = PIPELINE_ORDER): Promise<JobRunSummary[]> {
  const shadow = isShadowMode();
  logger.info('pipeline starting', { shadow, jobs: jobs.length });
  const summaries: JobRunSummary[] = [];
  for (const job of jobs) {
    summaries.push(await runJob(job));
  }
  return summaries;
}
