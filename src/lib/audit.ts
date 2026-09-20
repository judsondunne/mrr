import { getDb } from './db.js';
import { newId } from './hash.js';
import { createLogger, redact } from './logger.js';
import {
  assertTransition,
  type GateToken,
  type OpportunityState,
  isOpportunityState,
} from './state-machine.js';
import { IllegalTransitionError } from './errors.js';

const logger = createLogger('audit');

export type EntityType = 'opportunity' | 'campaign' | 'prospect' | 'message' | 'system';
export type AuditEventType =
  | 'STATE_TRANSITION'
  | 'DECISION'
  | 'REJECTION'
  | 'SEND'
  | 'SUPPRESS'
  | 'GATE_EVALUATION'
  | 'ERROR';

export interface AuditInput {
  entityType: EntityType;
  entityId?: string | null;
  eventType: AuditEventType;
  actor: string;
  fromState?: string | null;
  toState?: string | null;
  reason?: string | null;
  detail?: Record<string, unknown>;
}

/** Records a material autonomous decision. Never throws into the caller's path. */
export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    const db = await getDb();
    await db.query(
      `INSERT INTO audit_events
         (id, entity_type, entity_id, event_type, actor, from_state, to_state, reason, detail_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        newId('aud'),
        input.entityType,
        input.entityId ?? null,
        input.eventType,
        input.actor,
        input.fromState ?? null,
        input.toState ?? null,
        input.reason ?? null,
        JSON.stringify(redact(input.detail ?? {})),
      ],
    );
  } catch (err) {
    logger.error('failed to write audit event', { err: String(err), eventType: input.eventType });
  }
}

/**
 * The ONLY sanctioned way to change an opportunity's state.
 *
 * Re-reads the current state inside the transaction and re-validates the edge,
 * so two concurrent jobs cannot both "win" a transition. Writes the audit row
 * in the same transaction as the state change.
 */
export async function transitionOpportunity(params: {
  opportunityId: string;
  to: OpportunityState;
  actor: string;
  reason: string;
  gateToken?: GateToken;
  detail?: Record<string, unknown>;
  /** Extra columns to set atomically with the transition. */
  set?: Partial<{
    rejection_reason: string | null;
    evidence_confidence: string | null;
    prospectability_score: number | null;
    validation_score: number | null;
    proposed_wedge: string | null;
    target_customer: string | null;
    proposed_price_monthly: number | null;
    estimated_build_days: number | null;
    next_action_at: string | null;
    wedge_json: unknown;
  }>;
}): Promise<{ moved: boolean; from: OpportunityState }> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const cur = await tx.query<{ state: string }>(
      'SELECT state FROM opportunities WHERE id = $1',
      [params.opportunityId],
    );
    const row = cur.rows[0];
    if (!row) throw new IllegalTransitionError('<missing>', params.to, `no opportunity ${params.opportunityId}`);
    if (!isOpportunityState(row.state)) {
      throw new IllegalTransitionError(row.state, params.to, 'corrupt state in database');
    }
    const from = row.state;

    if (from === params.to) return { moved: false, from };

    assertTransition(params.opportunityId, from, params.to, {
      reason: params.reason,
      gateToken: params.gateToken,
    });

    const setEntries = Object.entries(params.set ?? {});
    const assignments = ['state = $2', 'updated_at = now()'];
    const values: unknown[] = [params.opportunityId, params.to];
    setEntries.forEach(([col, val], i) => {
      // Column names come from the typed `set` literal above, never from input.
      assignments.push(`${col} = $${i + 3}`);
      values.push(col === 'wedge_json' ? JSON.stringify(val ?? null) : val);
    });

    await tx.query(
      `UPDATE opportunities SET ${assignments.join(', ')} WHERE id = $1 AND state = '${from}'`,
      values,
    );

    await tx.query(
      `INSERT INTO audit_events
         (id, entity_type, entity_id, event_type, actor, from_state, to_state, reason, detail_json)
       VALUES ($1,'opportunity',$2,'STATE_TRANSITION',$3,$4,$5,$6,$7)`,
      [
        newId('aud'),
        params.opportunityId,
        params.actor,
        from,
        params.to,
        params.reason,
        JSON.stringify(redact(params.detail ?? {})),
      ],
    );

    logger.info('opportunity transitioned', {
      opportunityId: params.opportunityId,
      from,
      to: params.to,
      actor: params.actor,
      reason: params.reason,
    });
    return { moved: true, from };
  });
}
