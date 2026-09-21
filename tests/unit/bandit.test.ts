/**
 * Thompson sampling, exploration, and the sample-size guard.
 *
 * The two properties that matter here are opposites, and both have to hold:
 *   1. allocation must MOVE toward whatever actually produces commitments;
 *   2. it must never CLAIM a winner from a handful of trials.
 *
 * Every random draw comes from a seeded rng, so these are deterministic tests
 * of a stochastic algorithm rather than flaky ones.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { freshDb, teardown } from '../helpers';
import {
  armPosterior,
  betaCdf,
  betaQuantile,
  chooseAllocation,
  ensureArm,
  getArms,
  hasSufficientSample,
  makeRng,
  sampleBeta,
  selectArm,
  updateArm,
} from '../../src/autonomy/strategy/bandit';
import type { BanditArm } from '../../src/autonomy/types';

afterEach(async () => {
  await teardown();
});

function arm(armKey: string, alpha: number, beta: number, trials: number, enabled = true): BanditArm {
  return { dimension: 'ICP_SEGMENT', armKey, alpha, beta, trials, successes: 0, totalReward: 0, enabled };
}

describe('Beta sampling is correct and reproducible', () => {
  it('reproduces the posterior mean from two Gamma draws', () => {
    const rng = makeRng(42);
    let total = 0;
    const draws = 20_000;
    for (let i = 0; i < draws; i++) total += sampleBeta(7, 3, rng);
    expect(total / draws).toBeCloseTo(0.7, 2);

    const uniform = makeRng(7);
    let flat = 0;
    for (let i = 0; i < draws; i++) flat += sampleBeta(1, 1, uniform);
    expect(flat / draws).toBeCloseTo(0.5, 2);
  });

  it('stays inside [0,1] and is identical for an identical seed', () => {
    const a = makeRng(99);
    const b = makeRng(99);
    for (let i = 0; i < 500; i++) {
      const x = sampleBeta(2.5, 9.25, a);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
      expect(x).toBe(sampleBeta(2.5, 9.25, b));
    }
  });

  it('agrees with the analytic Beta CDF it inverts', () => {
    expect(betaCdf(3, 8, betaQuantile(0.025, 3, 8))).toBeCloseTo(0.025, 6);
    expect(betaCdf(3, 8, betaQuantile(0.975, 3, 8))).toBeCloseTo(0.975, 6);
  });
});

describe('a small sample can never look conclusive', () => {
  it('reports 2 successes out of 9 as insufficient, with a very wide interval', async () => {
    await freshDb();
    // Beta(1,1) prior + 2 rewards + 7 non-rewards.
    const twoOfNine = arm('back-in-stock', 3, 8, 9);
    const posterior = armPosterior(twoOfNine);

    expect(hasSufficientSample(twoOfNine)).toBe(false);
    expect(posterior.hasSufficientSample).toBe(false);
    expect(posterior.mean).toBeCloseTo(0.2727, 3);
    // "22% reply rate!" is indistinguishable from 7% and from 55%.
    expect(posterior.lower).toBeLessThan(0.1);
    expect(posterior.upper).toBeGreaterThan(0.5);
    expect(posterior.width).toBeGreaterThan(0.4);
  });

  it('only calls the sample sufficient at cfg.learning.minSampleSize trials', async () => {
    await freshDb({ MIN_SAMPLE_SIZE: '30' });
    expect(hasSufficientSample(arm('a', 10, 21, 29))).toBe(false);
    expect(hasSufficientSample(arm('a', 10, 22, 30))).toBe(true);
    expect(armPosterior(arm('a', 25, 20, 43)).hasSufficientSample).toBe(true);
    // More evidence, narrower interval. That is the whole argument.
    expect(armPosterior(arm('a', 25, 20, 43)).width).toBeLessThan(armPosterior(arm('a', 3, 8, 9)).width);
  });

  it('carries the verdict on the Allocation itself, so callers cannot miss it', async () => {
    await freshDb({ MIN_SAMPLE_SIZE: '30' });
    await updateArm('ICP_SEGMENT', 'thin-evidence', 1);
    const thin = await selectArm('ICP_SEGMENT', { rng: makeRng(3) });
    expect(thin?.armKey).toBe('thin-evidence');
    expect(thin?.hasSufficientSample).toBe(false);

    for (let i = 0; i < 40; i++) await updateArm('ICP_SEGMENT', 'thin-evidence', i % 2);
    const thick = await selectArm('ICP_SEGMENT', { rng: makeRng(3) });
    expect(thick?.hasSufficientSample).toBe(true);
  });
});

describe('exploration is reserved, not incidental', () => {
  it('spends ~explorationRatio of picks on pure exploration over a large sample', () => {
    const arms = [arm('proven', 30, 10, 39), arm('untried', 2, 2, 2), arm('middling', 5, 5, 8)];
    const draws = 20_000;

    for (const ratio of [0.25, 0.1]) {
      const rng = makeRng(1234);
      let exploring = 0;
      for (let i = 0; i < draws; i++) {
        const allocation = chooseAllocation(arms, { explorationRatio: ratio, rng });
        if (allocation?.exploring) exploring += 1;
      }
      expect(exploring / draws).toBeGreaterThan(ratio - 0.02);
      expect(exploring / draws).toBeLessThan(ratio + 0.02);
    }
  });

  it('spends exploration on the least-tried arm, never on the leader', () => {
    const arms = [arm('proven', 300, 100, 399), arm('untried', 1, 1, 0), arm('middling', 5, 5, 8)];
    const rng = makeRng(2024);
    const explored = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const allocation = chooseAllocation(arms, { explorationRatio: 0.5, rng });
      if (allocation?.exploring) explored.add(allocation.armKey);
    }
    expect([...explored]).toEqual(['untried']);
  });

  it('reads the exploration ratio from config when none is given', async () => {
    await freshDb({ EXPLORATION_RATIO: '1' });
    const arms = [arm('proven', 300, 100, 399), arm('untried', 1, 1, 0)];
    const rng = makeRng(5);
    for (let i = 0; i < 50; i++) {
      expect(chooseAllocation(arms, { rng })?.armKey).toBe('untried');
    }
  });

  it('ignores disabled arms and returns null when nothing is enabled', () => {
    const rng = makeRng(11);
    expect(chooseAllocation([arm('off', 5, 5, 8, false)], { rng })).toBeNull();
    expect(chooseAllocation([], { rng })).toBeNull();
    const mixed = [arm('off', 50, 2, 51, false), arm('on', 1, 1, 0)];
    for (let i = 0; i < 100; i++) {
      expect(chooseAllocation(mixed, { rng })?.armKey).toBe('on');
    }
  });
});

describe('persistence', () => {
  it('creates arms at the uniform Beta(1,1) prior and is idempotent', async () => {
    await freshDb();
    const created = await ensureArm('PRICE_POINT', 'usd-29');
    expect(created).toMatchObject({ alpha: 1, beta: 1, trials: 0, enabled: true });
    await ensureArm('PRICE_POINT', 'usd-29');
    expect(await getArms('PRICE_POINT')).toHaveLength(1);
  });

  it('applies a reward as alpha += r, beta += 1 - r, and clamps out-of-range rewards', async () => {
    await freshDb();
    const half = await updateArm('SEND_TIME', 'tue-am', 0.5);
    expect(half).toMatchObject({ alpha: 1.5, beta: 1.5, trials: 1 });

    const over = await updateArm('SEND_TIME', 'tue-am', 5);
    expect(over).toMatchObject({ alpha: 2.5, beta: 1.5, trials: 2 });

    const under = await updateArm('SEND_TIME', 'tue-am', -3);
    expect(under).toMatchObject({ alpha: 2.5, beta: 2.5, trials: 3 });
    expect(under.totalReward).toBeCloseTo(1.5, 5);
    // successes counts trials that produced any downstream signal at all.
    expect(under.successes).toBe(2);
  });
});

describe('allocation converges on the arm that actually produces commitments', () => {
  it('shifts trials toward the better arm while still exploring the worse one', async () => {
    await freshDb({ EXPLORATION_RATIO: '0.25', MIN_SAMPLE_SIZE: '30' });
    const TRUE_RATE: Record<string, number> = { 'high-intent': 0.7, 'low-intent': 0.12 };
    await ensureArm('ICP_SEGMENT', 'high-intent');
    await ensureArm('ICP_SEGMENT', 'low-intent');

    const rng = makeRng(20260920);
    const world = makeRng(7);
    const picks: string[] = [];
    let exploring = 0;
    for (let round = 0; round < 200; round++) {
      const allocation = await selectArm('ICP_SEGMENT', { rng });
      expect(allocation).not.toBeNull();
      const key = allocation!.armKey;
      picks.push(key);
      if (allocation!.exploring) exploring += 1;
      // The reward is drawn from the WORLD, not from anything the system said.
      await updateArm('ICP_SEGMENT', key, world() < TRUE_RATE[key]! ? 1 : 0);
    }

    // The configured exploration share still holds across the whole run, so
    // convergence never came at the price of stopping the search.
    expect(exploring / 200).toBeGreaterThan(0.15);
    expect(exploring / 200).toBeLessThan(0.35);

    const arms = await getArms('ICP_SEGMENT');
    const good = arms.find((a) => a.armKey === 'high-intent')!;
    const bad = arms.find((a) => a.armKey === 'low-intent')!;

    expect(good.trials + bad.trials).toBe(200);
    expect(good.trials).toBeGreaterThan(bad.trials * 1.5);
    expect(armPosterior(good).mean).toBeGreaterThan(armPosterior(bad).mean + 0.3);

    // The last stretch is dominated by the winner...
    const tail = picks.slice(-50).filter((k) => k === 'high-intent').length;
    expect(tail).toBeGreaterThan(30);
    // ...but the loser is never abandoned, which is what the reserve buys.
    expect(picks.slice(-50).filter((k) => k === 'low-intent').length).toBeGreaterThan(0);

    // And after 200 rounds both arms have earned the right to be compared.
    expect(armPosterior(good).hasSufficientSample).toBe(true);
    expect(armPosterior(bad).hasSufficientSample).toBe(true);
  });
});
