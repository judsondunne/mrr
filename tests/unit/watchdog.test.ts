/**
 * The watchdog.
 *
 * The properties these tests exist to protect: probes cost nothing and send
 * nothing, the system fixes what it can by itself, and the owner is
 * interrupted only when it cannot — once per fault, not once per pass.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { freshDb, teardown, treatEmailAsDelivered } from '../helpers';
import { recoverAbandonedJobs, releaseStaleLocks, runWatchdog } from '../../src/autonomy/watchdog';
import { autoStart } from '../../src/autonomy/autostart';
import { getRuntimeState, getSubsystemHealth, recordHeartbeat } from '../../src/autonomy/runtime';
import { claimNext, enqueue, failWork, queueDepth } from '../../src/autonomy/queue';
import { getDb, setDbForTesting, type Db, type QueryResult } from '../../src/lib/db';
import { resetConfigCache } from '../../src/lib/config';

afterEach(async () => { await teardown(); });

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

/**
 * Wraps the real handle so that only the watchdog's health ping fails. Every
 * other query — audit, notification, heartbeat — still works, which is exactly
 * the situation the escalation path has to behave well in.
 */
function withFailingPings(real: Db, failures: number): Db {
  let remaining = failures;
  return {
    kind: real.kind,
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
      if (sql.includes('SELECT 1 AS ok') && remaining > 0) {
        remaining -= 1;
        throw new Error('connection refused');
      }
      return real.query<T>(sql, params);
    },
    transaction: (fn) => real.transaction(fn),
    close: () => real.close(),
  };
}

async function watchdogAlerts(): Promise<Array<{ kind: string; dedupe_key: string }>> {
  const db = await getDb();
  const res = await db.query<{ kind: string; dedupe_key: string }>(
    `SELECT kind, dedupe_key FROM owner_notifications WHERE dedupe_key LIKE 'WATCHDOG:%' ORDER BY created_at ASC`,
  );
  return res.rows;
}

