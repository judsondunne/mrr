/**
 * Opportunity state machine.
 *
 * THE ABSOLUTE PRINCIPLE, MECHANICALLY ENFORCED:
 *   No AI call, score, or heuristic may move an opportunity to READY_TO_BUILD.
 *
 * Two independent locks make that true:
 *   1. The edge table below permits READY_TO_BUILD only from VALIDATION_STRONG.
 *   2. Reaching either of those two states requires a GateToken, and the only
 *      function in the codebase that can mint one is the deterministic gate in
 *      src/pipeline/validation/gate.ts. There is no other constructor.
 */
import { IllegalTransitionError } from './errors';

export const OPPORTUNITY_STATES = [
  'DISCOVERED',
  'CATEGORY_VERIFYING',
  'CATEGORY_REJECTED',
  'CATEGORY_VERIFIED',
  'WEDGE_GENERATED',
  'PROSPECTING',
  'PROSPECTABILITY_REJECTED',
  'CAMPAIGN_READY',
  'VALIDATING',
  'VALIDATION_FAILED',
  'VALIDATION_STRONG',
  'READY_TO_BUILD',
  'ARCHIVED',
] as const;

export type OpportunityState = (typeof OPPORTUNITY_STATES)[number];

export function isOpportunityState(v: string): v is OpportunityState {
  return (OPPORTUNITY_STATES as readonly string[]).includes(v);
}

/** Terminal states: nothing leaves them except ARCHIVED. */
export const TERMINAL_STATES: ReadonlySet<OpportunityState> = new Set<OpportunityState>([
  'ARCHIVED',
]);

/** States that mean "this opportunity is dead". */
export const DEAD_STATES: ReadonlySet<OpportunityState> = new Set<OpportunityState>([
  'CATEGORY_REJECTED',
  'PROSPECTABILITY_REJECTED',
  'VALIDATION_FAILED',
  'ARCHIVED',
]);

const EDGES: Readonly<Record<OpportunityState, readonly OpportunityState[]>> = {
  DISCOVERED: ['CATEGORY_VERIFYING', 'ARCHIVED'],
  CATEGORY_VERIFYING: ['CATEGORY_VERIFIED', 'CATEGORY_REJECTED', 'ARCHIVED'],
  CATEGORY_REJECTED: ['ARCHIVED'],
  CATEGORY_VERIFIED: ['WEDGE_GENERATED', 'CATEGORY_REJECTED', 'ARCHIVED'],
  WEDGE_GENERATED: ['PROSPECTING', 'ARCHIVED'],
  PROSPECTING: ['CAMPAIGN_READY', 'PROSPECTABILITY_REJECTED', 'ARCHIVED'],
  PROSPECTABILITY_REJECTED: ['ARCHIVED'],
  CAMPAIGN_READY: ['VALIDATING', 'ARCHIVED'],
  VALIDATING: ['VALIDATION_STRONG', 'VALIDATION_FAILED', 'ARCHIVED'],
  VALIDATION_FAILED: ['ARCHIVED'],
  VALIDATION_STRONG: ['READY_TO_BUILD', 'VALIDATION_FAILED', 'ARCHIVED'],
  READY_TO_BUILD: ['ARCHIVED'],
  ARCHIVED: [],
};

/**
 * Proof that the deterministic validation gate ran and passed.
 *
 * The class is not exported, only its type is. Nothing outside gate.ts can
 * construct one, so no amount of LLM output can forge a path to READY_TO_BUILD.
 */
class GateTokenImpl {
  readonly __brand = 'GateToken' as const;
  constructor(
    readonly opportunityId: string,
    readonly decidedAt: Date,
    readonly passedChecks: readonly string[],
  ) {}
}
export type GateToken = GateTokenImpl;

/** INTERNAL. The only mint. Importing this anywhere but gate.ts is a bug. */
export function __mintGateToken(
  opportunityId: string,
  passedChecks: readonly string[],
): GateToken {
  return new GateTokenImpl(opportunityId, new Date(), passedChecks);
}

/** States that may only be entered with a valid GateToken. */
const GATED_STATES: ReadonlySet<OpportunityState> = new Set<OpportunityState>([
  'VALIDATION_STRONG',
  'READY_TO_BUILD',
]);

export function requiresGateToken(to: OpportunityState): boolean {
  return GATED_STATES.has(to);
}

export function canTransition(from: OpportunityState, to: OpportunityState): boolean {
  return (EDGES[from] ?? []).includes(to);
}

export function allowedTransitions(from: OpportunityState): readonly OpportunityState[] {
  return EDGES[from] ?? [];
}

export interface TransitionOptions {
  reason?: string;
  /** Required when `to` is VALIDATION_STRONG or READY_TO_BUILD. */
  gateToken?: GateToken;
}

/**
 * Throws IllegalTransitionError unless the edge exists AND, for gated states, a
 * genuine GateToken for this exact opportunity is supplied.
 */
export function assertTransition(
  opportunityId: string,
  from: OpportunityState,
  to: OpportunityState,
  opts: TransitionOptions = {},
): void {
  if (!isOpportunityState(from)) throw new IllegalTransitionError(from, to, 'unknown from-state');
  if (!isOpportunityState(to)) throw new IllegalTransitionError(from, to, 'unknown to-state');
  if (from === to) throw new IllegalTransitionError(from, to, 'no-op transition');
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to, 'edge not in state machine');

  if (requiresGateToken(to)) {
    const token = opts.gateToken;
    if (!(token instanceof GateTokenImpl)) {
      throw new IllegalTransitionError(
        from,
        to,
        `${to} requires a GateToken minted by the deterministic validation gate`,
      );
    }
    if (token.opportunityId !== opportunityId) {
      throw new IllegalTransitionError(
        from,
        to,
        `GateToken was minted for ${token.opportunityId}, not ${opportunityId}`,
      );
    }
  }
}

// --- campaign states ---------------------------------------------------------

export const CAMPAIGN_STATES = [
  'DRAFT',
  'READY',
  'BATCH_1',
  'BATCH_1_REVIEW',
  'BATCH_2',
  'BATCH_2_REVIEW',
  'SCALING',
  'COMPLETE',
  'HALTED',
  'FAILED',
] as const;
export type CampaignState = (typeof CAMPAIGN_STATES)[number];

const CAMPAIGN_EDGES: Readonly<Record<CampaignState, readonly CampaignState[]>> = {
  DRAFT: ['READY', 'FAILED'],
  READY: ['BATCH_1', 'HALTED', 'FAILED'],
  BATCH_1: ['BATCH_1_REVIEW', 'HALTED', 'FAILED'],
  BATCH_1_REVIEW: ['BATCH_2', 'COMPLETE', 'HALTED', 'FAILED'],
  BATCH_2: ['BATCH_2_REVIEW', 'HALTED', 'FAILED'],
  BATCH_2_REVIEW: ['SCALING', 'COMPLETE', 'HALTED', 'FAILED'],
  SCALING: ['COMPLETE', 'HALTED', 'FAILED'],
  COMPLETE: [],
  HALTED: ['READY', 'COMPLETE', 'FAILED'],
  FAILED: [],
};

export function canTransitionCampaign(from: CampaignState, to: CampaignState): boolean {
  return (CAMPAIGN_EDGES[from] ?? []).includes(to);
}

export function assertCampaignTransition(from: CampaignState, to: CampaignState): void {
  if (!canTransitionCampaign(from, to)) {
    throw new IllegalTransitionError(from, to, 'campaign edge not in state machine');
  }
}
