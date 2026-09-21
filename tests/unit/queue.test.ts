/**
 * The durable work queue.
 *
 * The properties these tests exist to protect: the same logical work is never
 * queued twice, two workers never get the same item, and one malformed page
 * cannot halt the system — it dead-letters and the queue keeps moving.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { freshDb, teardown, insertOpportunity } from '../helpers';
import {
  archiveDeadLetter,
  claimNext,
  completeWork,
  enqueue,
  failWork,
  listDeadLetter,
  queueDepth,
  releaseStaleClaims,
  reviveDeadLetter,
} from '../../src/autonomy/queue';
import { PRIORITY } from '../../src/autonomy/types';
import { getDb } from '../../src/lib/db';

afterEach(async () => { await teardown(); });

function ms(value: unknown): number {
  return value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
}

async function row(id: string): Promise<Record<string, unknown>> {
  const db = await getDb();
  const res = await db.query<Record<string, unknown>>('SELECT * FROM work_queue WHERE id = $1', [id]);
  const found = res.rows[0];
  if (!found) throw new Error(`no work_queue row ${id}`);
  return found;
}

/** The gap the item was told to wait before its next attempt. */
async function retryDelayMs(id: string): Promise<number> {
  const r = await row(id);
  return ms(r.next_retry_at) - ms(r.updated_at);
}

async function makeDue(id: string): Promise<void> {
  const db = await getDb();
  await db.query('UPDATE work_queue SET next_retry_at = now() WHERE id = $1', [id]);
}

async function expireClaim(id: string): Promise<void> {
  const db = await getDb();
  await db.query(`UPDATE work_queue SET locked_until = now() - INTERVAL '1 minute' WHERE id = $1`, [id]);
}

