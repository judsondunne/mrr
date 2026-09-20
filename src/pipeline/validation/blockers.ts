/**
 * Technical / platform feasibility blockers.
 *
 * There is no `blocked` column in the schema, and adding one is not this
 * layer's call, so a blocker is recorded the same way every other material
 * decision is recorded: as an audit event. Two sources count, both durable:
 *
 *   1. audit_events: event_type = 'DECISION' with reason starting
 *      'FEASIBILITY_BLOCKER', or detail_json.feasibilityBlocker set.
 *   2. opportunities.wedge_json.feasibilityBlockers — a non-empty array written
 *      by the wedge layer when it discovers the platform cannot support the idea.
 *
 * A blocker is permanent unless an explicit 'FEASIBILITY_BLOCKER_CLEARED'
 * decision is recorded after it.
 */
import { getDb } from '../../lib/db.js';
import { recordAudit } from '../../lib/audit.js';
import { loadOpportunity, parseWedge } from './opportunity.js';

export const BLOCKER_REASON = 'FEASIBILITY_BLOCKER';
export const BLOCKER_CLEARED_REASON = 'FEASIBILITY_BLOCKER_CLEARED';

export interface FeasibilityBlocker {
  source: 'audit_events' | 'wedge_json';
  detail: string;
  recordedAt: string | null;
}

interface BlockerRow {
  reason: string | null;
  detail_json: unknown;
  created_at: string | Date;
}

function readDetail(detailJson: unknown, fallback: string): string {
  const obj = typeof detailJson === 'string' ? safeParse(detailJson) : detailJson;
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const value = (obj as Record<string, unknown>).feasibilityBlocker;
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return fallback;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Records a blocker so the gate can see it. Callable from any layer. */
export async function recordFeasibilityBlocker(
  opportunityId: string,
  detail: string,
  actor = 'validation',
): Promise<void> {
  await recordAudit({
    entityType: 'opportunity',
    entityId: opportunityId,
    eventType: 'DECISION',
    actor,
    reason: BLOCKER_REASON,
    detail: { feasibilityBlocker: detail },
  });
}

export async function clearFeasibilityBlockers(
  opportunityId: string,
  detail: string,
  actor = 'validation',
): Promise<void> {
  await recordAudit({
    entityType: 'opportunity',
    entityId: opportunityId,
    eventType: 'DECISION',
    actor,
    reason: BLOCKER_CLEARED_REASON,
    detail: { clearedBecause: detail },
  });
}

export async function getFeasibilityBlockers(opportunityId: string): Promise<FeasibilityBlocker[]> {
  const db = await getDb();
  const res = await db.query<BlockerRow>(
    `SELECT reason, detail_json, created_at
       FROM audit_events
      WHERE entity_type = 'opportunity'
        AND entity_id = $1
        AND event_type = 'DECISION'
        AND (reason = $2 OR reason = $3 OR detail_json->>'feasibilityBlocker' IS NOT NULL)
      ORDER BY created_at ASC, id ASC`,
    [opportunityId, BLOCKER_REASON, BLOCKER_CLEARED_REASON],
  );

  const active: FeasibilityBlocker[] = [];
  for (const row of res.rows) {
    if (row.reason === BLOCKER_CLEARED_REASON) {
      active.length = 0;
      continue;
    }
    const recordedAt = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
    active.push({
      source: 'audit_events',
      detail: readDetail(row.detail_json, row.reason ?? BLOCKER_REASON),
      recordedAt,
    });
  }

  const opportunity = await loadOpportunity(opportunityId);
  if (opportunity) {
    for (const detail of parseWedge(opportunity.wedge_json).feasibilityBlockers) {
      active.push({ source: 'wedge_json', detail, recordedAt: null });
    }
  }

  return active;
}
