/** PUBLIC API — AUTOSTART. Owned by the runtime agent. */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getConfig } from '../lib/config';
import { getDb } from '../lib/db';
import { createLogger, errorToFields } from '../lib/logger';
import { runSetupChecks } from '../lib/setup-check';
import { notifyOwner } from '../pipeline/notify/index';
import { getRuntimeState, transitionRuntime } from './runtime';
import type { RuntimeState } from './types';

export interface ReadinessReport {
  ready: boolean;
  blocking: string[];
  /** Exactly one actionable sentence per blocking item. */
  remediation: string[];
}

const logger = createLogger('autonomy:autostart');
const ACTOR = 'autostart';

/** The boot sequence, as the single next step from wherever we are. */
const NEXT_BOOT_STEP: Partial<Record<RuntimeState, RuntimeState>> = {
  BOOTING: 'SELF_TESTING',
  SELF_TESTING: 'SHADOW_VERIFYING',
  SHADOW_VERIFYING: 'RUNNING',
  // Self-healing: a configuration gap that has been closed re-enters the boot
  // sequence on its own. There is no owner command for this.
  BLOCKED_CONFIGURATION: 'SELF_TESTING',
};

const BOOT_REASON: Partial<Record<RuntimeState, string>> = {
  SELF_TESTING: 'readiness checks passed; self-testing',
  SHADOW_VERIFYING: 'self-test passed; verifying against shadow-mode invariants',
  RUNNING: 'shadow verification passed; running autonomously',
};

/**
 * States autostart leaves alone. RUNNING and DEGRADED are already live; the two
 * PAUSED states are held deliberately by the budget and deliverability owners
 * and must not be overridden by a boot sequence.
 */
const NOT_OURS: ReadonlySet<RuntimeState> = new Set<RuntimeState>([
  'RUNNING',
  'DEGRADED',
  'PAUSED_BUDGET',
  'PAUSED_DELIVERABILITY',
]);

/** Non-destructive readiness probe: config + connectivity, no spend, no sends. */
export async function checkReadiness(): Promise<ReadinessReport> {
  const cfg = getConfig();
  const blocking: string[] = [];
  const remediation: string[] = [];

  // The configuration and connectivity checks already exist and are the single
  // source of truth for "configured safely enough to run". Only the
  // safety-critical ones block autonomy: a missing Brave or Anthropic key
  // degrades quality, it does not make the system unsafe.
  const setup = await runSetupChecks();
  for (const check of setup.checks) {
    if (check.ok || !check.safetyCritical) continue;
    blocking.push(check.name);
    remediation.push(check.remediation);
  }

  // Beyond setup-check: the schema must actually be current. A half-migrated
  // database passes "can I see the opportunities table" and then fails at the
  // first insert into a table it has never heard of.
  const pending = await pendingMigrations();
  if (pending.length > 0) {
    blocking.push('MIGRATIONS');
    remediation.push(`Run: npm run migrate — ${pending.length} migration(s) are not applied (${pending.join(', ')}).`);
  }

  // And the owner has to have said yes. This is a control-plane switch: no
  // amount of healthy infrastructure substitutes for it.
  if (!cfg.autonomyEnabled) {
    blocking.push('AUTONOMY_ENABLED');
    remediation.push('Run: npm run autonomy:enable (sets AUTONOMY_ENABLED=true) when you want the system to act on its own.');
  }

  return { ready: blocking.length === 0, blocking, remediation };
}

/**
 * Drives BOOTING → SELF_TESTING → SHADOW_VERIFYING → RUNNING, or parks in
 * BLOCKED_CONFIGURATION with ONE actionable owner notification. Idempotent and
 * safe to call on every supervisor tick: once the missing dependency becomes
 * healthy it promotes to RUNNING with no owner command.
 */
