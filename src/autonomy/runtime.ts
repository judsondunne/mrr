/** PUBLIC API — RUNTIME STATE. Owned by the runtime agent. */
import { getConfig } from '../lib/config';
import { getDb } from '../lib/db';
import { recordAudit } from '../lib/audit';
import { IllegalTransitionError } from '../lib/errors';
import { createLogger } from '../lib/logger';
import { isRuntimeState, SUBSYSTEMS } from './types';
import type { RuntimeState, Subsystem, SubsystemHealth, HealthStatus } from './types';

export interface RuntimeSnapshot {
  state: RuntimeState;
  reason: string | null;
  blocking: string[];
  enteredAt: Date;
  updatedAt: Date;
}

const logger = createLogger('autonomy:runtime');

const ACTOR_FALLBACK = 'runtime';

/**
 * The runtime state machine, as an explicit edge table.
 *
 *   BOOTING → SELF_TESTING → SHADOW_VERIFYING → RUNNING
 *
 * Boot states may park in BLOCKED_CONFIGURATION, and BLOCKED_CONFIGURATION
 * leaves on its own back into SELF_TESTING — that is what makes a missing
 * credential self-healing rather than something the owner has to restart.
 *
 * RUNNING and DEGRADED swap freely; either may pause for budget or
 * deliverability and return when the cause clears.
 *
 * Every state reaches EMERGENCY_STOP (the kill switch), and EMERGENCY_STOP
 * leaves only by booting again. Anything not in this table is refused.
 */
const EDGES: Readonly<Record<RuntimeState, readonly RuntimeState[]>> = {
  BOOTING: ['SELF_TESTING', 'BLOCKED_CONFIGURATION', 'EMERGENCY_STOP'],
  SELF_TESTING: ['SHADOW_VERIFYING', 'BLOCKED_CONFIGURATION', 'EMERGENCY_STOP'],
  SHADOW_VERIFYING: ['RUNNING', 'BLOCKED_CONFIGURATION', 'EMERGENCY_STOP'],
  RUNNING: ['DEGRADED', 'PAUSED_BUDGET', 'PAUSED_DELIVERABILITY', 'EMERGENCY_STOP'],
  DEGRADED: ['RUNNING', 'PAUSED_BUDGET', 'PAUSED_DELIVERABILITY', 'EMERGENCY_STOP'],
  PAUSED_BUDGET: ['RUNNING', 'EMERGENCY_STOP'],
  PAUSED_DELIVERABILITY: ['RUNNING', 'EMERGENCY_STOP'],
  BLOCKED_CONFIGURATION: ['SELF_TESTING', 'EMERGENCY_STOP'],
  // Self-edge included so "anything → EMERGENCY_STOP" is true of the table
  // itself; transitionRuntime still treats from === to as a no-op.
  EMERGENCY_STOP: ['BOOTING', 'EMERGENCY_STOP'],
};

/** RUNNING and DEGRADED only. Everything else means "do no work". */
const OPERATIONAL: ReadonlySet<RuntimeState> = new Set<RuntimeState>(['RUNNING', 'DEGRADED']);

const SINGLETON_SQL = `INSERT INTO runtime_state (id, state, reason)
   VALUES (1, 'BOOTING', 'first boot')
   ON CONFLICT (id) DO NOTHING`;

interface RuntimeRow {
  state: string;
  reason: string | null;
  blocking_json: unknown;
  entered_at: unknown;
  updated_at: unknown;
}

export async function getRuntimeState(): Promise<RuntimeSnapshot> {
  const db = await getDb();
  await db.query(SINGLETON_SQL);
  const res = await db.query<RuntimeRow>(
    'SELECT state, reason, blocking_json, entered_at, updated_at FROM runtime_state WHERE id = 1',
  );
  const row = res.rows[0];
  if (!row) {
    // Cannot happen after the upsert above, but a runtime that cannot read its
    // own state must still answer "not operational" rather than throw.
    return { state: 'BOOTING', reason: 'runtime_state row missing', blocking: [], enteredAt: new Date(), updatedAt: new Date() };
  }
  return {
    state: coerceState(row.state),
    reason: row.reason,
    blocking: toStringArray(row.blocking_json),
    enteredAt: toDate(row.entered_at),
    updatedAt: toDate(row.updated_at),
  };
}

