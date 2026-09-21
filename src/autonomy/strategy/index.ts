/** PUBLIC API — STRATEGY MEMORY + LEARNING. Owned by the strategy agent. */
import type {
  Allocation, BanditArm, EligibilityVerdict, HypothesisProposal,
  OutcomeInput, OutcomeResults, StrategyDimension,
} from '../types';

// --- versioned strategy ------------------------------------------------------

export interface StrategyVersionRecord {
  id: string;
  dimension: StrategyDimension;
  armKey: string;
  version: number;
  config: Record<string, unknown>;
  reason: string;
  active: boolean;
}

/**
 * THE ONLY write path into the strategy plane. Rejects any config containing a
 * control-plane field (see FORBIDDEN_STRATEGY_FIELDS) and always appends a new
 * version rather than mutating history.
 */
export declare function recordStrategyVersion(params: {
  dimension: StrategyDimension;
  armKey: string;
  config: Record<string, unknown>;
  reason: string;
  hypothesisId?: string | null;
}): Promise<StrategyVersionRecord>;

export declare function getActiveStrategy(
  dimension: StrategyDimension,
  armKey: string,
): Promise<StrategyVersionRecord | null>;

export declare function listStrategyHistory(
  dimension: StrategyDimension,
  armKey: string,
): Promise<StrategyVersionRecord[]>;

// --- bandit ------------------------------------------------------------------

export declare function ensureArm(dimension: StrategyDimension, armKey: string): Promise<BanditArm>;
export declare function getArms(dimension: StrategyDimension): Promise<BanditArm[]>;

/**
 * Thompson sampling with a reserved exploration share. Returns null only when
 * the dimension has no enabled arms at all.
 */
export declare function selectArm(
  dimension: StrategyDimension,
  opts?: { explorationRatio?: number; rng?: () => number },
): Promise<Allocation | null>;

/** Applies a downstream reward in [0,1]. Opens are never a reward. */
export declare function updateArm(
  dimension: StrategyDimension,
  armKey: string,
  reward: number,
): Promise<BanditArm>;

/** False until the arm has cfg.learning.minSampleSize trials. */
export declare function hasSufficientSample(arm: BanditArm): boolean;

// --- outcomes ----------------------------------------------------------------

/** Computes the weighted downstream reward. Pure. */
export declare function computeReward(results: OutcomeResults): number;

export declare function recordOutcome(
  input: OutcomeInput,
  results: OutcomeResults,
): Promise<{ id: string; reward: number }>;

// --- memory ------------------------------------------------------------------

export interface FailureRecord {
  id: string;
  category: string;
  icp: string | null;
  wedge: string | null;
  priceMonthly: number | null;
  reasonFailed: string;
  sampleSize: number;
  lesson: string | null;
  avoidCategory: boolean;
}

export declare function recordFailure(params: {
  opportunityId: string | null;
  ecosystem: string | null;
  category: string;
  icp: string | null;
  wedge: string | null;
  wedgeType: string | null;
  priceMonthly: number | null;
  reasonFailed: string;
  sampleSize: number;
  campaignEvidence?: Record<string, unknown>;
  lesson?: string;
}): Promise<FailureRecord>;

/**
 * Structural similarity against past failures. Blocks rediscovering the same
 * dead idea weekly unless the new hypothesis contains a MATERIAL change
 * (different ICP, very different price, different wedge, different channel).
 */
export declare function findSimilarFailure(candidate: {
  category: string;
  icp?: string | null;
  wedge?: string | null;
  priceMonthly?: number | null;
}): Promise<{ failure: FailureRecord; similarity: number } | null>;

export declare function recordSuccessPattern(opportunityId: string): Promise<void>;

/** Tokens from past winners, used to bias discovery toward adjacent patterns. */
export declare function getSuccessBias(): Promise<{ tokens: string[]; weight: number }>;

/** Written for every failed experiment. The owner never receives these. */
export declare function writePostMortem(opportunityId: string): Promise<{ id: string; lesson: string }>;

// --- hypothesis intake --------------------------------------------------------

/** Deterministic admission check. Runs BEFORE anything is spent on a proposal. */
export declare function checkEligibility(p: HypothesisProposal): Promise<EligibilityVerdict>;

export declare function proposeHypotheses(limit: number): Promise<{
  proposed: number;
  admitted: number;
  rejected: Array<{ hypothesis: string; reasons: string[] }>;
}>;
