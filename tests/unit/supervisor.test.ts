/**
 * The supervisor: priority order, concurrency ceilings, idempotency,
 * dead-letter triage, and the rule that ranking never touches a gate.
 *
 * The runtime, autostart, watchdog, queue and deliverability modules belong to
 * other agents and are still `declare`-only, so they are stubbed here. The
 * queue stub is backed by the REAL work_queue table in the real migrations, so
 * "two ticks produce no duplicate rows" is a database fact, not a mock's
 * opinion. Everything else — opportunities, campaigns, messages, budgets —
 * is real. No network.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  freshDb,
  teardown,
  insertOpportunity,
  insertCampaign,
  insertProspect,
  insertDeliveredMessage,
  insertCommitment,
} from '../helpers';
import type { Db } from '../../src/lib/db';

const stub = vi.hoisted(() => ({
  operational: true,
  runtimeState: 'RUNNING' as string,
  autoStartCalls: 0,
  watchdogCalls: 0,
  heartbeats: 0,
  deadLetter: [] as Array<Record<string, unknown>>,
  health: [] as Array<{ subsystem: string; status: string }>,
  revived: [] as Array<{ id: string; reason: string }>,
  archived: [] as Array<{ id: string; reason: string }>,
  deliverability: { healthy: false, reason: 'not configured', shouldPause: false },
  paused: [] as string[],
  seq: 0,
}));

vi.mock('../../src/autonomy/runtime', () => ({
  getRuntimeState: async () => ({
    state: stub.runtimeState,
    reason: null,
    blocking: [],
    enteredAt: new Date(),
    updatedAt: new Date(),
  }),
  isOperational: async () => stub.operational,
  recordHeartbeat: async () => {
    stub.heartbeats += 1;
  },
  getSubsystemHealth: async () => stub.health,
  transitionRuntime: async () => ({ moved: false, from: stub.runtimeState }),
  canRuntimeTransition: () => true,
}));

vi.mock('../../src/autonomy/autostart', () => ({
  autoStart: async () => {
    stub.autoStartCalls += 1;
    return { state: stub.runtimeState, changed: false };
  },
  checkReadiness: async () => ({ ready: true, blocking: [], remediation: [] }),
}));

vi.mock('../../src/autonomy/watchdog', () => ({
  runWatchdog: async () => {
    stub.watchdogCalls += 1;
    return { checked: 0, degraded: [], recovered: [], escalations: [], runtimeChanged: false };
  },
  releaseStaleLocks: async () => 0,
  recoverAbandonedJobs: async () => 0,
}));

vi.mock('../../src/autonomy/deliverability', () => ({
  evaluateDeliverability: async () => stub.deliverability,
  pauseSending: async (reason: string) => {
    stub.paused.push(reason);
  },
  resumeSendingIfRecovered: async () => ({ resumed: false, reason: 'still paused' }),
  getSendAllowance: async () => ({ allowed: 0, domainCapToday: 0, campaignCap: 0, warmupDay: 0, reason: null }),
  campaignRampCap: () => 0,
  domainDailyCap: async () => ({ cap: 0, warmupDay: 0 }),
  recordFirstSend: async () => undefined,
  maybeAdvanceRamp: async () => ({ advanced: false, rampStep: 0, reason: 'stub' }),
}));

/**
 * A real, minimal work queue on the real table. Only the behaviour the
 * supervisor depends on: unique idempotency keys, priority-then-age claiming,
 * and bounded retries into the dead letter.
 */