/** Audited. Rejects edges not in the runtime state machine. */
export async function transitionRuntime(params: {
  to: RuntimeState;
  reason: string;
  actor: string;
  blocking?: string[];
  detail?: Record<string, unknown>;
}): Promise<{ moved: boolean; from: RuntimeState }> {
  if (!isRuntimeState(params.to)) {
    throw new IllegalTransitionError('<unknown>', String(params.to), 'unknown runtime to-state');
  }
  const db = await getDb();
  await db.query(SINGLETON_SQL);

  const outcome = await db.transaction(async (tx) => {
    const cur = await tx.query<RuntimeRow>(
      'SELECT state, reason, blocking_json, entered_at, updated_at FROM runtime_state WHERE id = 1 FOR UPDATE',
    );
    const from = coerceState(cur.rows[0]?.state ?? 'BOOTING');

    // Re-parking in the state we are already in is not a transition. The
    // blocking list is still refreshed so a changed set of gaps is visible,
    // but no audit row is written — a supervisor tick must not spam history.
    if (from === params.to) {
      await tx.query(
        `UPDATE runtime_state
            SET reason = $1, blocking_json = $2::jsonb, detail_json = $3::jsonb, updated_at = now()
          WHERE id = 1`,
        [params.reason, JSON.stringify(params.blocking ?? []), JSON.stringify(params.detail ?? {})],
      );
      return { moved: false, from };
    }

    if (!canRuntimeTransition(from, params.to)) {
      throw new IllegalTransitionError(from, params.to, 'edge not in the runtime state machine');
    }

    await tx.query(
      `UPDATE runtime_state
          SET state = $1, reason = $2, blocking_json = $3::jsonb, detail_json = $4::jsonb,
              entered_at = now(), updated_at = now()
        WHERE id = 1 AND state = $5`,
      [
        params.to,
        params.reason,
        JSON.stringify(params.blocking ?? []),
        JSON.stringify(params.detail ?? {}),
        from,
      ],
    );
    return { moved: true, from };
  });

  if (outcome.moved) {
    // Audited after the state change is durable: an audit row that describes a
    // transition which then rolled back would be worse than none.
    await recordAudit({
      entityType: 'system',
      entityId: null,
      eventType: 'STATE_TRANSITION',
      actor: params.actor || ACTOR_FALLBACK,
      fromState: outcome.from,
      toState: params.to,
      reason: params.reason,
      detail: { ...(params.detail ?? {}), blocking: params.blocking ?? [] },
    });
    logger.info('runtime transitioned', {
      from: outcome.from,
      to: params.to,
      actor: params.actor,
      reason: params.reason,
    });
  }
  return outcome;
}

export function canRuntimeTransition(from: RuntimeState, to: RuntimeState): boolean {
  if (!isRuntimeState(from) || !isRuntimeState(to)) return false;
  return (EDGES[from] ?? []).includes(to);
}

export function allowedRuntimeTransitions(from: RuntimeState): readonly RuntimeState[] {
  return EDGES[from] ?? [];
}

/** True only in RUNNING or DEGRADED. Every job consults this. */
export async function isOperational(): Promise<boolean> {
  // The kill switch outranks whatever is persisted: a process that has not yet
  // noticed it must still refuse to act.
  if (getConfig().killSwitch) return false;
  const snapshot = await getRuntimeState();
  return OPERATIONAL.has(snapshot.state);
}

export async function recordHeartbeat(params: {
  subsystem: Subsystem;
  status: HealthStatus;
  error?: string | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  const db = await getDb();
  const ok = params.status === 'OK';
  await db.query(
    `INSERT INTO subsystem_health
       (subsystem, status, last_ok_at, last_attempt_at, last_error, consecutive_failures, detail_json)
     VALUES ($1, $2, CASE WHEN $3 THEN now() ELSE NULL END, now(), $4, CASE WHEN $3 THEN 0 ELSE 1 END, $5::jsonb)
     ON CONFLICT (subsystem) DO UPDATE
       SET status = EXCLUDED.status,
           last_ok_at = CASE WHEN $3 THEN now() ELSE subsystem_health.last_ok_at END,
           last_attempt_at = now(),
           last_error = $4,
           consecutive_failures =
             CASE WHEN $3 THEN 0 ELSE subsystem_health.consecutive_failures + 1 END,
           detail_json = $5::jsonb`,
    [params.subsystem, params.status, ok, params.error ?? null, JSON.stringify(params.detail ?? {})],
  );
}

export async function getSubsystemHealth(): Promise<SubsystemHealth[]> {
  const db = await getDb();
  const res = await db.query<{
    subsystem: string;
    status: string;
    last_ok_at: unknown;
    last_attempt_at: unknown;
    last_error: string | null;
    consecutive_failures: number | string;
  }>(
    `SELECT subsystem, status, last_ok_at, last_attempt_at, last_error, consecutive_failures
       FROM subsystem_health ORDER BY subsystem ASC`,
  );
  return res.rows
    .filter((row) => (SUBSYSTEMS as readonly string[]).includes(row.subsystem))
    .map((row) => ({
      subsystem: row.subsystem as Subsystem,
      status: coerceHealth(row.status),
      lastOkAt: toDateOrNull(row.last_ok_at),
      lastAttemptAt: toDateOrNull(row.last_attempt_at),
      lastError: row.last_error,
      consecutiveFailures: Number(row.consecutive_failures ?? 0),
    }));
}

// --- coercion helpers --------------------------------------------------------

/**
 * A corrupt state string must not wedge the supervisor: treat it as a fresh
 * boot and say so loudly, so autostart re-derives reality from readiness.
 */
function coerceState(raw: string): RuntimeState {
  if (isRuntimeState(raw)) return raw;
  logger.error('runtime_state holds an unknown state; treating it as BOOTING', { raw });
  return 'BOOTING';
}

function coerceHealth(raw: string): HealthStatus {
  return raw === 'OK' || raw === 'DEGRADED' || raw === 'FAILING' ? raw : 'UNKNOWN';
}

function toDate(value: unknown): Date {
  return toDateOrNull(value) ?? new Date();
}

function toDateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toStringArray(value: unknown): string[] {
  const raw = typeof value === 'string' ? safeParse(value) : value;
  return Array.isArray(raw) ? raw.map((v) => String(v)) : [];
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return [];
  }
}
