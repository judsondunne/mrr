/**
 * Beta-Bernoulli Thompson sampling over the strategy dimensions.
 *
 * Why a bandit at all: the system must keep trying new ideas while spending
 * most of its (small) budget on what has actually produced commitments. A
 * bandit does that without anyone declaring a winner by eye.
 *
 * Why Beta-Bernoulli: the reward is a bounded downstream score in [0,1], so a
 * Beta posterior with a uniform Beta(1,1) prior is the honest representation of
 * "we do not know yet". The prior matters — a brand-new arm looks uncertain,
 * not bad.
 *
 * OVERFITTING PROTECTION IS THE POINT. Nothing here reports a winner. It
 * reports a sample, a posterior, a credible interval, and whether the arm has
 * enough trials for any of that to mean anything. "2 replies out of 9" comes
 * back with `hasSufficientSample: false` and an interval roughly [0.07, 0.54],
 * which is the correct answer to "is this arm better?": we cannot tell.
 *
 * Every random draw comes from an injectable `rng`, so a simulation replays
 * byte-identically.
 */
import { getConfig } from '../../lib/config';
import { getDb, toNumber } from '../../lib/db';
import { newId } from '../../lib/hash';
import { createLogger } from '../../lib/logger';
import type { Allocation, BanditArm, StrategyDimension } from '../types';
import { clamp01 } from './util';

const logger = createLogger('strategy:bandit');

// --- rng ---------------------------------------------------------------------

/**
 * mulberry32. Small, fast, and good enough for sampling — its only job is to
 * make an experiment reproducible from a seed.
 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform in (0,1). Excludes 0 so log() is always finite. */
function positiveUniform(rng: () => number): number {
  let u = rng();
  while (!(u > 0)) u = rng();
  return u;
}

