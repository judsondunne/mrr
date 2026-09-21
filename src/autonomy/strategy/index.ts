/** PUBLIC API — STRATEGY MEMORY + LEARNING. Owned by the strategy agent. */

// --- versioned strategy ------------------------------------------------------

/**
 * `recordStrategyVersion` is THE ONLY write path into the strategy plane. It
 * rejects any config containing a control-plane field (see
 * FORBIDDEN_STRATEGY_FIELDS) and always appends a new version rather than
 * mutating history.
 */
export type { StrategyVersionRecord } from './store';
export { recordStrategyVersion, getActiveStrategy, listStrategyHistory } from './store';

// --- bandit ------------------------------------------------------------------

/**
 * Beta-Bernoulli Thompson sampling with a reserved exploration share.
 * `selectArm` returns null only when the dimension has no enabled arms at all,
 * `updateArm` applies a downstream reward in [0,1] (engagement telemetry is
 * never a reward),
 * and `hasSufficientSample` is false until the arm has
 * cfg.learning.minSampleSize trials.
 *
 * `armPosterior` is the anti-overfitting surface: it exposes the posterior mean
 * WITH a credible interval, so a two-of-nine arm cannot be read as a winner.
 */
export type { ArmPosterior, AllocationOptions } from './bandit';
export {
  ensureArm,
  getArms,
  selectArm,
  updateArm,
  hasSufficientSample,
  armPosterior,
  chooseAllocation,
  makeRng,
} from './bandit';

// --- outcomes ----------------------------------------------------------------

/** `computeReward` is pure and weighted by measured downstream results only. */
export {
  computeReward,
  recordOutcome,
  armsForOutcome,
  REWARD_SATURATION_PER_100_DELIVERED,
  MIN_EFFECTIVE_DELIVERED,
} from './outcomes';

// --- memory ------------------------------------------------------------------

/**
 * `findSimilarFailure` does structural similarity against past failures. It
 * blocks rediscovering the same dead idea weekly unless the new hypothesis
 * contains a MATERIAL change (different ICP, very different price, different
 * wedge, different channel). `writePostMortem` is written for every failed
 * experiment — the owner never receives these.
 */
export type { FailureRecord, FailureCandidate, MaterialChangeVerdict } from './memory';
export {
  recordFailure,
  findSimilarFailure,
  isAvoidedCategory,
  materialChangeAgainst,
  recordSuccessPattern,
  getSuccessBias,
  writePostMortem,
} from './memory';

// --- hypothesis intake --------------------------------------------------------

/** `checkEligibility` is the deterministic admission check. It runs BEFORE anything is spent. */
export { checkEligibility, proposeHypotheses, candidateFrom, contentKeyFor } from './propose';