describe('enqueue', () => {
  it('is idempotent on the idempotency key', async () => {
    await freshDb();
    const first = await enqueue({
      kind: 'DISCOVER_OPPORTUNITIES',
      priority: PRIORITY.DISCOVERY_EXPLORATION,
      idempotencyKey: 'discover:2026-09-20',
    });
    const second = await enqueue({
      kind: 'DISCOVER_OPPORTUNITIES',
      priority: PRIORITY.DISCOVERY_EXPLORATION,
      idempotencyKey: 'discover:2026-09-20',
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(await queueDepth()).toMatchObject({ PENDING: 1 });
  });

  it('keeps distinct work distinct', async () => {
    await freshDb();
    await enqueue({ kind: 'RESEARCH_STAGE', priority: 6, idempotencyKey: 'research:a:1' });
    await enqueue({ kind: 'RESEARCH_STAGE', priority: 6, idempotencyKey: 'research:a:2' });
    expect(await queueDepth()).toMatchObject({ PENDING: 2 });
  });

  it('stores the payload and the opportunity it belongs to', async () => {
    const { db } = await freshDb();
    const opportunityId = await insertOpportunity(db);
    const { id } = await enqueue({
      kind: 'QUALIFY_PROSPECTS',
      priority: PRIORITY.PROSPECT_QUALIFIED_EXPERIMENT,
      idempotencyKey: `qualify:${opportunityId}`,
      opportunityId,
      payload: { batch: 50 },
    });

    const claimed = await claimNext('worker-1');
    expect(claimed?.id).toBe(id);
    expect(claimed?.opportunityId).toBe(opportunityId);
    expect(claimed?.payload).toEqual({ batch: 50 });
  });
});

describe('claimNext', () => {
  it('never hands the same item to two workers', async () => {
    await freshDb();
    await enqueue({ kind: 'SEND_DUE_MESSAGES', priority: 3, idempotencyKey: 'only-one' });

    const [a, b] = await Promise.all([claimNext('worker-a'), claimNext('worker-b')]);
    const claimed = [a, b].filter((x) => x !== null);
    expect(claimed).toHaveLength(1);

    const stored = await row(claimed[0]!.id);
    expect(stored.status).toBe('RUNNING');
    expect(stored.locked_by).toMatch(/worker-[ab]/);
  });

  it('gives two workers two different items', async () => {
    await freshDb();
    await enqueue({ kind: 'RESEARCH_STAGE', priority: 6, idempotencyKey: 'one' });
    await enqueue({ kind: 'RESEARCH_STAGE', priority: 6, idempotencyKey: 'two' });

    const [a, b] = await Promise.all([claimNext('worker-a'), claimNext('worker-b')]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.id).not.toBe(b!.id);
  });

  it('serves the most important work first, whatever order it arrived in', async () => {
    await freshDb();
    await enqueue({ kind: 'DISCOVER_OPPORTUNITIES', priority: PRIORITY.DISCOVERY_EXPLORATION, idempotencyKey: 'explore' });
    await enqueue({ kind: 'PROCESS_INBOUND_REPLY', priority: PRIORITY.PROTECT_CONVERSATION, idempotencyKey: 'reply' });
    await enqueue({ kind: 'RESEARCH_STAGE', priority: PRIORITY.DEEP_RESEARCH, idempotencyKey: 'research' });

    expect((await claimNext('w'))?.kind).toBe('PROCESS_INBOUND_REPLY');
    expect((await claimNext('w'))?.kind).toBe('RESEARCH_STAGE');
    expect((await claimNext('w'))?.kind).toBe('DISCOVER_OPPORTUNITIES');
    expect(await claimNext('w')).toBeNull();
  });

  it('honours a kind filter', async () => {
    await freshDb();
    await enqueue({ kind: 'DISCOVER_OPPORTUNITIES', priority: 7, idempotencyKey: 'a' });
    await enqueue({ kind: 'SEND_DUE_MESSAGES', priority: 3, idempotencyKey: 'b' });

    const claimed = await claimNext('w', ['DISCOVER_OPPORTUNITIES']);
    expect(claimed?.kind).toBe('DISCOVER_OPPORTUNITIES');
    expect(await claimNext('w', ['DISCOVER_OPPORTUNITIES'])).toBeNull();
  });

  it('does not claim work that is not due yet', async () => {
    await freshDb();
    await enqueue({
      kind: 'SCHEDULE_FOLLOWUPS',
      priority: 4,
      idempotencyKey: 'later',
      runAt: new Date(Date.now() + 60 * 60_000),
    });
    expect(await claimNext('w')).toBeNull();
  });

  it('marks completed work DONE and stops serving it', async () => {
    await freshDb();
    const { id } = await enqueue({ kind: 'EVALUATE_CAMPAIGN', priority: 4, idempotencyKey: 'evaluate' });
    await claimNext('w');
    await completeWork(id);

    expect((await row(id)).status).toBe('DONE');
    expect(await claimNext('w')).toBeNull();
    expect(await queueDepth()).toMatchObject({ DONE: 1, PENDING: 0, RUNNING: 0 });
  });
});

describe('failWork', () => {
  it('backs off further on each attempt', async () => {
    await freshDb();
    const { id } = await enqueue({ kind: 'RESEARCH_STAGE', priority: 6, idempotencyKey: 'flaky', maxAttempts: 5 });

    await claimNext('w');
    expect((await failWork(id, 'provider 503')).deadLettered).toBe(false);
    const first = await retryDelayMs(id);

    await makeDue(id);
    await claimNext('w');
    await failWork(id, 'provider 503 again');
    const second = await retryDelayMs(id);

    await makeDue(id);
    await claimNext('w');
    await failWork(id, 'provider 503 once more');
    const third = await retryDelayMs(id);

    expect(first).toBeGreaterThan(25_000);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
    // Bounded: an hour of doubling must not become a week.
    expect(third).toBeLessThan(30 * 60_000 * 1.3);
    expect((await row(id)).last_error).toContain('provider 503');
  });

  it('dead-letters once the attempts are spent, with a reason', async () => {
    await freshDb();
    const { id } = await enqueue({ kind: 'EXPAND_QUERIES', priority: 7, idempotencyKey: 'doomed', maxAttempts: 2 });

    await claimNext('w');
    expect((await failWork(id, 'malformed page')).deadLettered).toBe(false);

    await makeDue(id);
    await claimNext('w');
    expect((await failWork(id, 'malformed page')).deadLettered).toBe(true);

    const dead = await listDeadLetter();
    expect(dead).toHaveLength(1);
    expect(dead[0]?.id).toBe(id);
    expect(dead[0]?.deadLetterReason).toContain('attempts exhausted (2/2)');
    expect(dead[0]?.deadLetterReason).toContain('malformed page');
    expect(await claimNext('w')).toBeNull();
  });

  it('lets the queue keep moving when one item is poison', async () => {
    await freshDb();
    const poison = await enqueue({ kind: 'EVALUATE_SOURCE', priority: 6, idempotencyKey: 'poison', maxAttempts: 1 });
    const good = await enqueue({ kind: 'EVALUATE_SOURCE', priority: 6, idempotencyKey: 'good' });

    const first = await claimNext('w');
    expect(first?.id).toBe(poison.id);
    expect((await failWork(poison.id, 'cheerio exploded on a malformed listing')).deadLettered).toBe(true);

    // The system is not wedged: the next item is served immediately.
    const second = await claimNext('w');
    expect(second?.id).toBe(good.id);
    expect(await queueDepth()).toMatchObject({ DEAD_LETTER: 1, RUNNING: 1 });
  });

  it('does nothing surprising when the item has already gone', async () => {
    await freshDb();
    expect(await failWork('wq_does_not_exist', 'boom')).toEqual({ deadLettered: false });
  });
});

describe('releaseStaleClaims', () => {
  it('recovers an item whose worker died mid-flight', async () => {
    await freshDb();
    const { id } = await enqueue({ kind: 'QUALIFY_PROSPECTS', priority: 5, idempotencyKey: 'abandoned' });

    const claimed = await claimNext('worker-that-dies');
    expect(claimed?.id).toBe(id);
    expect(await claimNext('another-worker')).toBeNull();

    await expireClaim(id);
    expect(await releaseStaleClaims()).toBe(1);

    const recovered = await row(id);
    expect(recovered.status).toBe('PENDING');
    expect(recovered.locked_by).toBeNull();

    const reclaimed = await claimNext('another-worker');
    expect(reclaimed?.id).toBe(id);
    expect(reclaimed?.attempts).toBe(2);
  });

  it('leaves a live claim alone', async () => {
    await freshDb();
    await enqueue({ kind: 'QUALIFY_PROSPECTS', priority: 5, idempotencyKey: 'in-flight' });
    await claimNext('busy-worker');
    expect(await releaseStaleClaims()).toBe(0);
    expect(await queueDepth()).toMatchObject({ RUNNING: 1 });
  });

  it('dead-letters an abandoned item that has no attempts left', async () => {
    await freshDb();
    const { id } = await enqueue({ kind: 'POST_MORTEM', priority: 7, idempotencyKey: 'killer', maxAttempts: 1 });
    await claimNext('worker-that-dies');
    await expireClaim(id);

    expect(await releaseStaleClaims()).toBe(0);
    const dead = await listDeadLetter();
    expect(dead.map((d) => d.id)).toEqual([id]);
    expect(dead[0]?.deadLetterReason).toContain('worker died');
  });
});

describe('dead-letter triage', () => {
  it('revives an item back into the queue', async () => {
    await freshDb();
    const { id } = await enqueue({ kind: 'REFRESH_EVIDENCE', priority: 6, idempotencyKey: 'revive-me', maxAttempts: 1 });
    await claimNext('w');
    await failWork(id, 'search provider down');

    await reviveDeadLetter(id, 'search is healthy again');

    const revived = await row(id);
    expect(revived.status).toBe('PENDING');
    expect(revived.attempts).toBe(0);
    expect(revived.dead_letter_reason).toBeNull();
    expect((await claimNext('w'))?.id).toBe(id);
  });

  it('archives an item without re-running it', async () => {
    await freshDb();
    const { id } = await enqueue({ kind: 'PROPOSE_HYPOTHESIS', priority: 7, idempotencyKey: 'archive-me', maxAttempts: 1 });
    await claimNext('w');
    await failWork(id, 'nonsense proposal');

    await archiveDeadLetter(id, 'no longer relevant');

    expect((await row(id)).status).toBe('CANCELLED');
    expect(await listDeadLetter()).toEqual([]);
    expect(await claimNext('w')).toBeNull();
  });

  it('reports depth by status', async () => {
    await freshDb();
    await enqueue({ kind: 'RESEARCH_STAGE', priority: 6, idempotencyKey: 'depth-1' });
    await enqueue({ kind: 'RESEARCH_STAGE', priority: 6, idempotencyKey: 'depth-2' });
    await claimNext('w');

    expect(await queueDepth()).toEqual({
      PENDING: 1,
      RUNNING: 1,
      DONE: 0,
      FAILED: 0,
      DEAD_LETTER: 0,
      CANCELLED: 0,
    });
  });
});
