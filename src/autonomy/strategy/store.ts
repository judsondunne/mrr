/**
 * Versioned, append-only strategy storage.
 *
 * Two rules make the strategy plane safe to hand to a machine:
 *
 *   1. Every write goes through `assertStrategyOnly`, so a "strategy change"
 *      can never become a budget increase or a lowered gate.
 *   2. A change is always a NEW ROW. Nothing in here issues an UPDATE against
 *      `config_json`. When a decision later turns out to be wrong, the exact
 *      configuration that produced the outcome is still on disk, linked
 *      backwards through `previous_version_id`.
 */
import { getDb, toNumber } from '../../lib/db';
import { newId } from '../../lib/hash';
import { createLogger } from '../../lib/logger';
import { recordAudit } from '../../lib/audit';
import { AppError } from '../../lib/errors';
import type { StrategyDimension } from '../types';
import { assertStrategyOnly } from '../guard';
import { parseJsonColumn } from './util';

const logger = createLogger('strategy:store');

export interface StrategyVersionRecord {
  id: string;
  dimension: StrategyDimension;
  armKey: string;
  version: number;
  config: Record<string, unknown>;
  reason: string;
  active: boolean;
}

interface VersionRow {
  id: string;
  dimension: string;
  arm_key: string;
  version: number | string;
  config_json: unknown;
  reason: string;
  active: boolean;
}

function toRecord(row: VersionRow): StrategyVersionRecord {
  return {
    id: row.id,
    dimension: row.dimension as StrategyDimension,
    armKey: row.arm_key,
    version: toNumber(row.version),
    config: parseJsonColumn<Record<string, unknown>>(row.config_json, {}),
    reason: row.reason,
    active: row.active === true,
  };
}

const SELECT_COLUMNS = 'id, dimension, arm_key, version, config_json, reason, active';

/**
 * THE ONLY write path into the strategy plane. Rejects any config containing a
 * control-plane field (see FORBIDDEN_STRATEGY_FIELDS) and always appends a new
 * version rather than mutating history.
 */
export async function recordStrategyVersion(params: {
  dimension: StrategyDimension;
  armKey: string;
  config: Record<string, unknown>;
  reason: string;
  hypothesisId?: string | null;
}): Promise<StrategyVersionRecord> {
  const context = `strategy_versions:${params.dimension}:${params.armKey}`;
  // FIRST. Before a transaction is opened and before anything is written.
  assertStrategyOnly(params.config, context);

  const armKey = params.armKey.trim();
  if (armKey === '') {
    throw new AppError('a strategy version needs a non-empty armKey', 'STRATEGY_INVALID');
  }
  const reason = params.reason.trim();
  if (reason === '') {
    throw new AppError(
      `a strategy version needs a reason (${context}); an unexplained change cannot be reviewed`,
      'STRATEGY_INVALID',
    );
  }

  const db = await getDb();
  const record = await db.transaction(async (tx) => {
    // A hypothesis-driven change must be traceable back to the hypothesis, its
    // reason, and the benefit it claimed. Otherwise there is nothing to judge
    // the measured outcome against.
    if (params.hypothesisId) {
      const hyp = await tx.query<{ id: string; reason: string | null; expected_benefit: string | null }>(
        'SELECT id, reason, expected_benefit FROM strategy_hypotheses WHERE id = $1',
        [params.hypothesisId],
      );
      const row = hyp.rows[0];
      if (!row) {
        throw new AppError(
          `hypothesis ${params.hypothesisId} does not exist (${context})`,
          'STRATEGY_HYPOTHESIS_MISSING',
        );
      }
      if (!row.expected_benefit || row.expected_benefit.trim() === '') {
        throw new AppError(
          `hypothesis ${params.hypothesisId} records no expected benefit (${context})`,
          'STRATEGY_HYPOTHESIS_INCOMPLETE',
        );
      }
      if (!row.reason || row.reason.trim() === '') {
        throw new AppError(
          `hypothesis ${params.hypothesisId} records no reason (${context})`,
          'STRATEGY_HYPOTHESIS_INCOMPLETE',
        );
      }
    }

    const prev = await tx.query<{ id: string; version: number | string }>(
      `SELECT id, version FROM strategy_versions
        WHERE dimension = $1 AND arm_key = $2
        ORDER BY version DESC LIMIT 1`,
      [params.dimension, armKey],
    );
    const previous = prev.rows[0] ?? null;
    const version = previous ? toNumber(previous.version) + 1 : 1;

    // Retire the predecessors. `active` is a pointer, not the configuration —
    // no row's config_json is ever rewritten.
    await tx.query(
      `UPDATE strategy_versions SET active = false, retired_at = now()
        WHERE dimension = $1 AND arm_key = $2 AND active`,
      [params.dimension, armKey],
    );

    const inserted = await tx.query<VersionRow>(
      `INSERT INTO strategy_versions
         (id, dimension, arm_key, version, config_json, hypothesis_id, previous_version_id, reason, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
       RETURNING ${SELECT_COLUMNS}`,
      [
        newId('sv'),
        params.dimension,
        armKey,
        version,
        JSON.stringify(params.config),
        params.hypothesisId ?? null,
        previous?.id ?? null,
        reason,
      ],
    );
    const row = inserted.rows[0];
    if (!row) throw new AppError(`failed to append a strategy version (${context})`, 'STRATEGY_WRITE_FAILED');
    return toRecord(row);
  });

  await recordAudit({
    entityType: 'system',
    eventType: 'DECISION',
    actor: 'strategy:store',
    reason: record.reason,
    detail: {
      dimension: record.dimension,
      armKey: record.armKey,
      version: record.version,
      hypothesisId: params.hypothesisId ?? null,
    },
  });
  logger.info('strategy version appended', {
    dimension: record.dimension,
    armKey: record.armKey,
    version: record.version,
  });
  return record;
}

export async function getActiveStrategy(
  dimension: StrategyDimension,
  armKey: string,
): Promise<StrategyVersionRecord | null> {
  const db = await getDb();
  const res = await db.query<VersionRow>(
    `SELECT ${SELECT_COLUMNS} FROM strategy_versions
      WHERE dimension = $1 AND arm_key = $2 AND active
      ORDER BY version DESC LIMIT 1`,
    [dimension, armKey],
  );
  const row = res.rows[0];
  return row ? toRecord(row) : null;
}

export async function listStrategyHistory(
  dimension: StrategyDimension,
  armKey: string,
): Promise<StrategyVersionRecord[]> {
  const db = await getDb();
  const res = await db.query<VersionRow>(
    `SELECT ${SELECT_COLUMNS} FROM strategy_versions
      WHERE dimension = $1 AND arm_key = $2
      ORDER BY version ASC`,
    [dimension, armKey],
  );
  return res.rows.map(toRecord);
}
