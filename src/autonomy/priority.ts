/** PUBLIC API — PRIORITY + CONCURRENCY. Owned by the supervisor agent. */
import type { WorkKind } from './types';

export declare function priorityFor(kind: WorkKind): number;

export interface ConcurrencyState {
  researchOpportunities: number;
  deepResearchOpportunities: number;
  activeValidations: number;
  unsentProspects: number;
  monthlyExperiments: number;
}

export declare function getConcurrencyState(): Promise<ConcurrencyState>;

/** False when a configured concurrency ceiling would be exceeded. */
export declare function hasCapacityFor(kind: WorkKind): Promise<{ ok: boolean; reason: string | null }>;

export interface RankedOpportunity {
  opportunityId: string;
  score: number;
  factors: Record<string, number>;
}

/**
 * Ranking allocates resources. It NEVER bypasses a validation gate — an
 * opportunity ranked first still has to pass all ten deterministic checks.
 */
export declare function rankOpportunities(limit: number): Promise<RankedOpportunity[]>;