vi.mock('../../src/autonomy/queue', () => {
  async function conn() {
    const { getDb } = await import('../../src/lib/db');
    return getDb();
  }
  function toItem(row: Record<string, unknown>) {
    const payload = row.payload_json;
    return {
      id: String(row.id),
      kind: String(row.kind),
      payload: (typeof payload === 'string' ? JSON.parse(payload) : payload) ?? {},
      priority: Number(row.priority),
      status: String(row.status),
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts),
      nextRetryAt: new Date(String(row.next_retry_at)),
      lastError: (row.last_error as string) ?? null,
      deadLetterReason: (row.dead_letter_reason as string) ?? null,
      idempotencyKey: (row.idempotency_key as string) ?? null,
      opportunityId: (row.opportunity_id as string) ?? null,
    };
  }
  return {
    enqueue: async (req: {
      kind: string;
      payload?: Record<string, unknown>;
      priority: number;
      idempotencyKey: string;
      opportunityId?: string | null;
      maxAttempts?: number;
      runAt?: Date;
    }) => {
      const db = await conn();
      stub.seq += 1;
      const id = `wq_${stub.seq}`;
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO work_queue
           (id, kind, payload_json, priority, idempotency_key, opportunity_id, next_retry_at, max_attempts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [
          id,
          req.kind,
          JSON.stringify(req.payload ?? {}),
          req.priority,
          req.idempotencyKey,
          req.opportunityId ?? null,
          (req.runAt ?? new Date()).toISOString(),
          req.maxAttempts ?? 5,
        ],
      );
      if (inserted.rows.length > 0) return { id, created: true };
      const existing = await db.query<{ id: string }>(
        `SELECT id FROM work_queue WHERE idempotency_key = $1`,
        [req.idempotencyKey],
      );
      return { id: existing.rows[0]?.id ?? id, created: false };
    },

    claimNext: async (workerId: string) => {
      const db = await conn();
      const res = await db.query<Record<string, unknown>>(
        `UPDATE work_queue
            SET status = 'RUNNING', locked_by = $1, locked_until = now() + INTERVAL '5 minutes',
                attempts = attempts + 1, updated_at = now()
          WHERE id = (
            SELECT id FROM work_queue
             WHERE status = 'PENDING' AND next_retry_at <= now()
             ORDER BY priority ASC, created_at ASC
             LIMIT 1
          )
          RETURNING *`,
        [workerId],
      );
      const row = res.rows[0];
      return row ? toItem(row) : null;
    },

    completeWork: async (id: string) => {
      const db = await conn();
      await db.query(
        `UPDATE work_queue SET status = 'DONE', completed_at = now(), updated_at = now() WHERE id = $1`,
        [id],
      );
    },

    failWork: async (id: string, error: string) => {
      const db = await conn();
      const res = await db.query<{ status: string }>(
        `UPDATE work_queue
            SET status = CASE WHEN attempts >= max_attempts THEN 'DEAD_LETTER' ELSE 'PENDING' END,
                dead_letter_reason = CASE WHEN attempts >= max_attempts THEN $2 ELSE dead_letter_reason END,
                last_error = $2, locked_by = NULL,
                next_retry_at = now() + INTERVAL '1 minute', updated_at = now()
          WHERE id = $1
          RETURNING status`,
        [id, error],
      );
      return { deadLettered: res.rows[0]?.status === 'DEAD_LETTER' };
    },

    listDeadLetter: async () => stub.deadLetter.map((row) => toItem(row)),
    reviveDeadLetter: async (id: string, reason: string) => {
      stub.revived.push({ id, reason });
    },
    archiveDeadLetter: async (id: string, reason: string) => {
      stub.archived.push({ id, reason });
    },
    releaseStaleClaims: async () => 0,
    queueDepth: async () => {
      const db = await conn();
      const res = await db.query<{ status: string; n: string }>(
        `SELECT status, COUNT(*) AS n FROM work_queue GROUP BY status`,
      );
      const out: Record<string, number> = {};
      for (const row of res.rows) out[row.status] = Number(row.n);
      return out;
    },
  };
});

import { runSupervisor, drainQueue, hourBucket, idempotencyKeyFor } from '../../src/autonomy/supervisor';
import { priorityFor, hasCapacityFor, getConcurrencyState, rankOpportunities } from '../../src/autonomy/priority';
import { claimNext, failWork } from '../../src/autonomy/queue';
import { PRIORITY } from '../../src/autonomy/types';
import { getDb, toNumber } from '../../src/lib/db';
import { resetConfigCache } from '../../src/lib/config';
import { setLlmProvider } from '../../src/lib/llm/index';
import { recordCost } from '../../src/lib/cost';
import { evaluateGate } from '../../src/pipeline/validation/index';

/** Env this file sets directly; helpers.freshDb() does not know about these. */
const OWNED_ENV = [
  'MAX_RESEARCH_OPPORTUNITIES',
  'MAX_DEEP_RESEARCH_OPPORTUNITIES',
  'MAX_UNSENT_PROSPECTS',
  'MAX_MONTHLY_EXPERIMENTS',
  'REPLY_LATENCY_TARGET_MINUTES',
];

function resetStubs(): void {
  stub.operational = true;
  stub.runtimeState = 'RUNNING';
  stub.autoStartCalls = 0;
  stub.watchdogCalls = 0;
  stub.heartbeats = 0;
  stub.deadLetter = [];
  stub.health = [];
  stub.revived = [];
  stub.archived = [];
  stub.deliverability = { healthy: false, reason: 'not configured', shouldPause: false };
  stub.paused = [];
}

