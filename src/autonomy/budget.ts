/**
 * PUBLIC API — COST INTELLIGENCE. Owned by the supervisor agent.
 *
 * The global monthly ceiling is a HARD control-plane limit and is enforced by
 * lib/cost.ts. This module allocates *within* it: five sub-budgets that may
 * borrow from one another but can never sum past the global cap.
 *
 * Two rules make that true mechanically:
 *   1. Allocations are derived from config percentages and scaled DOWN if they
 *      would sum past 100%. Nothing here can widen a budget.
 *   2. canSpend() checks the phase allocation (with borrowing) AND the global
 *      remaining, and refuses if either fails. The global term always binds.
 *
 * Spend is read, not remembered: cost_ledger (money actually metered by
 * lib/cost) and phase_spend (spend this layer books explicitly) are summed by
 * phase for the current month. A given spend belongs in exactly one of them.
 */
import { getConfig } from '../lib/config';
import { getDb, one, toNumber } from '../lib/db';
import { getBudgetSnapshot, monthStart, round6 } from '../lib/cost';
import { newId } from '../lib/hash';
import { createLogger } from '../lib/logger';
import type { SpendPhase } from './types';

const logger = createLogger('autonomy:budget');

export const SPEND_PHASES: readonly SpendPhase[] = [
  'DISCOVERY',
  'RESEARCH',
  'PROSPECTING',
  'REPLY',
  'FINAL_ANALYSIS',
];

export interface PhaseBudget {
  phase: SpendPhase;
  allocatedUsd: number;
  spentUsd: number;
  remainingUsd: number;
}

export interface BudgetReport {
  globalBudgetUsd: number;
  globalSpentUsd: number;
  globalRemainingUsd: number;
  phases: PhaseBudget[];
  /** True when the global cap is reached; the runtime moves to PAUSED_BUDGET. */
  exhausted: boolean;
}

// --- allocation ---------------------------------------------------------------

function phasePercentages(): Record<SpendPhase, number> {
  const { subBudgets } = getConfig();
  return {
    DISCOVERY: Math.max(0, subBudgets.discoveryPct),
    RESEARCH: Math.max(0, subBudgets.researchPct),
    PROSPECTING: Math.max(0, subBudgets.prospectingPct),
    REPLY: Math.max(0, subBudgets.replyPct),
    FINAL_ANALYSIS: Math.max(0, subBudgets.finalAnalysisPct),
  };
}

/**
 * Sub-budget allocations in dollars.
 *
 * A configuration whose percentages sum past 100% is scaled down rather than
 * honoured: the sum of the five allocations can never exceed the global cap.
 * A configuration summing to less than 100% simply leaves headroom that no
 * phase claims — still reachable through borrowing, still under the cap.
 */
function allocationsFor(globalBudgetUsd: number): Record<SpendPhase, number> {
  const pct = phasePercentages();
  const total = SPEND_PHASES.reduce((n, p) => n + pct[p], 0);
  const scale = total > 1 ? 1 / total : 1;
  const budget = Math.max(0, globalBudgetUsd);
  return {
    DISCOVERY: round6(budget * pct.DISCOVERY * scale),
    RESEARCH: round6(budget * pct.RESEARCH * scale),
    PROSPECTING: round6(budget * pct.PROSPECTING * scale),
    REPLY: round6(budget * pct.REPLY * scale),
    FINAL_ANALYSIS: round6(budget * pct.FINAL_ANALYSIS * scale),
  };
}

function emptyPhaseTotals(): Record<SpendPhase, number> {
  return { DISCOVERY: 0, RESEARCH: 0, PROSPECTING: 0, REPLY: 0, FINAL_ANALYSIS: 0 };
}

function isSpendPhase(v: unknown): v is SpendPhase {
  return typeof v === 'string' && (SPEND_PHASES as readonly string[]).includes(v);
}

