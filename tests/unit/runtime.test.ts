/**
 * The runtime state machine and autostart.
 *
 * The property these tests exist to protect: the system decides for itself
 * when it may run, parks safely when it may not, tells the owner exactly once,
 * and starts itself again the moment the gap is closed — with no command.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { freshDb, teardown } from '../helpers';
import {
  canRuntimeTransition,
  getRuntimeState,
  getSubsystemHealth,
  isOperational,
  recordHeartbeat,
  transitionRuntime,
} from '../../src/autonomy/runtime';
import { autoStart, checkReadiness } from '../../src/autonomy/autostart';
import { RUNTIME_STATES, type RuntimeState } from '../../src/autonomy/types';
import { getDb } from '../../src/lib/db';
import { resetConfigCache } from '../../src/lib/config';
import { IllegalTransitionError } from '../../src/lib/errors';

afterEach(async () => { await teardown(); });

/** Everything runSetupChecks calls safety-critical, plus the autonomy switch. */
const READY_ENV: Record<string, string> = {
  AUTONOMY_ENABLED: 'true',
  EMAIL_PROVIDER: 'resend',
  RESEND_API_KEY: 're_test_key_not_real',
  RESEND_WEBHOOK_SECRET: 'whsec_test_not_real',
  RESEND_INBOUND_WEBHOOK_SECRET: 'whsec_inbound_not_real',
  CRON_SECRET: '0123456789abcdef0123456789abcdef',
  ADMIN_TOKEN: 'fedcba9876543210fedcba9876543210',
  UNSUBSCRIBE_SECRET: 'abcdef0123456789abcdef0123456789',
  PUBLIC_BASE_URL: 'https://validator.example.com',
  SENDING_DOMAIN: 'validator.example.com',
  SENDER_EMAIL: 'founder@validator.example.com',
  SENDER_COMPANY: 'Validator Labs LLC',
  SENDER_POSTAL_ADDRESS: '1 Test Street, Boston MA 02108',
  OWNER_NAME: 'Owner',
  OWNER_NOTIFICATION_EMAIL: 'owner@example.com',
};

/** Applies the remaining ready-env values to a process already booted without them. */
function becomeReady(): void {
  for (const [k, v] of Object.entries(READY_ENV)) process.env[k] = v;
  resetConfigCache();
}

