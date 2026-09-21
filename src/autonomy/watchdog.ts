/** PUBLIC API — WATCHDOG / SELF-HEALING. Owned by the runtime agent. */
import { getConfig } from '../lib/config';
import { getDb } from '../lib/db';
import { createLogger, errorToFields } from '../lib/logger';
import type { NotificationKind } from '../lib/contracts';
import { notifyOwner } from '../pipeline/notify/index';
import { autoStart } from './autostart';
import { listDeadLetter, releaseStaleClaims, reviveDeadLetter } from './queue';
import {
  getRuntimeState,
  getSubsystemHealth,
  recordHeartbeat,
  transitionRuntime,
} from './runtime';
import type { HealthStatus, RuntimeState, Subsystem, WorkKind } from './types';

export interface WatchdogReport {
  checked: number;
  degraded: string[];
  recovered: string[];
  /** Populated only when automatic recovery failed AND owner action is needed. */
  escalations: Array<{ subsystem: string; reason: string }>;
  runtimeChanged: boolean;
}

const logger = createLogger('autonomy:watchdog');
const ACTOR = 'watchdog';

/** A job_runs row still RUNNING after this long belonged to a dead process. */
const ABANDONED_JOB_HOURS = 1;

/** How many missed supervisor intervals count as "the scheduler has stopped". */
const SCHEDULER_STALE_INTERVALS = 4;

interface Escalation {
  code: string;
  kind: Exclude<NotificationKind, 'READY_TO_BUILD'>;
  reason: string;
  remediation: string;
}

interface Probe {
  subsystem: Subsystem;
  status: HealthStatus;
  error: string | null;
  /** Set only for faults the system cannot fix by itself. */
  escalation: Escalation | null;
}

/**
 * Which subsystem a queued unit of work depends on. Used to revive dead-letter
 * items once the thing that killed them is healthy again, instead of leaving
 * real work parked because a provider had a bad afternoon.
 */
const KIND_DEPENDENCY: Readonly<Record<WorkKind, Subsystem>> = {
  PROCESS_INBOUND_REPLY: 'email_in',
  SEND_DUE_MESSAGES: 'email_out',
  SCHEDULE_FOLLOWUPS: 'email_out',
  EVALUATE_CAMPAIGN: 'database',
  REVALIDATE_FEASIBILITY: 'llm',
  NOTIFY_VALIDATED: 'email_out',
  QUALIFY_PROSPECTS: 'llm',
  DISCOVER_PROSPECTS: 'search',
  PREPARE_CAMPAIGN: 'llm',
  RESEARCH_STAGE: 'llm',
  DISCOVER_OPPORTUNITIES: 'search',
  EXPAND_QUERIES: 'llm',
  EVALUATE_SOURCE: 'search',
  PROPOSE_HYPOTHESIS: 'llm',
  POST_MORTEM: 'llm',
  REFRESH_EVIDENCE: 'search',
};

/** Runtime states the watchdog may drive back towards RUNNING via autostart. */
const RESUMABLE: ReadonlySet<RuntimeState> = new Set<RuntimeState>([
  'BOOTING',
  'SELF_TESTING',
  'SHADOW_VERIFYING',
  'BLOCKED_CONFIGURATION',
  'EMERGENCY_STOP',
]);

/**
 * Probes subsystems, attempts self-recovery (stale locks, abandoned work, provider
 * retries), and moves the runtime state when a subsystem stops progressing.
 * Notifies the owner ONLY when automatic recovery fails or credentials are
 * required.
 */
