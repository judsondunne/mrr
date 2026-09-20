/**
 * Job locking and idempotency.
 *
 * CRITICAL: duplicate scheduler executions must never cause duplicate emails.
 * Two defences, both required:
 *   1. This lock — only one runner may hold a job name at a time.
 *   2. Per-message idempotency keys in the outreach layer (unique index).
 *
 * The lock is a row with an expiry, acquired with a conditional INSERT/UPDATE
 * so the database — not application timing — decides the winner.
 */
import { getDb } from '../lib/db';
import { createLogger } from '../lib/logger';
import { randomUUID } from 'node:crypto';

const logger = createLogger('jobs:lock');

const DEFAULT_TTL_MS = 15 * 60_000;

export interface LockHandle {
  job: string;
  owner: string;
  release(): Promise<void>;
}

/**
 * Returns null when another runner holds the lock. Expired locks are stolen,
 * so a crashed runner cannot wedge a job forever.
 */
export async function acquireLock(job: string, ttlMs = DEFAULT_TTL_MS): Promise<LockHandle | null> {
  const db = await getDb();
  const owner = `${process.pid}-${randomUUID().slice(0, 8)}`;
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  // Single statement: insert, or take over only if the existing lock expired.
  const res = await db.query<{ locked_by: string }>(
    `INSERT INTO job_locks (job, locked_at, locked_by, expires_at)
     VALUES ($1, now(), $2, $3)
     ON CONFLICT (job) DO UPDATE
       SET locked_at = now(), locked_by = $2, expires_at = $3
       WHERE job_locks.expires_at < now()
     RETURNING locked_by`,
    [job, owner, expiresAt],
  );

  if (res.rows.length === 0 || res.rows[0]?.locked_by !== owner) {
    logger.debug('lock held by another runner', { job });
    return null;
  }

  return {
    job,
    owner,
    async release() {
      const d = await getDb();
      await d.query('DELETE FROM job_locks WHERE job = $1 AND locked_by = $2', [job, owner]);
    },
  };
}

/** Runs fn only if the lock can be acquired; otherwise returns `skipped`. */
export async function withLock<T>(
  job: string,
  fn: () => Promise<T>,
  ttlMs = DEFAULT_TTL_MS,
): Promise<{ ran: true; result: T } | { ran: false; result: null }> {
  const lock = await acquireLock(job, ttlMs);
  if (!lock) return { ran: false, result: null };
  try {
    return { ran: true, result: await fn() };
  } finally {
    await lock.release().catch((err) => logger.warn('lock release failed', { job, err: String(err) }));
  }
}