afterEach(async () => {
  for (const key of OWNED_ENV) delete process.env[key];
  resetConfigCache();
  resetStubs();
  await teardown();
});

// --- fixtures -------------------------------------------------------------------

async function insertInbound(
  db: Db,
  campaignId: string,
  prospectId: string,
  opts: { classification?: string | null; minutesAgo?: number } = {},
): Promise<string> {
  stub.seq += 1;
  const id = `msg_in_${stub.seq}`;
  await db.query(
    `INSERT INTO messages
       (id, campaign_id, prospect_id, direction, sequence_step, subject, body,
        received_at, status, classification)
     VALUES ($1,$2,$3,'INBOUND',-1,'re: your email','how much is it?',
             now() - ($4::int * INTERVAL '1 minute'), 'RECEIVED', $5)`,
    [id, campaignId, prospectId, opts.minutesAgo ?? 0, opts.classification ?? null],
  );
  return id;
}

/** A campaign with one real prospect who has written in and is waiting. */
async function waitingProspect(db: Db, opts: { classification?: string | null; minutesAgo?: number } = {}) {
  const opportunityId = await insertOpportunity(db, { state: 'VALIDATING' });
  const campaignId = await insertCampaign(db, opportunityId);
  const prospectId = await insertProspect(db, opportunityId, { status: 'REPLIED' });
  await insertInbound(db, campaignId, prospectId, opts);
  return { opportunityId, campaignId, prospectId };
}

async function queueRows(): Promise<Array<{ kind: string; priority: number; idempotency_key: string; status: string }>> {
  const db = await getDb();
  const res = await db.query<{ kind: string; priority: number; idempotency_key: string; status: string }>(
    `SELECT kind, priority, idempotency_key, status FROM work_queue ORDER BY priority ASC, created_at ASC`,
  );
  return res.rows;
}

function kinds(report: Awaited<ReturnType<typeof runSupervisor>>): string[] {
  return report.decisions.map((d) => d.kind);
}

function skipReasons(report: Awaited<ReturnType<typeof runSupervisor>>): string {
  return report.skipped.map((s) => s.reason).join(' | ');
}

// --- priority order ----------------------------------------------------------------

describe('priority order', () => {
  it('puts a live conversation first and exploration last', () => {
    expect(priorityFor('PROCESS_INBOUND_REPLY')).toBe(PRIORITY.PROTECT_CONVERSATION);
    expect(priorityFor('DISCOVER_OPPORTUNITIES')).toBe(PRIORITY.DISCOVERY_EXPLORATION);
    expect(priorityFor('EXPAND_QUERIES')).toBe(PRIORITY.DISCOVERY_EXPLORATION);

    expect(priorityFor('PROCESS_INBOUND_REPLY')).toBeLessThan(priorityFor('EVALUATE_CAMPAIGN'));
    expect(priorityFor('EVALUATE_CAMPAIGN')).toBeLessThan(priorityFor('SEND_DUE_MESSAGES'));
    expect(priorityFor('SEND_DUE_MESSAGES')).toBeLessThan(priorityFor('DISCOVER_PROSPECTS'));
    expect(priorityFor('DISCOVER_PROSPECTS')).toBeLessThan(priorityFor('RESEARCH_STAGE'));
    expect(priorityFor('RESEARCH_STAGE')).toBeLessThan(priorityFor('DISCOVER_OPPORTUNITIES'));
  });

  it('never lets discovery starve a prospect who is waiting, even queued first', async () => {
    const { db } = await freshDb();
    const { campaignId } = await waitingProspect(db);

    // Discovery got there first: same key the supervisor would use, inserted
    // an hour earlier, so age alone would win.
    await db.query(
      `INSERT INTO work_queue (id, kind, priority, idempotency_key, created_at, next_retry_at)
       VALUES ('wq_discovery_first','DISCOVER_OPPORTUNITIES',$1,$2, now() - INTERVAL '1 hour', now() - INTERVAL '1 hour')`,
      [priorityFor('DISCOVER_OPPORTUNITIES'), idempotencyKeyFor('DISCOVER_OPPORTUNITIES', 'global', hourBucket())],
    );

    const report = await runSupervisor({ maxWorkItems: 0 });

    const reply = report.decisions.find((d) => d.kind === 'PROCESS_INBOUND_REPLY');
    expect(reply, `decisions were ${kinds(report).join(', ')}`).toBeDefined();
    expect(reply?.priority).toBe(PRIORITY.PROTECT_CONVERSATION);
    expect(reply?.idempotencyKey).toBe(
      idempotencyKeyFor('PROCESS_INBOUND_REPLY', campaignId, hourBucket()),
    );

    // The queue hands out the reply first despite discovery being older.
    const first = await claimNext('test-worker');
    expect(first?.kind).toBe('PROCESS_INBOUND_REPLY');
    const second = await claimNext('test-worker');
    expect(second?.kind).not.toBe('PROCESS_INBOUND_REPLY');
  });

  it('treats a prospect waiting past the latency target as protect-conversation work', async () => {
    process.env.REPLY_LATENCY_TARGET_MINUTES = '15';
    const { db } = await freshDb();
    // Already classified, so the only reason to act is how long they waited.
    const { campaignId } = await waitingProspect(db, { classification: 'INTERESTED', minutesAgo: 120 });

    const report = await runSupervisor({ maxWorkItems: 0 });
    const reply = report.decisions.find((d) => d.kind === 'PROCESS_INBOUND_REPLY');
    expect(reply?.priority).toBe(PRIORITY.PROTECT_CONVERSATION);
    expect(reply?.reason).toContain('waiting longer than 15 minutes');
    expect(reply?.opportunityId).not.toBeNull();
    expect(campaignId).toBeTruthy();
  });

  it('leaves a freshly answered reply alone', async () => {
    process.env.REPLY_LATENCY_TARGET_MINUTES = '15';
    const { db } = await freshDb();
    const { campaignId, prospectId } = await waitingProspect(db, {
      classification: 'INTERESTED',
      minutesAgo: 120,
    });
    await db.query(
      `INSERT INTO messages (id, campaign_id, prospect_id, direction, sequence_step, subject, body, sent_at, status, idempotency_key)
       VALUES ('msg_answer',$1,$2,'OUTBOUND',-1,'re','answered', now(), 'SENT','answer-key')`,
      [campaignId, prospectId],
    );

    const report = await runSupervisor({ maxWorkItems: 0 });
    expect(kinds(report)).not.toContain('PROCESS_INBOUND_REPLY');
  });
});

