/**
 * Job execution wrapper.
 *
 * Every job is: locked, recorded in job_runs, budget-aware, and safe to rerun.
 * A job that throws is recorded as FAILED and never takes the process down.
 * Repeated failures produce ONE actionable owner alert, not a stream.
 */
import { getDb, toNumber } from '../lib/db';
import { newId } from '../lib/hash';
import { createLogger, errorToFields } from '../lib/logger';
import { BudgetExceededError, SafetyError } from '../lib/errors';
import { getConfig } from '../lib/config';
import { monthStart } from '../lib/cost';
import { withLock } from './lock';

const logger = createLogger('jobs');

export interface JobResult {
  recordsProcessed: number;
  detail?: Record<string, unknown>;
}

export type JobFn = () => Promise<JobResult>;

export type JobStatus = 'SUCCESS' | 'FAILED' | 'SKIPPED' | 'HALTED_BUDGET' | 'RUNNING';

export interface JobRunSummary {
  job: string;
  status: JobStatus;
  durationMs: number;
  recordsProcessed: number;
  cost: number;
  error: string | null;
}

/** Consecutive failures before we bother the owner. */
const FAILURE_ALERT_THRESHOLD = 3;

export async function runJobSafely(job: string, fn: JobFn): Promise<JobRunSummary> {
  const cfg = getConfig();

  if (cfg.killSwitch) {
    logger.warn('KILL_SWITCH is on; refusing to run', { job });
    return { job, status: 'SKIPPED', durationMs: 0, recordsProcessed: 0, cost: 0, error: 'KILL_SWITCH' };
  }

  const outcome = await withLock(job, async () => {
    const db = await getDb();
    const runId = newId('run');
    const startedAt = Date.now();
    const costBefore = await totalCostSince(monthStart());

    await db.query(
      `INSERT INTO job_runs (id, job, started_at, status) VALUES ($1,$2,now(),'RUNNING')`,
      [runId, job],
    );

    let status: JobStatus = 'SUCCESS';
    let records = 0;
    let error: string | null = null;
    let detail: Record<string, unknown> = {};
    let budgetError: BudgetExceededError | null = null;

    try {
      const result = await fn();
      records = result.recordsProcessed;
      detail = result.detail ?? {};
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        status = 'HALTED_BUDGET';
        error = err.message;
        detail = { budgetKind: err.budgetKind, spent: err.spent, limit: err.limit };
        budgetError = err;
        logger.error('job halted: budget exceeded', { job, ...detail });
      } else if (err instanceof SafetyError) {
        status = 'SKIPPED';
        error = err.message;
        logger.warn('job skipped by safety switch', { job, reason: err.message });
      } else {
        status = 'FAILED';
        error = err instanceof Error ? err.message : String(err);
        detail = errorToFields(err);
        logger.error('job failed', { job, ...detail });
      }
    }

    const durationMs = Date.now() - startedAt;
    const cost = Math.max(0, (await totalCostSince(monthStart())) - costBefore);

    await db.query(
      `UPDATE job_runs
          SET completed_at = now(), duration_ms = $2, records_processed = $3,
              cost = $4, status = $5, error = $6, detail_json = $7
        WHERE id = $1`,
      [runId, durationMs, records, cost, status, error, JSON.stringify(detail)],
    );

    // Notifications happen only after the job_runs row is durable, and can
    // never propagate: a broken notifier must not also lose the job result.
    if (budgetError) await safely(() => alertBudget(budgetError), 'budget alert');
    if (status === 'FAILED') await safely(() => maybeAlertRepeatedFailure(job), 'failure alert');

    logger.info('job finished', { job, status, durationMs, records, cost });
    return { job, status, durationMs, recordsProcessed: records, cost, error } satisfies JobRunSummary;
  });

  if (!outcome.ran) {
    logger.info('job skipped: already running elsewhere', { job });
    return { job, status: 'SKIPPED', durationMs: 0, recordsProcessed: 0, cost: 0, error: 'LOCKED' };
  }
  return outcome.result;
}

/**
 * Runs a notification side-effect that must never affect the job's outcome.
 * Catches synchronous throws as well as rejections — a missing or broken
 * notifier module used to take the whole runner down with it.
 */
async function safely(fn: () => Promise<unknown>, what: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logger.error(`${what} failed`, errorToFields(err));
  }
}

async function totalCostSince(since: Date): Promise<number> {
  const db = await getDb();
  const res = await db.query<{ total: string | null }>(
    'SELECT COALESCE(SUM(estimated_cost),0) AS total FROM cost_ledger WHERE created_at >= $1',
    [since.toISOString()],
  );
  return toNumber(res.rows[0]?.total, 0);
}

/**
 * Alerts the owner ONCE per job per day after N consecutive failures, rather
 * than emailing on every failed run.
 */
async function maybeAlertRepeatedFailure(job: string): Promise<void> {
  const db = await getDb();
  const res = await db.query<{ status: string }>(
    'SELECT status FROM job_runs WHERE job = $1 ORDER BY started_at DESC LIMIT $2',
    [job, FAILURE_ALERT_THRESHOLD],
  );
  const recent = res.rows;
  if (recent.length < FAILURE_ALERT_THRESHOLD) return;
  if (!recent.every((r) => r.status === 'FAILED')) return;

  const day = new Date().toISOString().slice(0, 10);
  const { notifyOwner } = await import('../pipeline/notify/index');
  await notifyOwner({
    kind: 'JOB_FAILURE',
    subject: `MRR Validator: job "${job}" is failing repeatedly`,
    body:
      `The job "${job}" has failed ${FAILURE_ALERT_THRESHOLD} times in a row.\n\n` +
      `Check /admin/costs and the job_runs table for the recorded error.\n` +
      `No further alerts for this job will be sent today.`,
    dedupeKey: `JOB_FAILURE:${job}:${day}`,
    detail: { job },
  });
}

async function alertBudget(err: BudgetExceededError): Promise<void> {
  const period = new Date().toISOString().slice(0, 7);
  const { notifyOwner } = await import('../pipeline/notify/index');
  await notifyOwner({
    kind: 'COST_LIMIT',
    subject: `MRR Validator: ${err.budgetKind} budget reached`,
    body:
      `The ${err.budgetKind} budget has been reached (${err.spent} of ${err.limit}).\n\n` +
      `Affected jobs are now halted. Nothing will be silently overspent.\n\n` +
      `To continue this period, raise the corresponding budget environment variable.\n` +
      `Otherwise the jobs resume automatically at the start of the next period.`,
    dedupeKey: `COST_LIMIT:${err.budgetKind}:${period}`,
    detail: { budgetKind: err.budgetKind, spent: err.spent, limit: err.limit },
  });
}
