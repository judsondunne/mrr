/**
 * PUBLIC API — BUILD SPEC GENERATOR. Owned by the validation agent.
 *
 * Writes validated/<slug>/ — a directory good enough to hand to a fresh Claude
 * Code session with "Build this. Do not expand scope."
 */
export interface BuildSpecResult {
  slug: string;
  directory: string;
  files: string[];
}

export declare function generateBuildSpec(opportunityId: string): Promise<BuildSpecResult>;