export async function runWatchdog(): Promise<WatchdogReport> {
  const cfg = getConfig();
  const report: WatchdogReport = {
    checked: 0,
    degraded: [],
    recovered: [],
    escalations: [],
    runtimeChanged: false,
  };

  if (cfg.killSwitch) {
    const stopped = await transitionRuntime({
      to: 'EMERGENCY_STOP',
      reason: 'KILL_SWITCH is on',
      actor: ACTOR,
      blocking: ['KILL_SWITCH'],
    });
    report.runtimeChanged = stopped.moved;
    return report;
  }

  // Health as of the last pass, so a subsystem coming back is observable.
  const previous = new Map((await getSubsystemHealth()).map((h) => [h.subsystem, h]));

  const probes = await probeAll();
  report.checked = probes.length;

  for (const probe of probes) {
    // Recording an OK heartbeat is also what resets consecutive_failures.
    await recordHeartbeat({ subsystem: probe.subsystem, status: probe.status, error: probe.error });
    if (probe.status !== 'OK' && probe.status !== 'UNKNOWN') report.degraded.push(probe.subsystem);

    const before = previous.get(probe.subsystem);
    const wasUnhealthy = before !== undefined && before.status !== 'OK' && before.status !== 'UNKNOWN';
    if (probe.status === 'OK' && wasUnhealthy) {
      report.recovered.push(probe.subsystem);
      const revived = await reviveDependentWork(probe.subsystem);
      if (revived > 0) report.recovered.push(`dead_letter_revived:${revived}`);
    }
  }

  // Recovery the system can always attempt on its own, before anyone is told
  // anything: a crashed runner's lock, and work claimed by a worker that died.
  const locks = await releaseStaleLocks();
  if (locks > 0) report.recovered.push(`stale_job_locks:${locks}`);
  const abandoned = await recoverAbandonedJobs();
  if (abandoned > 0) report.recovered.push(`abandoned_work:${abandoned}`);

  report.runtimeChanged = await reconcileRuntime(probes);

  // Only now, with recovery already attempted, is the owner worth interrupting.
  for (const probe of probes) {
    if (!probe.escalation) continue;
    report.escalations.push({ subsystem: probe.subsystem, reason: probe.escalation.reason });
    await escalate(probe.subsystem, probe.escalation);
  }

  logger.info('watchdog pass complete', {
    checked: report.checked,
    degraded: report.degraded,
    recovered: report.recovered,
    escalations: report.escalations.length,
  });
  return report;
}

export async function releaseStaleLocks(): Promise<number> {
  const db = await getDb();
  // RETURNING because the driver reports rowCount as "rows returned".
  const res = await db.query<{ job: string }>(
    'DELETE FROM job_locks WHERE expires_at < now() RETURNING job',
  );
  const released = res.rows.length;
  if (released > 0) logger.info('released expired job locks', { count: released, jobs: res.rows.map((r) => r.job) });
  return released;
}

export async function recoverAbandonedJobs(): Promise<number> {
  const released = await releaseStaleClaims();

  // A job_runs row left RUNNING is a process that died mid-flight. Closing it
  // out keeps the failure visible instead of looking like a job still working.
  const db = await getDb();
  const cutoff = new Date(Date.now() - ABANDONED_JOB_HOURS * 3_600_000).toISOString();
  const stuck = await db.query<{ id: string }>(
    `UPDATE job_runs
        SET status = 'FAILED',
            completed_at = now(),
            error = COALESCE(error, 'abandoned: the runner never completed')
      WHERE status = 'RUNNING' AND started_at < $1
      RETURNING id`,
    [cutoff],
  );
  return released + stuck.rows.length;
}

// --- probes ------------------------------------------------------------------

/**
 * Every probe is cheap and NON-DESTRUCTIVE: a database ping, and configuration
 * presence for providers. Nothing here sends a test email, and nothing here
 * spends an LLM token — a health check that costs money is a health check that
 * gets turned off.
 */
async function probeAll(): Promise<Probe[]> {
  const cfg = getConfig();
  return [
    await probeDatabase(),
    probeLlm(cfg.llmProvider === 'mock', Boolean(cfg.anthropicApiKey)),
    probeSearch(cfg.searchProvider === 'mock', Boolean(cfg.braveSearchApiKey)),
    probeEmailOut(cfg.emailProvider === 'mock', Boolean(cfg.resendApiKey), cfg.outreachEnabled),
    probeEmailIn(Boolean(cfg.resendInboundWebhookSecret), cfg.outreachEnabled),
    await probeScheduler(cfg.supervisorIntervalMinutes),
  ];
}