async function countAudits(): Promise<number> {
  const db = await getDb();
  const res = await db.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM audit_events WHERE entity_type = 'system' AND event_type = 'STATE_TRANSITION'`,
  );
  return Number(res.rows[0]?.n ?? 0);
}

async function notifications(): Promise<Array<{ kind: string; dedupe_key: string }>> {
  const db = await getDb();
  const res = await db.query<{ kind: string; dedupe_key: string }>(
    'SELECT kind, dedupe_key FROM owner_notifications ORDER BY created_at ASC',
  );
  return res.rows;
}

/** Walks the runtime from BOOTING to `target` using only legal edges. */
async function driveTo(target: RuntimeState): Promise<void> {
  const path: Record<string, RuntimeState[]> = {
    SELF_TESTING: ['SELF_TESTING'],
    SHADOW_VERIFYING: ['SELF_TESTING', 'SHADOW_VERIFYING'],
    RUNNING: ['SELF_TESTING', 'SHADOW_VERIFYING', 'RUNNING'],
    DEGRADED: ['SELF_TESTING', 'SHADOW_VERIFYING', 'RUNNING', 'DEGRADED'],
    PAUSED_BUDGET: ['SELF_TESTING', 'SHADOW_VERIFYING', 'RUNNING', 'PAUSED_BUDGET'],
    PAUSED_DELIVERABILITY: ['SELF_TESTING', 'SHADOW_VERIFYING', 'RUNNING', 'PAUSED_DELIVERABILITY'],
    BLOCKED_CONFIGURATION: ['BLOCKED_CONFIGURATION'],
    EMERGENCY_STOP: ['EMERGENCY_STOP'],
  };
  for (const step of path[target] ?? []) {
    await transitionRuntime({ to: step, reason: 'test setup', actor: 'test' });
  }
}

describe('the runtime edge table', () => {
  it('accepts the boot sequence and nothing that skips a step', () => {
    expect(canRuntimeTransition('BOOTING', 'SELF_TESTING')).toBe(true);
    expect(canRuntimeTransition('SELF_TESTING', 'SHADOW_VERIFYING')).toBe(true);
    expect(canRuntimeTransition('SHADOW_VERIFYING', 'RUNNING')).toBe(true);

    expect(canRuntimeTransition('BOOTING', 'RUNNING')).toBe(false);
    expect(canRuntimeTransition('BOOTING', 'SHADOW_VERIFYING')).toBe(false);
    expect(canRuntimeTransition('SELF_TESTING', 'RUNNING')).toBe(false);
  });

  it('lets any boot state park in BLOCKED_CONFIGURATION and self-heal out of it', () => {
    for (const from of ['BOOTING', 'SELF_TESTING', 'SHADOW_VERIFYING'] as const) {
      expect(canRuntimeTransition(from, 'BLOCKED_CONFIGURATION')).toBe(true);
    }
    // Self-healing: back into the boot sequence, not straight to RUNNING.
    expect(canRuntimeTransition('BLOCKED_CONFIGURATION', 'SELF_TESTING')).toBe(true);
    expect(canRuntimeTransition('BLOCKED_CONFIGURATION', 'RUNNING')).toBe(false);
    expect(canRuntimeTransition('RUNNING', 'BLOCKED_CONFIGURATION')).toBe(false);
  });

  it('swaps RUNNING and DEGRADED, and pauses and resumes', () => {
    expect(canRuntimeTransition('RUNNING', 'DEGRADED')).toBe(true);
    expect(canRuntimeTransition('DEGRADED', 'RUNNING')).toBe(true);
    for (const from of ['RUNNING', 'DEGRADED'] as const) {
      expect(canRuntimeTransition(from, 'PAUSED_BUDGET')).toBe(true);
      expect(canRuntimeTransition(from, 'PAUSED_DELIVERABILITY')).toBe(true);
    }
    expect(canRuntimeTransition('PAUSED_BUDGET', 'RUNNING')).toBe(true);
    expect(canRuntimeTransition('PAUSED_DELIVERABILITY', 'RUNNING')).toBe(true);
  });

  it('reaches EMERGENCY_STOP from everywhere and leaves it only by booting', () => {
    for (const from of RUNTIME_STATES) {
      expect(canRuntimeTransition(from, 'EMERGENCY_STOP'), `${from} -> EMERGENCY_STOP`).toBe(true);
    }
    expect(canRuntimeTransition('EMERGENCY_STOP', 'BOOTING')).toBe(true);
    for (const to of ['SELF_TESTING', 'SHADOW_VERIFYING', 'RUNNING', 'DEGRADED', 'PAUSED_BUDGET'] as const) {
      expect(canRuntimeTransition('EMERGENCY_STOP', to), `EMERGENCY_STOP -> ${to}`).toBe(false);
    }
  });

  it('rejects going backwards through the boot sequence', () => {
    expect(canRuntimeTransition('RUNNING', 'BOOTING')).toBe(false);
    expect(canRuntimeTransition('RUNNING', 'SELF_TESTING')).toBe(false);
    expect(canRuntimeTransition('SHADOW_VERIFYING', 'SELF_TESTING')).toBe(false);
    expect(canRuntimeTransition('PAUSED_BUDGET', 'DEGRADED')).toBe(false);
  });
});

describe('transitionRuntime', () => {
  it('persists the state and audits every move', async () => {
    await freshDb();
    expect((await getRuntimeState()).state).toBe('BOOTING');

    const moved = await transitionRuntime({
      to: 'SELF_TESTING',
      reason: 'readiness passed',
      actor: 'test',
      detail: { probe: 'db' },
    });
    expect(moved).toEqual({ moved: true, from: 'BOOTING' });

    const snapshot = await getRuntimeState();
    expect(snapshot.state).toBe('SELF_TESTING');
    expect(snapshot.reason).toBe('readiness passed');

    const db = await getDb();
    const audit = await db.query<{ from_state: string; to_state: string; actor: string; reason: string }>(
      `SELECT from_state, to_state, actor, reason FROM audit_events
        WHERE entity_type = 'system' AND event_type = 'STATE_TRANSITION'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      from_state: 'BOOTING',
      to_state: 'SELF_TESTING',
      actor: 'test',
      reason: 'readiness passed',
    });
  });

  it('refuses an edge that is not in the table and leaves the state alone', async () => {
    await freshDb();
    await expect(
      transitionRuntime({ to: 'RUNNING', reason: 'skip the queue', actor: 'test' }),
    ).rejects.toThrow(IllegalTransitionError);

    expect((await getRuntimeState()).state).toBe('BOOTING');
    expect(await countAudits()).toBe(0);
  });

  it('treats a repeat of the current state as a no-op but refreshes the blocking list', async () => {
    await freshDb();
    await driveTo('BLOCKED_CONFIGURATION');
    const before = await countAudits();

    const again = await transitionRuntime({
      to: 'BLOCKED_CONFIGURATION',
      reason: 'still blocked',
      actor: 'test',
      blocking: ['CRON', 'DOMAIN'],
    });
    expect(again.moved).toBe(false);
    expect((await getRuntimeState()).blocking).toEqual(['CRON', 'DOMAIN']);
    expect(await countAudits()).toBe(before);
  });

  it('records the blocking list so the dashboard can show why', async () => {
    await freshDb();
    await transitionRuntime({
      to: 'BLOCKED_CONFIGURATION',
      reason: 'missing credentials',
      actor: 'test',
      blocking: ['RESEND SEND'],
    });
    const snapshot = await getRuntimeState();
    expect(snapshot.blocking).toEqual(['RESEND SEND']);
    expect(snapshot.enteredAt).toBeInstanceOf(Date);
  });
});