async function insertExpiredLock(job: string): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO job_locks (job, locked_at, locked_by, expires_at)
     VALUES ($1, now() - INTERVAL '2 hours', 'dead-runner', now() - INTERVAL '1 hour')`,
    [job],
  );
}

describe('cheap, non-destructive probing', () => {
  it('records a heartbeat per subsystem without sending or spending anything', async () => {
    const ctx = await freshDb(READY_ENV);
    const report = await runWatchdog();

    expect(report.checked).toBeGreaterThanOrEqual(6);
    const health = await getSubsystemHealth();
    expect(health.map((h) => h.subsystem)).toContain('database');
    expect(health.find((h) => h.subsystem === 'database')?.status).toBe('OK');

    // A health check that costs money is a health check that gets turned off.
    expect(ctx.llm.calls).toEqual([]);
    expect(ctx.search.queries).toEqual([]);
    expect(ctx.email.sent).toEqual([]);
    expect(report.escalations).toEqual([]);
  });

  it('treats deliberately disabled outreach as a decision, not a fault', async () => {
    const ctx = await freshDb();
    const report = await runWatchdog();
    expect(report.escalations).toEqual([]);
    expect(ctx.email.sent.filter((e) => e.subject.includes('needs attention'))).toEqual([]);
  });
});

describe('self-recovery before escalation', () => {
  it('fixes stale locks and abandoned work without telling anyone', async () => {
    const ctx = await freshDb(READY_ENV);
    expect((await autoStart()).state).toBe('RUNNING');

    await insertExpiredLock('send_due_messages');
    const { id } = await enqueue({ kind: 'QUALIFY_PROSPECTS', priority: 5, idempotencyKey: 'abandoned' });
    await claimNext('worker-that-dies');
    const db = await getDb();
    await db.query(`UPDATE work_queue SET locked_until = now() - INTERVAL '1 minute' WHERE id = $1`, [id]);

    const report = await runWatchdog();

    expect(report.recovered).toContain('stale_job_locks:1');
    expect(report.recovered).toContain('abandoned_work:1');
    expect(report.escalations).toEqual([]);
    expect(await watchdogAlerts()).toEqual([]);
    expect(ctx.email.sent).toEqual([]);
    expect(await queueDepth()).toMatchObject({ PENDING: 1, RUNNING: 0 });
    expect((await getRuntimeState()).state).toBe('RUNNING');
  });

  it('does not escalate a database blip that the retry clears', async () => {
    const ctx = await freshDb(READY_ENV);
    const real = await getDb();
    setDbForTesting(withFailingPings(real, 1));

    const report = await runWatchdog();

    expect(report.escalations).toEqual([]);
    expect(await watchdogAlerts()).toEqual([]);
    expect(ctx.email.sent).toEqual([]);
    expect((await getSubsystemHealth()).find((h) => h.subsystem === 'database')?.status).toBe('OK');
  });

  it('escalates once, not once per pass, when recovery keeps failing', async () => {
    const ctx = await freshDb(READY_ENV);
    // An alert only stops repeating once it has actually been delivered; a
    // simulated send does not consume the claim.
    treatEmailAsDelivered();
    expect((await autoStart()).state).toBe('RUNNING');
    const real = await getDb();
    setDbForTesting(withFailingPings(real, Number.MAX_SAFE_INTEGER));

    const first = await runWatchdog();
    expect(first.degraded).toContain('database');
    expect(first.escalations).toEqual([{ subsystem: 'database', reason: expect.stringContaining('unreachable') }]);

    const second = await runWatchdog();
    // The fault is still reported to the caller...
    expect(second.escalations).toHaveLength(1);
    // ...but the owner's inbox sees it exactly once.
    const alerts = await watchdogAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.dedupe_key).toBe('WATCHDOG:database:UNREACHABLE');
    expect(ctx.email.sent).toHaveLength(1);
    expect(ctx.email.sent[0]?.subject).toContain('database needs attention');
  });

  it('escalates a missing credential the system cannot supply for itself', async () => {
    const ctx = await freshDb({ ...READY_ENV, RESEND_API_KEY: '', OUTREACH_ENABLED: 'true' });

    const report = await runWatchdog();

    expect(report.escalations.map((e) => e.subsystem)).toContain('email_out');
    const alerts = await watchdogAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'CREDENTIAL_FAILURE', dedupe_key: 'WATCHDOG:email_out:CREDENTIALS' });

    await runWatchdog();
    // ONE durable alert row, deduped by key, is what the dashboard shows and
    // what stops the owner being spammed.
    expect(await watchdogAlerts()).toHaveLength(1);

    // The send, however, is retried every pass — and must be. This alert is
    // ABOUT the missing sending credential, so it cannot be delivered yet;
    // consuming the claim on a failed send would mean the owner is never told,
    // including after they fix the key. Retrying is what makes the fix land.
    expect(ctx.email.sent.filter((e) => e.subject.includes('email_out')).length).toBeGreaterThanOrEqual(1);
  });
});

describe('runtime state follows the subsystems', () => {
  it('degrades a running system when a subsystem stops progressing, and restores it', async () => {
    await freshDb(READY_ENV);
    expect((await autoStart()).state).toBe('RUNNING');

    const real = await getDb();
    setDbForTesting(withFailingPings(real, Number.MAX_SAFE_INTEGER));
    const degradedPass = await runWatchdog();
    expect(degradedPass.runtimeChanged).toBe(true);
    expect((await getRuntimeState()).state).toBe('DEGRADED');

    setDbForTesting(real);
    const recoveredPass = await runWatchdog();
    expect(recoveredPass.recovered).toContain('database');
    expect(recoveredPass.runtimeChanged).toBe(true);
    expect((await getRuntimeState()).state).toBe('RUNNING');
  });

  it('starts a system that has not started yet, with no owner command', async () => {
    await freshDb(READY_ENV);
    expect((await getRuntimeState()).state).toBe('BOOTING');

    const report = await runWatchdog();

    expect(report.runtimeChanged).toBe(true);
    expect((await getRuntimeState()).state).toBe('RUNNING');
  });

  it('forces EMERGENCY_STOP while KILL_SWITCH is on and probes nothing', async () => {
    await freshDb(READY_ENV);
    expect((await autoStart()).state).toBe('RUNNING');

    process.env.KILL_SWITCH = 'true';
    resetConfigCache();

    const report = await runWatchdog();
    expect(report.checked).toBe(0);
    expect(report.runtimeChanged).toBe(true);
    expect((await getRuntimeState()).state).toBe('EMERGENCY_STOP');
  });
});

describe('dead-letter revival', () => {
  it('puts work back once the dependency that killed it is healthy again', async () => {
    await freshDb(READY_ENV);
    // The last pass saw search failing; the item died because of it.
    await recordHeartbeat({ subsystem: 'search', status: 'FAILING', error: 'provider 503' });
    const { id } = await enqueue({
      kind: 'DISCOVER_PROSPECTS',
      priority: 5,
      idempotencyKey: 'discover-prospects:1',
      maxAttempts: 1,
    });
    await claimNext('w');
    expect((await failWork(id, 'search provider 503')).deadLettered).toBe(true);

    const report = await runWatchdog();

    expect(report.recovered).toContain('search');
    expect(report.recovered).toContain('dead_letter_revived:1');
    expect(await queueDepth()).toMatchObject({ PENDING: 1, DEAD_LETTER: 0 });
  });

  it('leaves dead-letter work parked while its dependency is still down', async () => {
    await freshDb({ ...READY_ENV, RESEND_API_KEY: '', OUTREACH_ENABLED: 'true' });
    const { id } = await enqueue({
      kind: 'SEND_DUE_MESSAGES',
      priority: 3,
      idempotencyKey: 'send:1',
      maxAttempts: 1,
    });
    await claimNext('w');
    await failWork(id, 'no sending credential');

    await runWatchdog();

    expect(await queueDepth()).toMatchObject({ DEAD_LETTER: 1, PENDING: 0 });
  });
});

describe('the recovery primitives', () => {
  it('releases expired job locks and keeps live ones', async () => {
    await freshDb();
    await insertExpiredLock('discover_opportunities');
    const db = await getDb();
    await db.query(
      `INSERT INTO job_locks (job, locked_at, locked_by, expires_at)
       VALUES ('verify_categories', now(), 'live-runner', now() + INTERVAL '10 minutes')`,
    );

    expect(await releaseStaleLocks()).toBe(1);
    const left = await db.query<{ job: string }>('SELECT job FROM job_locks');
    expect(left.rows.map((r) => r.job)).toEqual(['verify_categories']);
  });

  it('closes out a job_runs row left behind by a dead runner', async () => {
    await freshDb();
    const db = await getDb();
    await db.query(
      `INSERT INTO job_runs (id, job, started_at, status)
       VALUES ('run_abandoned', 'send_due_messages', now() - INTERVAL '3 hours', 'RUNNING'),
              ('run_live', 'verify_categories', now(), 'RUNNING')`,
    );

    expect(await recoverAbandonedJobs()).toBe(1);

    const rows = await db.query<{ id: string; status: string; error: string | null }>(
      'SELECT id, status, error FROM job_runs ORDER BY id',
    );
    expect(rows.rows).toEqual([
      { id: 'run_abandoned', status: 'FAILED', error: 'abandoned: the runner never completed' },
      { id: 'run_live', status: 'RUNNING', error: null },
    ]);
  });
});