function standardNormal(rng: () => number): number {
  // Box-Muller. One of the two normals is discarded; clarity beats the saving.
  const u1 = positiveUniform(rng);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Marsaglia-Tsang. No dependency, no lookup tables, valid for any shape > 0
 * (shapes below 1 are boosted and scaled back down).
 */
export function sampleGamma(shape: number, rng: () => number): number {
  if (!Number.isFinite(shape) || shape <= 0) return 0;
  if (shape < 1) {
    const u = positiveUniform(rng);
    return sampleGamma(shape + 1, rng) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  // Bounded so a pathological rng cannot hang a job. The fallback is the mean.
  for (let attempt = 0; attempt < 1000; attempt++) {
    let x = 0;
    let v = 0;
    do {
      x = standardNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = positiveUniform(rng);
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  return shape;
}

/** theta ~ Beta(alpha, beta), built from two Gamma draws. */
export function sampleBeta(alpha: number, beta: number, rng: () => number): number {
  const a = Number.isFinite(alpha) && alpha > 0 ? alpha : 1;
  const b = Number.isFinite(beta) && beta > 0 ? beta : 1;
  const x = sampleGamma(a, rng);
  const y = sampleGamma(b, rng);
  const total = x + y;
  if (!(total > 0)) return a / (a + b);
  return clamp01(x / total);
}

// --- posterior ---------------------------------------------------------------

export interface ArmPosterior {
  armKey: string;
  /** Posterior mean of the Beta(alpha, beta). */
  mean: number;
  /** Equal-tailed credible interval bounds at `credibleMass`. */
  lower: number;
  upper: number;
  /** Wide interval = "we do not know yet", however flattering the mean looks. */
  width: number;
  credibleMass: number;
  trials: number;
  /** False until the arm has cfg.learning.minSampleSize trials. */
  hasSufficientSample: boolean;
}

const LANCZOS = [
  76.18009172947146, -86.50532032941677, 24.01409824083091,
  -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
] as const;

function logGamma(x: number): number {
  let y = x;
  const tmp0 = x + 5.5;
  const tmp = tmp0 - (x + 0.5) * Math.log(tmp0);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) {
    y += 1;
    ser += LANCZOS[j]! / y;
  }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** Continued-fraction expansion used by the regularized incomplete beta. */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const MAX_ITERATIONS = 300;
  const EPS = 3e-14;
  const TINY = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITERATIONS; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** P(theta <= x) for theta ~ Beta(a, b). */
export function betaCdf(a: number, b: number, x: number): number {
  if (!(x > 0)) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(a, b, x)) / a
    : 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** Inverse CDF by bisection. 80 steps puts the answer well inside float noise. */
export function betaQuantile(p: number, a: number, b: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (betaCdf(a, b, mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * The honest summary of an arm. Callers that want to say "X beats Y" must look
 * at `hasSufficientSample` and at the interval, not at `mean`.
 */
export function armPosterior(arm: BanditArm, credibleMass = 0.95): ArmPosterior {
  const alpha = arm.alpha > 0 ? arm.alpha : 1;
  const beta = arm.beta > 0 ? arm.beta : 1;
  const tail = (1 - clamp01(credibleMass)) / 2;
  const lower = betaQuantile(tail, alpha, beta);
  const upper = betaQuantile(1 - tail, alpha, beta);
  return {
    armKey: arm.armKey,
    mean: alpha / (alpha + beta),
    lower,
    upper,
    width: upper - lower,
    credibleMass,
    trials: arm.trials,
    hasSufficientSample: hasSufficientSample(arm),
  };
}

/** False until the arm has cfg.learning.minSampleSize trials. */
export function hasSufficientSample(arm: BanditArm): boolean {
  return arm.trials >= getConfig().learning.minSampleSize;
}

// --- selection ---------------------------------------------------------------

export interface AllocationOptions {
  explorationRatio?: number;
  rng?: () => number;
}

/**
 * The selection rule itself, pure and synchronous so it can be replayed
 * thousands of times in a test without touching the database.
 *
 * With probability `explorationRatio` the pick is PURE EXPLORATION: uniform
 * among the arms that have been tried least. That reserve is what stops the
 * system settling permanently into the first niche that worked. Otherwise it is
 * Thompson sampling: draw theta from each arm's posterior and take the largest
 * draw, which spends attention in proportion to the probability that the arm is
 * genuinely best.
 */
export function chooseAllocation(
  arms: readonly BanditArm[],
  opts: AllocationOptions = {},
): Allocation | null {
  const enabled = arms.filter((a) => a.enabled);
  if (enabled.length === 0) return null;

  const rng = opts.rng ?? Math.random;
  const explorationRatio = clamp01(opts.explorationRatio ?? getConfig().learning.explorationRatio);

  if (rng() < explorationRatio) {
    const fewest = Math.min(...enabled.map((a) => a.trials));
    const candidates = enabled.filter((a) => a.trials === fewest);
    const index = Math.min(candidates.length - 1, Math.floor(rng() * candidates.length));
    const arm = candidates[index]!;
    return {
      armKey: arm.armKey,
      exploring: true,
      // No posterior draw is involved in an exploration pick; report the mean
      // so the number is never mistaken for evidence.
      sampledValue: arm.alpha / (arm.alpha + arm.beta),
      hasSufficientSample: hasSufficientSample(arm),
    };
  }

  let best = enabled[0]!;
  let bestDraw = -1;
  for (const arm of enabled) {
    const theta = sampleBeta(arm.alpha, arm.beta, rng);
    if (theta > bestDraw) {
      bestDraw = theta;
      best = arm;
    }
  }
  return {
    armKey: best.armKey,
    exploring: false,
    sampledValue: bestDraw,
    hasSufficientSample: hasSufficientSample(best),
  };
}

// --- persistence -------------------------------------------------------------

interface ArmRow {
  dimension: string;
  arm_key: string;
  alpha: string | number;
  beta: string | number;
  trials: string | number;
  successes: string | number;
  total_reward: string | number;
  enabled: boolean;
}

const ARM_COLUMNS = 'dimension, arm_key, alpha, beta, trials, successes, total_reward, enabled';

function toArm(row: ArmRow): BanditArm {
  return {
    dimension: row.dimension as StrategyDimension,
    armKey: row.arm_key,
    alpha: toNumber(row.alpha, 1),
    beta: toNumber(row.beta, 1),
    trials: toNumber(row.trials),
    successes: toNumber(row.successes),
    totalReward: toNumber(row.total_reward),
    enabled: row.enabled === true,
  };
}

/** Creates the arm at the uniform Beta(1,1) prior if it does not exist yet. */
export async function ensureArm(dimension: StrategyDimension, armKey: string): Promise<BanditArm> {
  const key = armKey.trim();
  const db = await getDb();
  await db.query(
    `INSERT INTO bandit_arms (id, dimension, arm_key, alpha, beta)
     VALUES ($1,$2,$3,1,1)
     ON CONFLICT (dimension, arm_key) DO NOTHING`,
    [newId('arm'), dimension, key],
  );
  const res = await db.query<ArmRow>(
    `SELECT ${ARM_COLUMNS} FROM bandit_arms WHERE dimension = $1 AND arm_key = $2`,
    [dimension, key],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`bandit arm ${dimension}:${key} vanished immediately after insert`);
  return toArm(row);
}

export async function getArms(dimension: StrategyDimension): Promise<BanditArm[]> {
  const db = await getDb();
  const res = await db.query<ArmRow>(
    `SELECT ${ARM_COLUMNS} FROM bandit_arms WHERE dimension = $1 ORDER BY arm_key ASC`,
    [dimension],
  );
  return res.rows.map(toArm);
}

/**
 * Thompson sampling with a reserved exploration share. Returns null only when
 * the dimension has no enabled arms at all.
 */
export async function selectArm(
  dimension: StrategyDimension,
  opts?: { explorationRatio?: number; rng?: () => number },
): Promise<Allocation | null> {
  const arms = await getArms(dimension);
  const allocation = chooseAllocation(arms, opts ?? {});
  if (!allocation) return null;
  const db = await getDb();
  await db.query(
    'UPDATE bandit_arms SET last_selected_at = now() WHERE dimension = $1 AND arm_key = $2',
    [dimension, allocation.armKey],
  );
  return allocation;
}

/** Applies a downstream reward in [0,1]. Engagement telemetry is never a reward. */
export async function updateArm(
  dimension: StrategyDimension,
  armKey: string,
  reward: number,
): Promise<BanditArm> {
  const key = armKey.trim();
  const r = clamp01(reward);
  const db = await getDb();
  // Upsert so the first observation of an arm starts from the Beta(1,1) prior
  // and lands atomically, without a read-modify-write two concurrent jobs
  // could interleave.
  const res = await db.query<ArmRow>(
    `INSERT INTO bandit_arms (id, dimension, arm_key, alpha, beta, trials, successes, total_reward)
     VALUES ($1,$2,$3, 1 + $4::numeric, 1 + $5::numeric, 1, $6::numeric, $4::numeric)
     ON CONFLICT (dimension, arm_key) DO UPDATE SET
       alpha = bandit_arms.alpha + $4::numeric,
       beta = bandit_arms.beta + $5::numeric,
       trials = bandit_arms.trials + 1,
       successes = bandit_arms.successes + $6::numeric,
       total_reward = bandit_arms.total_reward + $4::numeric,
       updated_at = now()
     RETURNING ${ARM_COLUMNS}`,
    [newId('arm'), dimension, key, r, 1 - r, r > 0 ? 1 : 0],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`bandit arm ${dimension}:${key} disappeared during update`);
  const arm = toArm(row);
  logger.debug('bandit arm updated', {
    dimension,
    armKey: key,
    reward: r,
    trials: arm.trials,
    sufficientSample: hasSufficientSample(arm),
  });
  return arm;
}
