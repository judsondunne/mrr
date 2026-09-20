import { describe, it, expect, afterEach } from 'vitest';
import { freshDb, teardown } from '../helpers.js';
import { acquireLock, withLock } from '../../src/jobs/lock.js';
import { runJobSafely } from '../../src/jobs/runner.js';
import { getDb, toNumber } from '../../src/lib/db.js';
import { BudgetExceededError, SafetyError } from '../../src/lib/errors.js';
import { recordCost } from '../../src/lib/cost.js';

afterEach(async () => { await teardown(); });

describe('job locking', () => {
  it('grants the lock to exactly one holder', async () => {
    await freshDb();
    const first = await acquireLock('discover_opportunities');
    const second = await acquireLock('discover_opportunities');
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    await first!.release();
    const third = await acquireLock('discover_opportunities');
    expect(third).not.toBeNull();
    await third!.release();
  });

  it('does not block a different job', async () => {
    await freshDb();
    const a = await acquireLock('job_a');
    const b = await acquireLock('job_b');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    await a!.release();
    await b!.release();
  });

  it('steals an expired lock so a crashed runner cannot wedge a job forever', async () => {
    await freshDb();
    const held = await acquireLock('stuck_job', 50);
    expect(held).not.toBeNull();
    // Simulate the holder dying: never release, just let the TTL pass.
    const db = await getDb();
    await db.query(`UPDATE job_locks SET expires_at = now() - INTERVAL '1 minute' WHERE job = $1`, ['stuck_job']);
    const stolen = await acquireLock('stuck_job');
    expect(stolen).not.toBeNull();
    await stolen!.release();
  });

  it('releases the lock even when the body throws', async () => {
    await freshDb();
    await expect(
      withLock('boom_job', async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');
    const after = await acquireLock('boom_job');
    expect(after).not.toBeNull();
    await after!.release();
  });

  it('reports ran=false rather than running concurrently', async () => {
    await freshDb();
    const held = await acquireLock('serial_job');
    const attempt = await withLock('serial_job', async () => 'should not run');
    expect(attempt.ran).toBe(false);
    await held!.release();
  });
});

describe('job runner', () => {
  it('records a successful run in job_runs', async () => {
    await freshDb();
    const summary = await runJobSafely('verify_categories', async () => ({ recordsProcessed: 7 }));
    expect(summary.status).toBe('SUCCESS');
    expect(summary.recordsProcessed).toBe(7);

    const db = await getDb();
    const rows = await db.query<{ status: string; records_processed: number }>(
      'SELECT status, records_processed FROM job_runs WHERE job = $1',
      ['verify_categories'],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.status).toBe('SUCCESS');
  });

  it('captures a thrown error as FAILED without taking the process down', async () => {
    await freshDb();
    const summary = await runJobSafely('generate_wedges', async () => {
      throw new Error('parser exploded');
    });
    expect(summary.status).toBe('FAILED');
    expect(summary.error).toContain('parser exploded');

    const db = await getDb();
    const row = await db.query<{ status: string; error: string }>(
      'SELECT status, error FROM job_runs WHERE job = $1',
      ['generate_wedges'],
    );
    expect(row.rows[0]?.status).toBe('FAILED');
  });

  it('halts on budget rather than silently overspending', async () => {
    await freshDb();
    const summary = await runJobSafely('discover_opportunities', async () => {
      throw new BudgetExceededError('LLM', 21, 20);
    });
    expect(summary.status).toBe('HALTED_BUDGET');
    expect(summary.error).toContain('LLM budget exceeded');
  });

  it('treats a safety switch as SKIPPED, not FAILED', async () => {
    await freshDb();
    const summary = await runJobSafely('send_due_messages', async () => {
      throw new SafetyError('OUTREACH_ENABLED is false');
    });
    expect(summary.status).toBe('SKIPPED');
  });

  it('refuses to run anything while KILL_SWITCH is on', async () => {
    await freshDb({ KILL_SWITCH: 'true' });
    let ran = false;
    const summary = await runJobSafely('discover_opportunities', async () => {
      ran = true;
      return { recordsProcessed: 1 };
    });
    expect(ran).toBe(false);
    expect(summary.status).toBe('SKIPPED');
    expect(summary.error).toBe('KILL_SWITCH');
  });

  it('skips when another runner already holds the job lock', async () => {
    await freshDb();
    const held = await acquireLock('qualify_prospects');
    let ran = false;
    const summary = await runJobSafely('qualify_prospects', async () => {
      ran = true;
      return { recordsProcessed: 1 };
    });
    expect(ran).toBe(false);
    expect(summary.status).toBe('SKIPPED');
    expect(summary.error).toBe('LOCKED');
    await held!.release();
  });

  it('attributes cost incurred during the run to that run', async () => {
    await freshDb();
    const summary = await runJobSafely('discover_opportunities', async () => {
      await recordCost({ provider: 'anthropic', resourceType: 'LLM_INPUT_TOKENS', quantity: 1000, estimatedCost: 0.25 });
      return { recordsProcessed: 1 };
    });
    expect(summary.cost).toBeCloseTo(0.25, 6);

    const db = await getDb();
    const row = await db.query<{ cost: string }>('SELECT cost FROM job_runs WHERE job = $1', [
      'discover_opportunities',
    ]);
    expect(toNumber(row.rows[0]?.cost)).toBeCloseTo(0.25, 6);
  });
});
