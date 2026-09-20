/**
 * The 12 scheduled jobs.
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

const logger = createLogger('jobs:registry');

export const JOB_NAMES = [
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
    const res = await notifyValidatedOpportunities();
    return { recordsProcessed: res.sent };
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