export async function autoStart(): Promise<{ state: RuntimeState; changed: boolean }> {
  const cfg = getConfig();
  let changed = false;
  let snapshot = await getRuntimeState();

  // The kill switch outranks everything, from any state.
  if (cfg.killSwitch) {
    const stopped = await transitionRuntime({
      to: 'EMERGENCY_STOP',
      reason: 'KILL_SWITCH is on',
      actor: ACTOR,
      blocking: ['KILL_SWITCH'],
    });
    return { state: 'EMERGENCY_STOP', changed: stopped.moved };
  }

  // Kill switch cleared: the only way out of EMERGENCY_STOP is a fresh boot,
  // which then has to pass readiness again like any other start.
  if (snapshot.state === 'EMERGENCY_STOP') {
    const rebooted = await transitionRuntime({
      to: 'BOOTING',
      reason: 'KILL_SWITCH cleared; rebooting',
      actor: ACTOR,
    });
    changed = changed || rebooted.moved;
    snapshot = await getRuntimeState();
  }

  if (!cfg.autoStart) {
    logger.debug('AUTO_START is false; leaving the runtime where it is', { state: snapshot.state });
    return { state: snapshot.state, changed };
  }

  if (NOT_OURS.has(snapshot.state)) return { state: snapshot.state, changed };

  const readiness = await checkReadiness();
  if (!readiness.ready) {
    const parked = await transitionRuntime({
      to: 'BLOCKED_CONFIGURATION',
      reason: `blocked on configuration: ${readiness.blocking.join(', ')}`,
      actor: ACTOR,
      blocking: readiness.blocking,
      detail: { remediation: readiness.remediation },
    });
    changed = changed || parked.moved;
    await alertBlocked(readiness);
    return { state: 'BLOCKED_CONFIGURATION', changed };
  }

  // Ready. Walk the boot sequence to RUNNING, auditing each edge. The loop is
  // bounded by the length of the sequence so a table change can never spin.
  let state = snapshot.state;
  for (let step = 0; step < Object.keys(NEXT_BOOT_STEP).length + 1 && state !== 'RUNNING'; step += 1) {
    const next = NEXT_BOOT_STEP[state];
    if (!next) break;
    const moved = await transitionRuntime({
      to: next,
      reason: BOOT_REASON[next] ?? 'boot sequence',
      actor: ACTOR,
      blocking: [],
    });
    changed = changed || moved.moved;
    state = next;
  }

  return { state, changed };
}

// --- internals ---------------------------------------------------------------

/**
 * One alert per distinct set of gaps, forever. The key is derived from the
 * SORTED blocking list, so the same gap reported on every supervisor tick
 * never produces a second email — and a genuinely different gap still does.
 */
async function alertBlocked(readiness: ReadinessReport): Promise<void> {
  const dedupeKey = `AUTOSTART_BLOCKED:${[...readiness.blocking].sort().join('|')}`;
  const lines = readiness.blocking.map(
    (item, i) => `- ${item}: ${readiness.remediation[i] ?? 'See SETUP.md.'}`,
  );
  const body = [
    'MRR Validator is configured to start itself but cannot yet.',
    '',
    'Blocking:',
    ...lines,
    '',
    'Nothing has been sent and nothing has been spent. Readiness is re-checked',
    'on every supervisor tick and the system starts itself as soon as these are',
    'resolved — there is no command to run afterwards.',
  ].join('\n');

  try {
    const res = await notifyOwner({
      kind: 'CREDENTIAL_FAILURE',
      subject: 'MRR Validator: blocked on configuration',
      body,
      dedupeKey,
      detail: { blocking: readiness.blocking },
    });
    logger.info('configuration block reported', {
      blocking: readiness.blocking,
      sent: res.sent,
      deduped: res.deduped,
    });
  } catch (err) {
    // A broken notifier must never stop the system from parking safely.
    logger.error('failed to alert the owner about a configuration block', errorToFields(err));
  }
}

/** Migration filenames present on disk that the database has not applied. */
async function pendingMigrations(): Promise<string[]> {
  let files: string[];
  try {
    files = (await readdir(join(process.cwd(), 'migrations')))
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch {
    // No readable migrations directory (a bundled deployment, for instance).
    // Absence of evidence is not evidence of a missing migration.
    logger.debug('migrations directory is not readable; skipping the migration check');
    return [];
  }

  try {
    const db = await getDb();
    const res = await db.query<{ version: string }>('SELECT version FROM schema_migrations');
    const applied = new Set(res.rows.map((r) => r.version));
    return files.filter((f) => !applied.has(f));
  } catch (err) {
    logger.warn('cannot read schema_migrations; treating every migration as pending', errorToFields(err));
    return files;
  }
}