// --- concurrency --------------------------------------------------------------------

describe('concurrency ceilings', () => {
  it('counts real rows, not guesses', async () => {
    const { db } = await freshDb();
    await insertOpportunity(db, { state: 'DISCOVERED', category: 'a' });
    await insertOpportunity(db, { state: 'CATEGORY_VERIFIED', category: 'b' });
    const validating = await insertOpportunity(db, { state: 'VALIDATING', category: 'c' });
    await insertCampaign(db, validating, { state: 'BATCH_1' });
    await insertProspect(db, validating, { status: 'QUALIFIED' });

    const state = await getConcurrencyState();
    expect(state.researchOpportunities).toBe(2);
    expect(state.deepResearchOpportunities).toBe(0);
    expect(state.activeValidations).toBe(1);
    expect(state.unsentProspects).toBe(1);
    expect(state.monthlyExperiments).toBe(1);
  });

  it('blocks discovery once the research ceiling is reached', async () => {
    process.env.MAX_RESEARCH_OPPORTUNITIES = '1';
    const { db } = await freshDb();
    await insertOpportunity(db, { state: 'DISCOVERED', category: 'one' });

    const verdict = await hasCapacityFor('DISCOVER_OPPORTUNITIES');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('max research opportunities');

    const report = await runSupervisor({ maxWorkItems: 0 });
    expect(kinds(report)).not.toContain('DISCOVER_OPPORTUNITIES');
    expect(skipReasons(report)).toContain('max research opportunities');
    expect((await queueRows()).some((r) => r.kind === 'DISCOVER_OPPORTUNITIES')).toBe(false);
  });

  it('blocks a new experiment once max active validations is reached', async () => {
    const { db } = await freshDb({ MAX_ACTIVE_VALIDATIONS: '1' });
    const live = await insertOpportunity(db, { state: 'VALIDATING', category: 'live' });
    await insertCampaign(db, live, { state: 'BATCH_1' });
    const waiting = await insertOpportunity(db, { state: 'CAMPAIGN_READY', category: 'waiting' });

    expect((await hasCapacityFor('PREPARE_CAMPAIGN')).ok).toBe(false);

    const report = await runSupervisor({ maxWorkItems: 0 });
    expect(kinds(report)).not.toContain('PREPARE_CAMPAIGN');
    expect(skipReasons(report)).toContain('max active validations');
    expect(waiting).toBeTruthy();
  });

  it('still allows discovery when there is room', async () => {
    await freshDb();
    expect((await hasCapacityFor('DISCOVER_OPPORTUNITIES')).ok).toBe(true);
    const report = await runSupervisor({ maxWorkItems: 0 });
    expect(kinds(report)).toContain('DISCOVER_OPPORTUNITIES');
  });
});

