/**
 * Cost ledger and budget enforcement.
 *
 * COST CONTROL IS A PRODUCT REQUIREMENT. Every metered operation calls
 * assertBudget() BEFORE it spends, and recordCost() after. Going over budget
 * halts the relevant job loudly — it never silently overspends.
 */
import { getConfig } from './config.js';
import { getDb, toNumber } from './db.js';
import { BudgetExceededError } from './errors.js';
import { newId } from './hash.js';
import { createLogger } from './logger.js';

const logger = createLogger('cost');

export type CostProvider = 'anthropic' | 'brave' | 'resend' | 'mock';
export type ResourceType =
  | 'LLM_INPUT_TOKENS'
  | 'LLM_OUTPUT_TOKENS'
  | 'SEARCH_CALL'
  | 'EMAIL_SENT';

export interface CostEntry {
  provider: CostProvider;
  resourceType: ResourceType;
  quantity: number;
  estimatedCost: number;
  metadata?: Record<string, unknown>;
}

export async function recordCost(entry: CostEntry): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO cost_ledger (id, provider, resource_type, quantity, estimated_cost, metadata_json)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      newId('cost'),
      entry.provider,
      entry.resourceType,
      entry.quantity,
      entry.estimatedCost,
      JSON.stringify(entry.metadata ?? {}),
    ],
  );
}

