/**
 * PUBLIC API — BUILD-TIME FEASIBILITY REVALIDATION. Owned by the evidence agent.
 *
 * Runs immediately before the owner is told to build something. Never
 * recommend a product whose key API may not exist.
 */
export interface FeasibilityReport {
  opportunityId: string;
  feasible: boolean;
  checkedAt: Date;
  checks: Array<{
    name: string;
    passed: boolean;
    detail: string;
    sourceUrl: string | null;
  }>;
  estimatedBuildDays: number | null;
  blockers: string[];
}

export declare function revalidateFeasibility(opportunityId: string): Promise<FeasibilityReport>;

/** A small automatic technical spike when a capability claim is uncertain. */
export declare function runTechnicalSpike(params: {
  opportunityId: string;
  capability: string;
}): Promise<{ resolved: boolean; evidenceUrl: string | null; note: string }>;