// --- budget ---------------------------------------------------------------------------

describe('budget pressure', () => {
  it('stops scheduling exploration when the budget is gone, but still protects a conversation', async () => {
    const { db } = await freshDb({ MONTHLY_LLM_BUDGET_USD: '1' });
    await waitingProspect(db);
    await recordCost({
      provider: 'anthropic',
      resourceType: 'LLM_INPUT_TOKENS',
      quantity: 1,
      estimatedCost: 1,
    });

    const report = await runSupervisor({ maxWorkItems: 0 });
    expect(report.budgetRemainingUsd).toBe(0);
    expect(kinds(report)).toContain('PROCESS_INBOUND_REPLY');
    expect(kinds(report)).not.toContain('DISCOVER_OPPORTUNITIES');
    expect(skipReasons(report)).toContain('DISCOVERY budget exhausted');
  });
});

// --- the tick ---------------------------------------------------------------------------

describe('supervisor tick', () => {
  it('does no work when the runtime is not operational, but still reports state', async () => {
    const { db } = await freshDb();
    await waitingProspect(db);
    stub.operational = false;
    stub.runtimeState = 'BLOCKED_CONFIGURATION';

    const report = await runSupervisor({ maxWorkItems: 5 });

    expect(report.runtimeState).toBe('BLOCKED_CONFIGURATION');
    expect(report.decisions).toEqual([]);
    expect(report.enqueued).toBe(0);
    expect(report.executed).toBe(0);
    expect(await queueRows()).toEqual([]);
    // It still tried to fix itself first: that is how BLOCKED resolves.
    expect(stub.autoStartCalls).toBe(1);
    expect(stub.watchdogCalls).toBe(1);
  });

  it('is idempotent: two ticks in the same window queue nothing twice', async () => {
    const { db } = await freshDb();
    await waitingProspect(db);

    const first = await runSupervisor({ maxWorkItems: 0 });
    const afterFirst = await queueRows();
    expect(first.enqueued).toBe(afterFirst.length);
    expect(afterFirst.length).toBeGreaterThan(0);

    const second = await runSupervisor({ maxWorkItems: 0 });
    const afterSecond = await queueRows();

    expect(afterSecond.length).toBe(afterFirst.length);
    expect(second.enqueued).toBe(0);
    expect(skipReasons(second)).toContain('already queued');

    const keys = afterSecond.map((r) => r.idempotency_key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('schedules an evaluation once the counts could plausibly satisfy the gate', async () => {
    const { db } = await freshDb({ MIN_DELIVERED_BEFORE_STANDARD_EVALUATION: '2' });
    const opportunityId = await insertOpportunity(db, { state: 'VALIDATING' });
    const campaignId = await insertCampaign(db, opportunityId);
    for (let i = 0; i < 2; i += 1) {
      const prospectId = await insertProspect(db, opportunityId, { domain: `p${i}.example.com` });
      await insertDeliveredMessage(db, campaignId, prospectId);
    }

    const report = await runSupervisor({ maxWorkItems: 0 });
    const decision = report.decisions.find((d) => d.kind === 'EVALUATE_CAMPAIGN');
    expect(decision?.priority).toBe(PRIORITY.EVALUATE_POTENTIAL_WINNER);
    expect(decision?.opportunityId).toBe(opportunityId);
  });

  it('does not schedule an evaluation for a campaign with nothing to evaluate', async () => {
    const { db } = await freshDb({ MIN_DELIVERED_BEFORE_STANDARD_EVALUATION: '75' });
    const opportunityId = await insertOpportunity(db, { state: 'VALIDATING' });
    await insertCampaign(db, opportunityId);

    const report = await runSupervisor({ maxWorkItems: 0 });
    expect(kinds(report)).not.toContain('EVALUATE_CAMPAIGN');
  });

  it('re-checks feasibility and notifies for an opportunity the gate already passed', async () => {
    const { db } = await freshDb();
    const opportunityId = await insertOpportunity(db, { state: 'READY_TO_BUILD' });

    const report = await runSupervisor({ maxWorkItems: 0 });
    const byKind = new Map(report.decisions.map((d) => [d.kind, d]));

    expect(byKind.get('REVALIDATE_FEASIBILITY')?.opportunityId).toBe(opportunityId);
    expect(byKind.get('REFRESH_EVIDENCE')?.opportunityId).toBe(opportunityId);
    expect(byKind.get('NOTIFY_VALIDATED')?.priority).toBe(PRIORITY.EVALUATE_POTENTIAL_WINNER);
  });

  it('does not re-notify an owner who has already been told', async () => {
    const { db } = await freshDb();
    const opportunityId = await insertOpportunity(db, { state: 'READY_TO_BUILD' });
    await db.query(
      `INSERT INTO owner_notifications (id, kind, subject, body, dedupe_key, sent_at)
       VALUES ('own_1','READY_TO_BUILD','s','b',$1, now())`,
      [`READY_TO_BUILD:${opportunityId}`],
    );

    const report = await runSupervisor({ maxWorkItems: 0 });
    expect(kinds(report)).not.toContain('NOTIFY_VALIDATED');
  });

  it('keeps outbound work off the queue while deliverability cannot be confirmed', async () => {
    const { db } = await freshDb();
    const opportunityId = await insertOpportunity(db, { state: 'VALIDATING' });
    const campaignId = await insertCampaign(db, opportunityId, { state: 'BATCH_1' });
    const prospectId = await insertProspect(db, opportunityId);
    await db.query(
      `INSERT INTO messages (id, campaign_id, prospect_id, direction, sequence_step, subject, body, status, idempotency_key)
       VALUES ('msg_draft',$1,$2,'OUTBOUND',0,'s','b','DRAFTED','draft-key')`,
      [campaignId, prospectId],
    );

    const report = await runSupervisor({ maxWorkItems: 0 });
    expect(kinds(report)).not.toContain('SEND_DUE_MESSAGES');
    expect(skipReasons(report)).toContain('outreach disabled (shadow mode)');
  });

  it('spends deep research on the finalist with the best information value', async () => {
    process.env.MAX_DEEP_RESEARCH_OPPORTUNITIES = '1';
    const { db } = await freshDb();

    const strong = await insertOpportunity(db, {
      state: 'CATEGORY_VERIFIED',
      evidence_confidence: 'HIGH',
      category: 'strong',
      estimated_build_days: 3,
    });
    const weak = await insertOpportunity(db, {
      state: 'CATEGORY_VERIFYING',
      evidence_confidence: 'LOW',
      category: 'weak',
    });
    await recordCost({
      provider: 'anthropic',
      resourceType: 'LLM_INPUT_TOKENS',
      quantity: 1,
      estimatedCost: 0.4,
      phase: 'RESEARCH',
      opportunityId: weak,
    });

    const report = await runSupervisor({ maxWorkItems: 0 });
    const research = report.decisions.filter((d) => d.kind === 'RESEARCH_STAGE');
    expect(research).toHaveLength(1);
    expect(research[0]?.opportunityId).toBe(strong);
    expect(research[0]?.priority).toBe(PRIORITY.DEEP_RESEARCH);
  });

  it('records a post-mortem for a failure that has no lesson yet', async () => {
    const { db } = await freshDb();
    const dead = await insertOpportunity(db, { state: 'VALIDATION_FAILED' });

    const report = await runSupervisor({ maxWorkItems: 0 });
    const postMortem = report.decisions.find((d) => d.kind === 'POST_MORTEM');
    expect(postMortem?.opportunityId).toBe(dead);
    expect(postMortem?.priority).toBe(PRIORITY.DEEP_RESEARCH);
  });
});

// --- dead-letter triage --------------------------------------------------------------

describe('dead-letter triage', () => {
  function deadItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'wq_dead_1',
      kind: 'DISCOVER_PROSPECTS',
      payload_json: {},
      priority: 5,
      status: 'DEAD_LETTER',
      attempts: 5,
      max_attempts: 5,
      next_retry_at: new Date().toISOString(),
      last_error: 'search provider timeout',
      dead_letter_reason: 'search provider timeout',
      idempotency_key: 'DISCOVER_PROSPECTS:opp:2026-01-01-00',
      opportunity_id: null,
      ...overrides,
    };
  }

  it('archives work for an opportunity that is no longer worth pursuing', async () => {
    const { db } = await freshDb();
    const dead = await insertOpportunity(db, { state: 'VALIDATION_FAILED' });
    stub.deadLetter = [deadItem({ opportunity_id: dead })];
    stub.health = [{ subsystem: 'prospecting', status: 'OK' }];

    const report = await runSupervisor({ maxWorkItems: 0 });

    expect(report.deadLetterReviewed).toBe(1);
    expect(stub.archived).toHaveLength(1);
    expect(stub.archived[0]?.reason).toContain('no longer worth pursuing');
    expect(stub.revived).toHaveLength(0);
  });

  it('revives work whose dependency is healthy again', async () => {
    const { db } = await freshDb();
    const live = await insertOpportunity(db, { state: 'PROSPECTING' });
    stub.deadLetter = [deadItem({ opportunity_id: live })];
    stub.health = [{ subsystem: 'prospecting', status: 'OK' }];

    const report = await runSupervisor({ maxWorkItems: 0 });

    expect(report.deadLetterReviewed).toBe(1);
    expect(stub.revived).toHaveLength(1);
    expect(stub.revived[0]?.reason).toContain('prospecting');
    expect(stub.archived).toHaveLength(0);
  });

  it('escalates to the owner exactly once when a human is needed', async () => {
    const { db } = await freshDb();
    const live = await insertOpportunity(db, { state: 'PROSPECTING' });
    stub.deadLetter = [deadItem({ opportunity_id: live })];
    stub.health = [{ subsystem: 'prospecting', status: 'FAILING' }];

    await runSupervisor({ maxWorkItems: 0 });
    await runSupervisor({ maxWorkItems: 0 });

    expect(stub.revived).toHaveLength(0);
    expect(stub.archived).toHaveLength(0);
    const alerts = await db.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM owner_notifications WHERE dedupe_key = $1`,
      ['DEAD_LETTER:wq_dead_1'],
    );
    expect(toNumber(alerts.rows[0]?.n)).toBe(1);
  });
});

// --- executing work -----------------------------------------------------------------------

describe('draining the queue', () => {
  it('processes every item and never throws, even with the model provider down', async () => {
    const { db } = await freshDb();
    const { campaignId } = await waitingProspect(db, { classification: 'INTERESTED', minutesAgo: 1 });
    const opportunityId = await insertOpportunity(db, { state: 'READY_TO_BUILD', category: 'feasible' });

    // A model outage must not stop the queue. The original version of this
    // test forced a failure by relying on the feasibility module being
    // declare-only; it is implemented now, and every layer catches provider
    // failures and degrades rather than throwing — which is the behaviour the
    // system is supposed to have. So assert THAT instead.
    setLlmProvider({
      name: 'outage',
      async complete() {
        throw new Error('simulated model outage');
      },
    } as never);

    await db.query(
      `INSERT INTO work_queue (id, kind, payload_json, priority, idempotency_key, opportunity_id, attempts, max_attempts)
       VALUES ('wq_reply','PROCESS_INBOUND_REPLY',$1,1,'reply-key',NULL,0,5),
              ('wq_feas','REVALIDATE_FEASIBILITY','{}'::jsonb,2,'feas-key',$2,0,5),
              ('wq_prop','PROPOSE_HYPOTHESIS','{}'::jsonb,7,'prop-key',NULL,0,5)`,
      [JSON.stringify({ campaignId }), opportunityId],
    );

    const result = await drainQueue(10);
    expect(result.processed + result.failed).toBe(3);

    const rows = await db.query<{ status: string }>(`SELECT status FROM work_queue`);
    // Nothing is left claimed or lost: every item reached a terminal-for-now state.
    for (const row of rows.rows) {
      expect(['DONE', 'PENDING', 'DEAD_LETTER', 'FAILED']).toContain(row.status);
    }
    expect(rows.rows.filter((r) => r.status === 'RUNNING')).toHaveLength(0);
  });

  it('dead-letters an item that keeps failing instead of retrying forever', async () => {
    const { db } = await freshDb();

    await db.query(
      `INSERT INTO work_queue (id, kind, payload_json, priority, idempotency_key, attempts, max_attempts)
       VALUES ('wq_loop','REVALIDATE_FEASIBILITY','{}'::jsonb,2,'loop-key',0,3)`,
    );

    // Drive the REAL cycle: claimNext is what increments `attempts`, and
    // failWork decides on the incremented value. Calling failWork alone would
    // retry forever, which is why this walks the production path instead.
    // Between iterations we clear the backoff to stand in for time passing.
    const db2 = await getDb();
    let deadLettered = false;
    for (let attempt = 0; attempt < 6 && !deadLettered; attempt++) {
      await db2.query(`UPDATE work_queue SET next_retry_at = now() WHERE id = 'wq_loop'`);
      const claimed = await claimNext(`worker-${attempt}`);
      if (!claimed) break;
      const outcome = await failWork(claimed.id, `attempt ${attempt} failed`);
      deadLettered = outcome.deadLettered;
    }

    expect(deadLettered).toBe(true);
    const row = await db.query<{ status: string; attempts: number; dead_letter_reason: string | null }>(
      `SELECT status, attempts, dead_letter_reason FROM work_queue WHERE id = 'wq_loop'`,
    );
    expect(row.rows[0]?.status).toBe('DEAD_LETTER');
    expect(row.rows[0]?.dead_letter_reason).toBeTruthy();
    // Bounded: it stopped at max_attempts rather than retrying forever.
    expect(row.rows[0]?.attempts).toBeLessThanOrEqual(3);
  });
});

// --- ranking is not a gate -------------------------------------------------------------------

describe('ranking allocates resources and nothing else', () => {
  it('never changes a gate outcome', async () => {
    const { db } = await freshDb();
    const opportunityId = await insertOpportunity(db, {
      state: 'VALIDATING',
      evidence_confidence: 'HIGH',
      estimated_build_days: 3,
      proposed_price_monthly: 29,
      proposed_wedge: 'automatic wholesale minimums',
      target_customer: 'wholesale shopify merchants',
    });
    const campaignId = await insertCampaign(db, opportunityId, { price: 29 });
    for (let i = 0; i < 4; i += 1) {
      const prospectId = await insertProspect(db, opportunityId, { domain: `rank-${i}.example.com` });
      await insertDeliveredMessage(db, campaignId, prospectId);
    }
    await insertCommitment(db, campaignId, 'rank-0.example.com', 'EXPLICIT_PRICE_ACCEPTANCE');

    const before = await evaluateGate(opportunityId);
    const ranked = await rankOpportunities(10);
    const after = await evaluateGate(opportunityId);

    expect(ranked.some((r) => r.opportunityId === opportunityId)).toBe(true);
    expect(after.passed).toBe(before.passed);
    expect(after.checks.map((c) => `${c.id}:${c.passed}`)).toEqual(
      before.checks.map((c) => `${c.id}:${c.passed}`),
    );
    expect(after.unmetChecks.length).toBe(before.unmetChecks.length);
    // Ranking is allowed to write exactly one thing: the score.
    const row = await db.query<{ state: string; rank_score: string }>(
      'SELECT state, rank_score FROM opportunities WHERE id = $1',
      [opportunityId],
    );
    expect(row.rows[0]?.state).toBe('VALIDATING');
    expect(toNumber(row.rows[0]?.rank_score)).toBeGreaterThan(0);
  });

  it('orders by observed facts: commitments and contactable prospects win', async () => {
    const { db } = await freshDb();
    const proven = await insertOpportunity(db, {
      state: 'VALIDATING',
      category: 'proven',
      evidence_confidence: 'HIGH',
      estimated_build_days: 2,
      proposed_price_monthly: 29,
    });
    const unproven = await insertOpportunity(db, {
      state: 'CATEGORY_VERIFIED',
      category: 'unproven',
      evidence_confidence: 'LOW',
      estimated_build_days: 30,
    });

    const campaignId = await insertCampaign(db, proven, { price: 29 });
    for (let i = 0; i < 5; i += 1) {
      const prospectId = await insertProspect(db, proven, { domain: `proven-${i}.example.com` });
      await insertDeliveredMessage(db, campaignId, prospectId);
      if (i < 3) await insertCommitment(db, campaignId, `proven-${i}.example.com`, 'PILOT_SIGNUP');
    }

    const ranked = await rankOpportunities(10);
    expect(ranked[0]?.opportunityId).toBe(proven);
    expect(ranked.find((r) => r.opportunityId === unproven)?.score).toBeLessThan(ranked[0]?.score ?? 0);
    // An MVP that cannot be built inside the configured window scores zero there.
    expect(ranked.find((r) => r.opportunityId === unproven)?.factors.mvpBuildDays).toBe(0);
  });

  it('leaves dead opportunities out of the ranking entirely', async () => {
    const { db } = await freshDb();
    const dead = await insertOpportunity(db, { state: 'VALIDATION_FAILED', category: 'dead' });
    const live = await insertOpportunity(db, { state: 'PROSPECTING', category: 'live' });

    const ranked = await rankOpportunities(10);
    expect(ranked.map((r) => r.opportunityId)).toContain(live);
    expect(ranked.map((r) => r.opportunityId)).not.toContain(dead);
  });
});