describe('isOperational', () => {
  it('is true only in RUNNING and DEGRADED', async () => {
    await freshDb();
    expect(await isOperational()).toBe(false); // BOOTING

    await driveTo('RUNNING');
    expect(await isOperational()).toBe(true);

    await transitionRuntime({ to: 'DEGRADED', reason: 'db slow', actor: 'test' });
    expect(await isOperational()).toBe(true);

    await transitionRuntime({ to: 'PAUSED_BUDGET', reason: 'budget spent', actor: 'test' });
    expect(await isOperational()).toBe(false);
  });

  it('is false while KILL_SWITCH is on, whatever the persisted state says', async () => {
    await freshDb();
    await driveTo('RUNNING');
    expect(await isOperational()).toBe(true);

    process.env.KILL_SWITCH = 'true';
    resetConfigCache();
    expect(await isOperational()).toBe(false);
  });
});

describe('subsystem heartbeats', () => {
  it('counts consecutive failures and resets the count on OK', async () => {
    await freshDb();
    await recordHeartbeat({ subsystem: 'search', status: 'FAILING', error: 'timeout' });
    await recordHeartbeat({ subsystem: 'search', status: 'FAILING', error: 'timeout again' });
    await recordHeartbeat({ subsystem: 'search', status: 'DEGRADED', error: 'slow' });

    let health = (await getSubsystemHealth()).find((h) => h.subsystem === 'search');
    expect(health?.consecutiveFailures).toBe(3);
    expect(health?.status).toBe('DEGRADED');
    expect(health?.lastError).toBe('slow');
    expect(health?.lastOkAt).toBeNull();

    await recordHeartbeat({ subsystem: 'search', status: 'OK' });
    health = (await getSubsystemHealth()).find((h) => h.subsystem === 'search');
    expect(health?.consecutiveFailures).toBe(0);
    expect(health?.status).toBe('OK');
    expect(health?.lastOkAt).toBeInstanceOf(Date);
  });

  it('keeps one row per subsystem', async () => {
    await freshDb();
    await recordHeartbeat({ subsystem: 'database', status: 'OK' });
    await recordHeartbeat({ subsystem: 'database', status: 'OK' });
    await recordHeartbeat({ subsystem: 'llm', status: 'OK' });
    const health = await getSubsystemHealth();
    expect(health.map((h) => h.subsystem)).toEqual(['database', 'llm']);
  });
});