async function probeDatabase(): Promise<Probe> {
  const first = await pingDatabase();
  if (first === null) return healthy('database');

  // The one recovery available for a transient connection fault is to try
  // again. Only a second failure is worth the owner's attention.
  const second = await pingDatabase();
  if (second === null) {
    logger.warn('database ping failed once and then succeeded', { error: first });
    return healthy('database');
  }
  return {
    subsystem: 'database',
    status: 'FAILING',
    error: second,
    escalation: {
      code: 'UNREACHABLE',
      kind: 'JOB_FAILURE',
      reason: `database unreachable after a retry: ${second}`,
      remediation: 'Check DATABASE_URL and the database itself, or unset DATABASE_URL to fall back to local PGlite.',
    },
  };
}

async function pingDatabase(): Promise<string | null> {
  try {
    const db = await getDb();
    await db.query('SELECT 1 AS ok');
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function probeLlm(isMock: boolean, hasKey: boolean): Probe {
  if (isMock || hasKey) return healthy('llm');
  // Not an escalation: without a key the pipeline produces synthetic analysis
  // and the deterministic gate still refuses to validate anything.
  return degraded('llm', 'ANTHROPIC_API_KEY is not set; analysis would be synthetic');
}

function probeSearch(isMock: boolean, hasKey: boolean): Probe {
  if (isMock || hasKey) return healthy('search');
  return degraded('search', 'BRAVE_SEARCH_API_KEY is not set; discovery cannot find anything real');
}

function probeEmailOut(isMock: boolean, hasKey: boolean, outreachEnabled: boolean): Probe {
  if (isMock || hasKey) return healthy('email_out');
  if (!outreachEnabled) {
    // Outreach is deliberately off. That is a decision, not a fault.
    return degraded('email_out', 'RESEND_API_KEY is not set (outreach is disabled anyway)');
  }
  return {
    subsystem: 'email_out',
    status: 'FAILING',
    error: 'RESEND_API_KEY is not set while OUTREACH_ENABLED is true',
    escalation: {
      code: 'CREDENTIALS',
      kind: 'CREDENTIAL_FAILURE',
      reason: 'outreach is enabled but the sending credential is missing',
      remediation: 'Set RESEND_API_KEY (SETUP.md step 3), or set OUTREACH_ENABLED=false until you are ready to send.',
    },
  };
}

function probeEmailIn(hasSecret: boolean, outreachEnabled: boolean): Probe {
  if (hasSecret) return healthy('email_in');
  if (!outreachEnabled) {
    return degraded('email_in', 'RESEND_INBOUND_WEBHOOK_SECRET is not set (outreach is disabled anyway)');
  }
  return {
    subsystem: 'email_in',
    status: 'FAILING',
    error: 'RESEND_INBOUND_WEBHOOK_SECRET is not set while OUTREACH_ENABLED is true',
    escalation: {
      code: 'CREDENTIALS',
      kind: 'CREDENTIAL_FAILURE',
      reason: 'outreach is enabled but replies cannot be received',
      remediation: 'Create the Resend inbound webhook and set RESEND_INBOUND_WEBHOOK_SECRET; until then every reply is lost.',
    },
  };
}

/** Progress, not configuration: has anything actually run recently? */
async function probeScheduler(intervalMinutes: number): Promise<Probe> {
  const db = await getDb();
  try {
    const res = await db.query<{ minutes: string | number | null }>(
      `SELECT EXTRACT(EPOCH FROM (now() - MAX(started_at))) / 60 AS minutes FROM job_runs`,
    );
    const raw = res.rows[0]?.minutes;
    if (raw === null || raw === undefined) {
      return { subsystem: 'scheduler', status: 'UNKNOWN', error: 'no job has ever run', escalation: null };
    }
    const minutes = Number(raw);
    const limit = Math.max(1, intervalMinutes) * SCHEDULER_STALE_INTERVALS;
    if (Number.isFinite(minutes) && minutes > limit) {
      // Degraded, never escalated: the owner cannot fix a stalled cron from an
      // email, and the dashboard shows it.
      return degraded('scheduler', `no job has run for ${Math.round(minutes)} minutes`);
    }
    return healthy('scheduler');
  } catch (err) {
    return { subsystem: 'scheduler', status: 'UNKNOWN', error: errorMessage(err), escalation: null };
  }
}

function healthy(subsystem: Subsystem): Probe {
  return { subsystem, status: 'OK', error: null, escalation: null };
}

function degraded(subsystem: Subsystem, error: string): Probe {
  return { subsystem, status: 'DEGRADED', error, escalation: null };
}

// --- recovery and reconciliation ---------------------------------------------

/** Puts work back in the queue once the dependency that killed it is healthy. */
async function reviveDependentWork(subsystem: Subsystem): Promise<number> {
  const dead = await listDeadLetter(200);
  let revived = 0;
  for (const item of dead) {
    if (KIND_DEPENDENCY[item.kind] !== subsystem) continue;
    await reviveDeadLetter(item.id, `dependency ${subsystem} is healthy again`);
    revived += 1;
  }
  if (revived > 0) logger.info('revived dead-letter work', { subsystem, revived });
  return revived;
}

/**
 * Moves the runtime state to match what the probes just saw. A failing
 * subsystem degrades a RUNNING system rather than stopping it; a system that
 * has not started yet gets another chance to start itself.
 */
async function reconcileRuntime(probes: Probe[]): Promise<boolean> {
  const failing = probes.filter((p) => p.status === 'FAILING').map((p) => p.subsystem);
  const snapshot = await getRuntimeState();

  if (RESUMABLE.has(snapshot.state)) {
    // Includes the self-healing path out of BLOCKED_CONFIGURATION: readiness
    // is re-evaluated and a resolved gap promotes to RUNNING with no command.
    const started = await autoStart();
    return started.changed;
  }

  if (snapshot.state === 'RUNNING' && failing.length > 0) {
    const moved = await transitionRuntime({
      to: 'DEGRADED',
      reason: `subsystem not progressing: ${failing.join(', ')}`,
      actor: ACTOR,
      blocking: failing,
    });
    return moved.moved;
  }

  if (snapshot.state === 'DEGRADED' && failing.length === 0) {
    const moved = await transitionRuntime({
      to: 'RUNNING',
      reason: 'every probed subsystem is healthy again',
      actor: ACTOR,
      blocking: [],
    });
    return moved.moved;
  }

  return false;
}

/**
 * One alert per subsystem per fault code, with a stable key: a fault that
 * persists for a week produces one email, not a week of them.
 */
async function escalate(subsystem: Subsystem, escalation: Escalation): Promise<void> {
  const body = [
    `MRR Validator needs you: ${subsystem} is not healthy and could not recover on its own.`,
    '',
    `What happened: ${escalation.reason}`,
    `What to do: ${escalation.remediation}`,
    '',
    'Automatic recovery has already been attempted. Work that depends on this',
    'subsystem is queued or parked in the dead-letter queue and resumes by',
    'itself once the fault clears — you do not need to restart anything.',
  ].join('\n');

  try {
    const res = await notifyOwner({
      kind: escalation.kind,
      subject: `MRR Validator: ${subsystem} needs attention`,
      body,
      dedupeKey: `WATCHDOG:${subsystem}:${escalation.code}`,
      detail: { subsystem, code: escalation.code },
    });
    logger.warn('watchdog escalated to the owner', {
      subsystem,
      code: escalation.code,
      sent: res.sent,
      deduped: res.deduped,
    });
  } catch (err) {
    logger.error('watchdog escalation failed to send', { subsystem, ...errorToFields(err) });
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
