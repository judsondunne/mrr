/** PUBLIC API — DURABLE WORK QUEUE + DEAD LETTER. Owned by the runtime agent. */
import { getDb } from '../lib/db';
import { recordAudit } from '../lib/audit';
import { AppError } from '../lib/errors';
import { newId } from '../lib/hash';
import { createLogger } from '../lib/logger';
import { WORK_KINDS } from './types';
import type { EnqueueRequest, WorkItem, WorkKind, WorkStatus } from './types';

const logger = createLogger('autonomy:queue');

/** How long a claim is honoured before the watchdog may take the item back. */
const CLAIM_TTL_MS = 10 * 60_000;

/** Bounded exponential backoff: 30s, 60s, 120s ... capped at 30 minutes. */
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;
/** Jitter is additive and strictly under one doubling, so backoff still grows. */
const BACKOFF_JITTER_RATIO = 0.25;

const DEFAULT_MAX_ATTEMPTS = 5;

const ALL_STATUSES: readonly WorkStatus[] = [
  'PENDING',
  'RUNNING',
  'DONE',
  'FAILED',
  'DEAD_LETTER',
  'CANCELLED',
];

const SELECT_COLUMNS = `id, kind, payload_json, priority, status, attempts, max_attempts,
   next_retry_at, last_error, dead_letter_reason, idempotency_key, opportunity_id`;

interface QueueRow {
  id: string;
  kind: string;
  payload_json: unknown;
  priority: number | string;
  status: string;
  attempts: number | string;
  max_attempts: number | string;
  next_retry_at: unknown;
  last_error: string | null;
  dead_letter_reason: string | null;
  idempotency_key: string | null;
  opportunity_id: string | null;
}

/** Idempotent: re-enqueuing the same key is a no-op, never a duplicate. */
export async function enqueue(req: EnqueueRequest): Promise<{ id: string; created: boolean }> {
  if (!(WORK_KINDS as readonly string[]).includes(req.kind)) {
    throw new AppError(`unknown work kind: ${req.kind}`, 'UNKNOWN_WORK_KIND');
  }
  if (!req.idempotencyKey) {
    throw new AppError(`work of kind ${req.kind} requires an idempotency key`, 'MISSING_IDEMPOTENCY_KEY');
  }

  const db = await getDb();
  const id = newId('wq');
  const runAt = (req.runAt ?? new Date()).toISOString();
  const maxAttempts = intOr(req.maxAttempts, DEFAULT_MAX_ATTEMPTS);
  const priority = intOr(req.priority, 5);

  // The unique index on idempotency_key is the lock. Two supervisors racing on
  // the same decision both end up pointing at one row.
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO work_queue
       (id, kind, payload_json, priority, status, max_attempts, next_retry_at, idempotency_key, opportunity_id)
     VALUES ($1,$2,$3::jsonb,$4,'PENDING',$5,$6,$7,$8)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      id,
      req.kind,
      JSON.stringify(req.payload ?? {}),
      priority,
      maxAttempts,
      runAt,
      req.idempotencyKey,
      req.opportunityId ?? null,
    ],
  );
  const createdId = inserted.rows[0]?.id;
  if (createdId) return { id: createdId, created: true };

  const existing = await db.query<{ id: string }>(
    'SELECT id FROM work_queue WHERE idempotency_key = $1',
    [req.idempotencyKey],
  );
  const existingId = existing.rows[0]?.id;
  if (!existingId) {
    // The conflicting row disappeared between the two statements (cascade
    // delete of its opportunity). Nothing was created and nothing is queued.
    throw new AppError(`enqueue lost a race on ${req.idempotencyKey}`, 'ENQUEUE_RACE', true);
  }
  return { id: existingId, created: false };
}