describe('checkReadiness', () => {
  it('reuses the setup checks and reports one remediation per blocking item', async () => {
    await freshDb();
    const report = await checkReadiness();
    expect(report.ready).toBe(false);
    expect(report.blocking.length).toBe(report.remediation.length);
    expect(report.blocking).toContain('AUTONOMY_ENABLED');
    // Names come from runSetupChecks, which is not re-implemented here.
    expect(report.blocking).toContain('CRON');
    expect(report.remediation.every((r) => r.trim().length > 0)).toBe(true);
  });

  it('passes once every safety-critical check and the autonomy switch are set', async () => {
    await freshDb(READY_ENV);
    const report = await checkReadiness();
    expect(report.blocking).toEqual([]);
    expect(report.ready).toBe(true);
  });

  it('blocks on a schema that is behind the migrations on disk', async () => {
    const { db } = await freshDb(READY_ENV);
    await db.query(`DELETE FROM schema_migrations WHERE version = $1`, ['0002_autonomy.sql']);

    const report = await checkReadiness();
    expect(report.ready).toBe(false);
    expect(report.blocking).toContain('MIGRATIONS');
    expect(report.remediation.join(' ')).toContain('npm run migrate');
  });
});

describe('autoStart', () => {
  it('parks in BLOCKED_CONFIGURATION and tells the owner exactly once', async () => {
    const ctx = await freshDb({ OWNER_NOTIFICATION_EMAIL: 'owner@example.com', OWNER_NAME: 'Owner' });

    const first = await autoStart();
    expect(first.state).toBe('BLOCKED_CONFIGURATION');
    expect(first.changed).toBe(true);
    expect((await getRuntimeState()).blocking.length).toBeGreaterThan(0);

    const second = await autoStart();
    expect(second.state).toBe('BLOCKED_CONFIGURATION');
    expect(second.changed).toBe(false);

    const alerts = await notifications();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.kind).toBe('CREDENTIAL_FAILURE');
    expect(ctx.email.sent).toHaveLength(1);
  });

  it('promotes BLOCKED_CONFIGURATION to RUNNING on its own, with no second notification', async () => {
    const ctx = await freshDb({ OWNER_NOTIFICATION_EMAIL: 'owner@example.com', OWNER_NAME: 'Owner' });
    expect((await autoStart()).state).toBe('BLOCKED_CONFIGURATION');
    expect(ctx.email.sent).toHaveLength(1);

    // The owner fixes the configuration. Nobody runs a command.
    becomeReady();

    const resumed = await autoStart();
    expect(resumed.state).toBe('RUNNING');
    expect(resumed.changed).toBe(true);
    expect(await isOperational()).toBe(true);
    expect(ctx.email.sent).toHaveLength(1);
    expect(await notifications()).toHaveLength(1);

    const db = await getDb();
    const audit = await db.query<{ from_state: string; to_state: string }>(
      `SELECT from_state, to_state FROM audit_events
        WHERE entity_type = 'system' AND event_type = 'STATE_TRANSITION'
        ORDER BY created_at ASC`,
    );
    expect(audit.rows.map((r) => `${r.from_state}->${r.to_state}`)).toEqual([
      'BOOTING->BLOCKED_CONFIGURATION',
      'BLOCKED_CONFIGURATION->SELF_TESTING',
      'SELF_TESTING->SHADOW_VERIFYING',
      'SHADOW_VERIFYING->RUNNING',
    ]);
  });

  it('drives the whole boot sequence when everything is ready, and is then idempotent', async () => {
    const ctx = await freshDb(READY_ENV);

    const booted = await autoStart();
    expect(booted).toEqual({ state: 'RUNNING', changed: true });
    expect(await countAudits()).toBe(3);

    const again = await autoStart();
    expect(again).toEqual({ state: 'RUNNING', changed: false });
    expect(await countAudits()).toBe(3);
    expect(ctx.email.sent).toEqual([]);
    expect(ctx.llm.calls).toEqual([]);
  });

  it('alerts again only when the set of gaps is genuinely different', async () => {
    const ctx = await freshDb({ OWNER_NOTIFICATION_EMAIL: 'owner@example.com', OWNER_NAME: 'Owner' });
    await autoStart();
    expect(ctx.email.sent).toHaveLength(1);

    // Close every gap but one: a different blocking set, so a different alert.
    becomeReady();
    delete process.env.CRON_SECRET;
    resetConfigCache();

    const still = await autoStart();
    expect(still.state).toBe('BLOCKED_CONFIGURATION');
    expect((await getRuntimeState()).blocking).toEqual(['CRON']);
    const alerts = await notifications();
    expect(alerts).toHaveLength(2);
    expect(alerts[1]?.dedupe_key).toBe('AUTOSTART_BLOCKED:CRON');
  });

  it('forces EMERGENCY_STOP while KILL_SWITCH is on, from any state', async () => {
    await freshDb(READY_ENV);
    expect((await autoStart()).state).toBe('RUNNING');

    process.env.KILL_SWITCH = 'true';
    resetConfigCache();

    const stopped = await autoStart();
    expect(stopped.state).toBe('EMERGENCY_STOP');
    expect(stopped.changed).toBe(true);
    expect(await isOperational()).toBe(false);

    // Still stopped, and no second audit row for the same state.
    const audits = await countAudits();
    expect((await autoStart()).state).toBe('EMERGENCY_STOP');
    expect(await countAudits()).toBe(audits);
  });

  it('reboots through the full sequence once KILL_SWITCH is cleared', async () => {
    await freshDb({ ...READY_ENV, KILL_SWITCH: 'true' });
    expect((await autoStart()).state).toBe('EMERGENCY_STOP');

    process.env.KILL_SWITCH = 'false';
    resetConfigCache();

    const restarted = await autoStart();
    expect(restarted.state).toBe('RUNNING');

    const db = await getDb();
    const audit = await db.query<{ from_state: string; to_state: string }>(
      `SELECT from_state, to_state FROM audit_events
        WHERE entity_type = 'system' AND event_type = 'STATE_TRANSITION'
        ORDER BY created_at ASC`,
    );
    expect(audit.rows.map((r) => `${r.from_state}->${r.to_state}`)).toEqual([
      'BOOTING->EMERGENCY_STOP',
      'EMERGENCY_STOP->BOOTING',
      'BOOTING->SELF_TESTING',
      'SELF_TESTING->SHADOW_VERIFYING',
      'SHADOW_VERIFYING->RUNNING',
    ]);
  });

  it('leaves a deliberately paused runtime alone', async () => {
    await freshDb(READY_ENV);
    await driveTo('PAUSED_BUDGET');

    const result = await autoStart();
    expect(result).toEqual({ state: 'PAUSED_BUDGET', changed: false });
  });

  it('does nothing at all when AUTO_START is off', async () => {
    await freshDb({ ...READY_ENV, AUTO_START: 'false' });
    try {
      const result = await autoStart();
      expect(result).toEqual({ state: 'BOOTING', changed: false });
      expect(await countAudits()).toBe(0);
    } finally {
      // AUTO_START is not in the helper's resettable list; clear it here so it
      // cannot silently disable autostart for a later test.
      delete process.env.AUTO_START;
      resetConfigCache();
    }
  });
});
