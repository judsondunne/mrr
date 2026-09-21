/**
 * PUBLIC API — CONTROL-PLANE GUARD. Owned by the strategy agent.
 *
 * Adaptive does not mean unconstrained. Every strategy mutation passes through
 * here, and anything naming a control-plane field is refused.
 */
export declare class ControlPlaneViolation extends Error {
  readonly field: string;
  constructor(field: string, context: string);
}

/** Throws ControlPlaneViolation if the object touches a forbidden field. */
export declare function assertStrategyOnly(
  config: Record<string, unknown>,
  context: string,
): void;

export declare function findForbiddenFields(config: unknown): string[];