/** Claims the highest-priority due item, atomically. */
export async function claimNext(workerId: string, kinds?: WorkKind[]): Promise<WorkItem | null> {
  const db = await getDb();
  const lockedUntil = new Date(Date.now() + CLAIM_TTL_MS).toISOString();

  const params: unknown[] = [workerId, lockedUntil];
  let kindFilter = '';
  if (kinds && kinds.length > 0) {
    // Placeholders are generated from the array LENGTH; the values themselves
    // are always bound parameters.
    const placeholders = kinds.map((_, i) => `$${params.length + i + 1}`);
    kindFilter = ` AND kind IN (${placeholders.join(',')})`;
    params.push(...kinds);
  }

  // One statement decides the winner. The inner SELECT ... FOR UPDATE SKIP
  // LOCKED means a second claimer steps over the row being taken instead of
  // blocking on it or, worse, claiming it twice.
  const res = await db.query<QueueRow>(
    `UPDATE work_queue
        SET status = 'RUNNING',
            locked_by = $1,
            locked_until = $2,
            attempts = attempts + 1,
            updated_at = now()
      WHERE id = (
        SELECT id FROM work_queue
         WHERE status = 'PENDING'
           AND next_retry_at <= now()
           AND attempts < max_attempts${kindFilter}
         ORDER BY priority ASC, next_retry_at ASC, created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
        AND status = 'PENDING'
    RETURNING ${SELECT_COLUMNS}`,
    params,
  );

  const row = res.rows[0];
  if (!row) return null;
  return toWorkItem(row);
}