export async function recordCosts(entries: CostEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const db = await getDb();
  await db.transaction(async (tx) => {
    for (const e of entries) {
      await tx.query(
        `INSERT INTO cost_ledger (id, provider, resource_type, quantity, estimated_cost, metadata_json)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [newId('cost'), e.provider, e.resourceType, e.quantity, e.estimatedCost, JSON.stringify(e.metadata ?? {})],
      );
    }
  });
}

/** Inclusive-start UTC boundary for the current calendar month. */
export function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
export function dayStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
export function weekStart(now = new Date()): Date {
  const d = dayStart(now);
  const dow = d.getUTCDay(); // 0 = Sunday
  d.setUTCDate(d.getUTCDate() - dow);
  return d;
}

async function sumCost(since: Date, providers: CostProvider[]): Promise<number> {
  const db = await getDb();
  const placeholders = providers.map((_, i) => `$${i + 2}`).join(',');
  const res = await db.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(estimated_cost), 0) AS total
       FROM cost_ledger
      WHERE created_at >= $1 AND provider IN (${placeholders})`,
    [since.toISOString(), ...providers],
  );
  return toNumber(res.rows[0]?.total, 0);
}

async function countRows(sql: string, params: unknown[]): Promise<number> {
  const db = await getDb();
  const res = await db.query<{ n: string | number }>(sql, params);
  return toNumber(res.rows[0]?.n, 0);
}

export interface BudgetSnapshot {
  llmSpentUsd: number;
  llmBudgetUsd: number;
  searchSpentUsd: number;
  searchBudgetUsd: number;
  emailsSentToday: number;
  maxEmailsPerDay: number;
  campaignsStartedThisWeek: number;
  maxNewCampaignsPerWeek: number;
  periodStart: string;
}

export async function getBudgetSnapshot(): Promise<BudgetSnapshot> {
  const cfg = getConfig();
  const ms = monthStart();
  const [llmSpent, searchSpent, emailsToday, campaignsThisWeek] = await Promise.all([
    sumCost(ms, ['anthropic']),
    sumCost(ms, ['brave']),
    countRows(
      `SELECT COUNT(*) AS n FROM messages
        WHERE direction = 'OUTBOUND' AND sent_at >= $1
          AND status IN ('SENT','DELIVERED','BOUNCED','COMPLAINED')`,
      [dayStart().toISOString()],
    ),
    countRows(`SELECT COUNT(*) AS n FROM campaigns WHERE started_at >= $1`, [weekStart().toISOString()]),
  ]);
  return {
    llmSpentUsd: llmSpent,
    llmBudgetUsd: cfg.monthlyLlmBudgetUsd,
    searchSpentUsd: searchSpent,
    searchBudgetUsd: cfg.monthlySearchBudgetUsd,
    emailsSentToday: emailsToday,
    maxEmailsPerDay: cfg.maxEmailsPerDay,
    campaignsStartedThisWeek: campaignsThisWeek,
    maxNewCampaignsPerWeek: cfg.maxNewCampaignsPerWeek,
    periodStart: ms.toISOString(),
  };
}

export type BudgetKind = 'LLM' | 'SEARCH' | 'EMAIL_DAILY' | 'CAMPAIGNS_WEEKLY';

/**
 * Call BEFORE spending. `projectedCost` is the estimated cost of the operation
 * about to run, so we refuse the call that would cross the line rather than
 * noticing afterwards.
 */
export async function assertBudget(kind: BudgetKind, projectedCost = 0): Promise<void> {
  const snap = await getBudgetSnapshot();
  switch (kind) {
    case 'LLM':
      if (snap.llmSpentUsd + projectedCost > snap.llmBudgetUsd) {
        throw new BudgetExceededError('LLM', round6(snap.llmSpentUsd + projectedCost), snap.llmBudgetUsd);
      }
      return;
    case 'SEARCH':
      if (snap.searchSpentUsd + projectedCost > snap.searchBudgetUsd) {
        throw new BudgetExceededError('SEARCH', round6(snap.searchSpentUsd + projectedCost), snap.searchBudgetUsd);
      }
      return;
    case 'EMAIL_DAILY':
      if (snap.emailsSentToday + Math.max(1, projectedCost) > snap.maxEmailsPerDay) {
        throw new BudgetExceededError('EMAIL_DAILY', snap.emailsSentToday + Math.max(1, projectedCost), snap.maxEmailsPerDay);
      }
      return;
    case 'CAMPAIGNS_WEEKLY':
      if (snap.campaignsStartedThisWeek + 1 > snap.maxNewCampaignsPerWeek) {
        throw new BudgetExceededError('CAMPAIGNS_WEEKLY', snap.campaignsStartedThisWeek + 1, snap.maxNewCampaignsPerWeek);
      }
      return;
  }
}

/** Non-throwing variant for callers that want to degrade rather than fail. */
export async function hasBudget(kind: BudgetKind, projectedCost = 0): Promise<boolean> {
  try {
    await assertBudget(kind, projectedCost);
    return true;
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      logger.warn('budget exhausted', { kind, spent: err.spent, limit: err.limit });
      return false;
    }
    throw err;
  }
}

/** How many more emails may go out today. */
export async function remainingDailyEmailQuota(): Promise<number> {
  const snap = await getBudgetSnapshot();
  return Math.max(0, snap.maxEmailsPerDay - snap.emailsSentToday);
}

export function estimateLlmCost(
  tier: 'fast' | 'reasoner',
  inputTokens: number,
  outputTokens: number,
): number {
  const cfg = getConfig();
  const inRate = tier === 'fast' ? cfg.llmFastInputCostPerMTok : cfg.llmReasonerInputCostPerMTok;
  const outRate = tier === 'fast' ? cfg.llmFastOutputCostPerMTok : cfg.llmReasonerOutputCostPerMTok;
  return round6((inputTokens / 1_000_000) * inRate + (outputTokens / 1_000_000) * outRate);
}

export function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export interface CostBreakdownRow {
  provider: string;
  resource_type: string;
  quantity: number;
  estimated_cost: number;
}

export async function getCostBreakdown(since = monthStart()): Promise<CostBreakdownRow[]> {
  const db = await getDb();
  const res = await db.query<{ provider: string; resource_type: string; quantity: string; estimated_cost: string }>(
    `SELECT provider, resource_type,
            SUM(quantity) AS quantity,
            SUM(estimated_cost) AS estimated_cost
       FROM cost_ledger
      WHERE created_at >= $1
      GROUP BY provider, resource_type
      ORDER BY SUM(estimated_cost) DESC`,
    [since.toISOString()],
  );
  return res.rows.map((r) => ({
    provider: r.provider,
    resource_type: r.resource_type,
    quantity: toNumber(r.quantity),
    estimated_cost: toNumber(r.estimated_cost),
  }));
}