/** YYYY-MM, matching phase_spend.period. */
export function currentPeriod(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

async function phaseSpendThisMonth(): Promise<Record<SpendPhase, number>> {
  const db = await getDb();
  const res = await db.query<{ phase: string | null; total: string | number | null }>(
    `SELECT phase, COALESCE(SUM(amount), 0) AS total
       FROM (
         SELECT phase AS phase, estimated_cost AS amount
           FROM cost_ledger
          WHERE created_at >= $1 AND phase IS NOT NULL
         UNION ALL
         SELECT phase AS phase, spend_usd AS amount
           FROM phase_spend
          WHERE period = $2
       ) s
      GROUP BY phase`,
    [monthStart().toISOString(), currentPeriod()],
  );
  const totals = emptyPhaseTotals();
  for (const row of res.rows) {
    if (isSpendPhase(row.phase)) totals[row.phase] = round6(toNumber(row.total, 0));
  }
  return totals;
}

export async function getBudgetReport(): Promise<BudgetReport> {
  // The global figures come from the control plane so this module can never
  // disagree with the hard ceiling that lib/cost enforces at spend time.
  const snapshot = await getBudgetSnapshot();
  const globalBudgetUsd = snapshot.llmBudgetUsd;
  const globalSpentUsd = round6(snapshot.llmSpentUsd);
  const globalRemainingUsd = round6(Math.max(0, globalBudgetUsd - globalSpentUsd));

  const allocated = allocationsFor(globalBudgetUsd);
  const spent = await phaseSpendThisMonth();

  const phases: PhaseBudget[] = SPEND_PHASES.map((phase) => ({
    phase,
    allocatedUsd: allocated[phase],
    spentUsd: spent[phase],
    remainingUsd: round6(Math.max(0, allocated[phase] - spent[phase])),
  }));

  return {
    globalBudgetUsd,
    globalSpentUsd,
    globalRemainingUsd,
    phases,
    exhausted: globalRemainingUsd <= 0,
  };
}

/**
 * What this phase may actually spend right now: its own unused allocation plus
 * whatever the other four phases have left unused (borrowing), hard-capped by
 * the global remaining. Pure, so the supervisor can read one report per tick.
 */
export function availableForPhase(report: BudgetReport, phase: SpendPhase): number {
  let own = 0;
  let borrowable = 0;
  for (const p of report.phases) {
    if (p.phase === phase) own += p.remainingUsd;
    else borrowable += p.remainingUsd;
  }
  return round6(Math.max(0, Math.min(own + borrowable, report.globalRemainingUsd)));
}

/** Cheap pre-check. Never lets a phase push total spend past the global cap. */
export async function canSpend(phase: SpendPhase, projectedUsd: number): Promise<boolean> {
  if (!Number.isFinite(projectedUsd) || projectedUsd < 0) return false;
  const report = await getBudgetReport();
  // BOTH tests must pass. The global one binds even when the phase has room.
  if (projectedUsd > report.globalRemainingUsd) return false;
  return projectedUsd <= availableForPhase(report, phase);
}

/**
 * Which denormalized opportunity column a phase rolls up into. The three
 * columns are coarser than the five phases on purpose: they exist so ranking
 * and the dashboard can read spend without a join.
 */
const OPPORTUNITY_SPEND_COLUMN: Record<SpendPhase, 'research' | 'prospecting' | 'validation'> = {
  DISCOVERY: 'research',
  RESEARCH: 'research',
  PROSPECTING: 'prospecting',
  REPLY: 'validation',
  FINAL_ANALYSIS: 'validation',
};

const SPEND_COLUMN_SQL = {
  research: 'research_spend_usd',
  prospecting: 'prospecting_spend_usd',
  validation: 'validation_spend_usd',
} as const;

export async function recordPhaseSpend(params: {
  phase: SpendPhase;
  opportunityId: string | null;
  usd: number;
}): Promise<void> {
  if (!Number.isFinite(params.usd) || params.usd <= 0) return;
  const usd = round6(params.usd);
  const db = await getDb();
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO phase_spend (id, period, phase, opportunity_id, spend_usd)
       VALUES ($1,$2,$3,$4,$5)`,
      [newId('psp'), currentPeriod(), params.phase, params.opportunityId, usd],
    );
    if (params.opportunityId) {
      // Column name comes from the typed map above, never from input.
      const column = SPEND_COLUMN_SQL[OPPORTUNITY_SPEND_COLUMN[params.phase]];
      await tx.query(
        `UPDATE opportunities SET ${column} = ${column} + $2, updated_at = now() WHERE id = $1`,
        [params.opportunityId, usd],
      );
    }
  });
  logger.info('phase spend recorded', { phase: params.phase, usd, opportunityId: params.opportunityId });
}

export async function opportunitySpend(opportunityId: string): Promise<{
  research: number;
  prospecting: number;
  validation: number;
  total: number;
}> {
  const db = await getDb();
  const res = await db.query<{ phase: string | null; total: string | number | null }>(
    `SELECT phase, COALESCE(SUM(amount), 0) AS total
       FROM (
         SELECT phase AS phase, estimated_cost AS amount
           FROM cost_ledger WHERE opportunity_id = $1
         UNION ALL
         SELECT phase AS phase, spend_usd AS amount
           FROM phase_spend WHERE opportunity_id = $1
       ) s
      GROUP BY phase`,
    [opportunityId],
  );

  const out = { research: 0, prospecting: 0, validation: 0, total: 0 };
  for (const row of res.rows) {
    const amount = toNumber(row.total, 0);
    out.total = round6(out.total + amount);
    if (!isSpendPhase(row.phase)) continue; // attributed to the opportunity, not to a phase
    const bucket = OPPORTUNITY_SPEND_COLUMN[row.phase];
    out[bucket] = round6(out[bucket] + amount);
  }
  return out;
}

// --- information per dollar ----------------------------------------------------

/**
 * How close each state is to a decision the owner cares about. Research is not
 * validation, so proximity rises steeply only once real prospects and real
 * replies are involved. Dead states are worth nothing.
 */
const DECISION_PROXIMITY: Record<string, number> = {
  DISCOVERED: 0.1,
  CATEGORY_VERIFYING: 0.25,
  CATEGORY_VERIFIED: 0.45,
  WEDGE_GENERATED: 0.6,
  PROSPECTING: 0.75,
  CAMPAIGN_READY: 0.9,
  VALIDATING: 1,
  VALIDATION_STRONG: 1,
  READY_TO_BUILD: 0,
  CATEGORY_REJECTED: 0,
  PROSPECTABILITY_REJECTED: 0,
  VALIDATION_FAILED: 0,
  ARCHIVED: 0,
};

const EVIDENCE_WEIGHT: Record<string, number> = { HIGH: 1, MEDIUM: 0.6, LOW: 0.2, NONE: 0 };

/** Deterministic weights. They sum to 1 so the raw score lands in [0,1]. */
const INFORMATION_WEIGHTS = {
  proximity: 0.25,
  commitments: 0.25,
  prospects: 0.2,
  evidence: 0.15,
  stage: 0.1,
  contactability: 0.05,
} as const;

/**
 * The spend at which an opportunity is considered to have had its fair share
 * of the research budget. Derived from control-plane config; used only to
 * shape a preference, never as a ceiling.
 */
function referenceSpendUsd(): number {
  const cfg = getConfig();
  const share =
    (cfg.monthlyLlmBudgetUsd * cfg.subBudgets.researchPct) /
    Math.max(1, cfg.concurrency.maxResearchOpportunities);
  return Math.max(0.01, round6(share));
}

interface InformationRow {
  state: string;
  research_stage: number | string | null;
  evidence_confidence: string | null;
  qualified: number | string | null;
  contactable: number | string | null;
  committed: number | string | null;
}

/**
 * Information per dollar. Higher means "this action teaches us more per unit
 * of spend" — the supervisor prefers qualifying 50 prospects for a strong
 * category over more research on a weak one.
 *
 * Rewards closeness to a decision (state, research stage, verified evidence,
 * qualified and contactable prospects, observed commitments) and penalises
 * what has already been spent on this opportunity. Deterministic: same rows
 * in, same number out. No LLM, no randomness.
 */
export async function expectedInformationValue(opportunityId: string): Promise<number> {
  const cfg = getConfig();
  const row = await one<InformationRow>(
    `SELECT o.state,
            o.research_stage,
            o.evidence_confidence,
            (SELECT COUNT(*) FROM prospects p
              WHERE p.opportunity_id = o.id
                AND p.status IN ('QUALIFIED','CONTACTED','REPLIED','COMMITTED')) AS qualified,
            (SELECT COUNT(*) FROM prospects p
              WHERE p.opportunity_id = o.id
                AND p.contact_email IS NOT NULL
                AND p.email_is_public
                AND p.status IN ('QUALIFIED','CONTACTED','REPLIED','COMMITTED')) AS contactable,
            (SELECT COUNT(DISTINCT cm.company_key)
               FROM commitments cm
               JOIN campaigns c ON c.id = cm.campaign_id
              WHERE c.opportunity_id = o.id) AS committed
       FROM opportunities o
      WHERE o.id = $1`,
    [opportunityId],
  );
  if (!row) return 0;

  const proximity = DECISION_PROXIMITY[row.state] ?? 0;
  if (proximity <= 0) {
    await persistInformationValue(opportunityId, 0);
    return 0;
  }

  const qualified = toNumber(row.qualified, 0);
  const contactable = toNumber(row.contactable, 0);
  const committed = toNumber(row.committed, 0);

  const factors = {
    proximity,
    commitments: clamp01(committed / Math.max(1, cfg.gate.minUniqueStrongCommitments)),
    prospects: clamp01(qualified / Math.max(1, cfg.gate.minQualifiedProspects)),
    evidence: EVIDENCE_WEIGHT[row.evidence_confidence ?? 'NONE'] ?? 0,
    // Five escalating research stages; stage 4 is the reasoner on finalists.
    stage: clamp01(toNumber(row.research_stage, 0) / 4),
    contactability: qualified > 0 ? clamp01(contactable / qualified) : 0,
  };

  let information = 0;
  for (const [key, weight] of Object.entries(INFORMATION_WEIGHTS)) {
    information += weight * factors[key as keyof typeof factors];
  }

  const spent = await opportunitySpend(opportunityId);
  const value = clamp01(information / (1 + spent.total / referenceSpendUsd()));
  const rounded = Math.round(value * 1e5) / 1e5;
  await persistInformationValue(opportunityId, rounded);
  return rounded;
}

async function persistInformationValue(opportunityId: string, value: number): Promise<void> {
  const db = await getDb();
  await db.query(`UPDATE opportunities SET expected_information_value = $2 WHERE id = $1`, [
    opportunityId,
    value,
  ]);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
