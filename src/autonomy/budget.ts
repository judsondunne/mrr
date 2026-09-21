/**
 * PUBLIC API — COST INTELLIGENCE. Owned by the supervisor agent.
 *
 * The global monthly ceiling is a HARD control-plane limit and is enforced by
 * lib/cost.ts. This module allocates *within* it: five sub-budgets that may
 * borrow from one another but can never sum past the global cap.
 */
import type { SpendPhase } from './types';

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

export declare function getBudgetReport(): Promise<BudgetReport>;

/** Cheap pre-check. Never lets a phase push total spend past the global cap. */
export declare function canSpend(phase: SpendPhase, projectedUsd: number): Promise<boolean>;

export declare function recordPhaseSpend(params: {
  phase: SpendPhase;
  opportunityId: string | null;
  usd: number;
}): Promise<void>;

/**
 * Information per dollar. Higher means "this action teaches us more per unit
 * of spend" — the supervisor prefers qualifying 50 prospects for a strong
 * category over more research on a weak one.
 */
export declare function expectedInformationValue(opportunityId: string): Promise<number>;

export declare function opportunitySpend(opportunityId: string): Promise<{
  research: number;
  prospecting: number;
  validation: number;
  total: number;
}>;