export async function completeWork(id: string): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE work_queue
        SET status = 'DONE', completed_at = now(), locked_by = NULL, locked_until = NULL,
            last_error = NULL, updated_at = now()
      WHERE id = $1`,
    [id],
  );
}

/** Bounded exponential backoff; dead-letters after maxAttempts. */
export async function failWork(id: string, error: string): Promise<{ deadLettered: boolean }> {
  const db = await getDb();
  const cur = await db.query<{ attempts: number | string; max_attempts: number | string; kind: string }>(
    'SELECT attempts, max_attempts, kind FROM work_queue WHERE id = $1',
    [id],
  );
  const row = cur.rows[0];
  if (!row) {
    logger.warn('failWork for an item that no longer exists', { id });
    return { deadLettered: false };
  }

  const attempts = Math.max(1, Number(row.attempts ?? 0));
  const maxAttempts = Math.max(1, Number(row.max_attempts ?? DEFAULT_MAX_ATTEMPTS));
  const message = truncate(error, 2000);

  if (attempts >= maxAttempts) {
    const reason = `attempts exhausted (${attempts}/${maxAttempts}): ${message}`;
    await db.query(
      `UPDATE work_queue
          SET status = 'DEAD_LETTER', last_error = $2, dead_letter_reason = $3,
              locked_by = NULL, locked_until = NULL, updated_at = now()
        WHERE id = $1`,
      [id, message, truncate(reason, 2000)],
    );
    // A poisoned item leaves the queue instead of blocking it. This is the
    // rule that keeps one malformed page from halting the whole system.
    logger.warn('work item dead-lettered', { id, kind: row.kind, attempts, maxAttempts });
    await recordAudit({
      entityType: 'system',
      entityId: id,
      eventType: 'ERROR',
      actor: 'work_queue',
      reason: 'work item dead-lettered',
      detail: { kind: row.kind, attempts, maxAttempts, error: message },
    });
    return { deadLettered: true };
  }

  const nextRetryAt = new Date(Date.now() + backoffMs(attempts)).toISOString();
  await db.query(
    `UPDATE work_queue
        SET status = 'PENDING', last_error = $2, next_retry_at = $3,
            locked_by = NULL, locked_until = NULL, updated_at = now()
      WHERE id = $1`,
    [id, message, nextRetryAt],
  );
  logger.info('work item scheduled for retry', { id, kind: row.kind, attempts, nextRetryAt });
  return { deadLettered: false };
}

export async function listDeadLetter(limit = 50): Promise<WorkItem[]> {
  const db = await getDb();
  const res = await db.query<QueueRow>(
    `SELECT ${SELECT_COLUMNS} FROM work_queue
      WHERE status = 'DEAD_LETTER'
      ORDER BY updated_at DESC
      LIMIT $1`,
    [Math.max(1, Math.trunc(limit))],
  );
  return res.rows.map(toWorkItem);
}

/** Supervisor's DLQ triage: retry / archive / escalate. */
export async function reviveDeadLetter(id: string, reason: string): Promise<void> {
  const db = await getDb();
  const res = await db.query<{ id: string }>(
    `UPDATE work_queue
        SET status = 'PENDING', attempts = 0, next_retry_at = now(),
            dead_letter_reason = NULL, locked_by = NULL, locked_until = NULL, updated_at = now()
      WHERE id = $1 AND status = 'DEAD_LETTER'
      RETURNING id`,
    [id],
  );
  if (res.rows.length === 0) return;
  logger.info('dead-letter item revived', { id, reason });
  await recordAudit({
    entityType: 'system',
    entityId: id,
    eventType: 'DECISION',
    actor: 'work_queue',
    reason: `dead-letter revived: ${reason}`,
  });
}

export async function archiveDeadLetter(id: string, reason: string): Promise<void> {
  const db = await getDb();
  const res = await db.query<{ id: string }>(
    `UPDATE work_queue
        SET status = 'CANCELLED', dead_letter_reason = $2, completed_at = now(),
            locked_by = NULL, locked_until = NULL, updated_at = now()
      WHERE id = $1 AND status = 'DEAD_LETTER'
      RETURNING id`,
    [id, truncate(reason, 2000)],
  );
  if (res.rows.length === 0) return;
  logger.info('dead-letter item archived', { id, reason });
  await recordAudit({
    entityType: 'system',
    entityId: id,
    eventType: 'DECISION',
    actor: 'work_queue',
    reason: `dead-letter archived: ${reason}`,
  });
}

/** Releases items whose worker died mid-flight. */
export async function releaseStaleClaims(): Promise<number> {
  const db = await getDb();

  // An item whose worker keeps dying has already spent its attempts. Park it
  // in the dead letter queue where it is visible, rather than looping forever.
  const exhausted = await db.query<{ id: string }>(
    `UPDATE work_queue
        SET status = 'DEAD_LETTER',
            dead_letter_reason = 'worker died and no attempts remain',
            locked_by = NULL, locked_until = NULL, updated_at = now()
      WHERE status = 'RUNNING' AND locked_until IS NOT NULL AND locked_until < now()
        AND attempts >= max_attempts
      RETURNING id`,
  );

  const released = await db.query<{ id: string }>(
    `UPDATE work_queue
        SET status = 'PENDING', next_retry_at = now(),
            locked_by = NULL, locked_until = NULL, updated_at = now()
      WHERE status = 'RUNNING' AND locked_until IS NOT NULL AND locked_until < now()
      RETURNING id`,
  );

  if (released.rows.length > 0 || exhausted.rows.length > 0) {
    logger.info('recovered abandoned work', {
      released: released.rows.length,
      deadLettered: exhausted.rows.length,
    });
  }
  return released.rows.length;
}

export async function queueDepth(): Promise<Record<string, number>> {
  const db = await getDb();
  const res = await db.query<{ status: string; n: string | number }>(
    'SELECT status, COUNT(*) AS n FROM work_queue GROUP BY status',
  );
  const out: Record<string, number> = {};
  for (const status of ALL_STATUSES) out[status] = 0;
  for (const row of res.rows) out[row.status] = Number(row.n ?? 0);
  return out;
}

// --- internals ---------------------------------------------------------------

/**
 * Delay before attempt N+1. Doubling, hard-capped, plus additive jitter so a
 * burst of failures does not retry in lockstep. Jitter stays under one
 * doubling, so a later attempt always waits longer than an earlier one.
 */
function backoffMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** exponent);
  return Math.round(base * (1 + Math.random() * BACKOFF_JITTER_RATIO));
}

function toWorkItem(row: QueueRow): WorkItem {
  return {
    id: row.id,
    kind: row.kind as WorkKind,
    payload: toRecord(row.payload_json),
    priority: Number(row.priority ?? 5),
    status: row.status as WorkStatus,
    attempts: Number(row.attempts ?? 0),
    maxAttempts: Number(row.max_attempts ?? DEFAULT_MAX_ATTEMPTS),
    nextRetryAt: toDate(row.next_retry_at),
    lastError: row.last_error,
    deadLetterReason: row.dead_letter_reason,
    idempotencyKey: row.idempotency_key,
    opportunityId: row.opportunity_id,
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  const raw = typeof value === 'string' ? safeParse(value) : value;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (value === null || value === undefined) return new Date();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function intOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
