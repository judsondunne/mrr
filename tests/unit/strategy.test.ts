/**
 * The learning layer: versioned strategy, the reward function, failure and
 * success memory, and the deterministic admission gate.
 *
 * The property under test throughout is the same one: every conclusion this
 * layer reaches must come from MEASURED downstream outcomes. An LLM may
 * propose; only code admits, and only real commitments score.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  freshDb,
  teardown,
  insertOpportunity,
  insertCampaign,
  insertProspect,
  insertDeliveredMessage,
  insertCommitment,
} from '../helpers';
import { count, toNumber } from '../../src/lib/db';
import { ControlPlaneViolation } from '../../src/autonomy/guard';
import {
  recordStrategyVersion,
  getActiveStrategy,
  listStrategyHistory,
} from '../../src/autonomy/strategy/store';
import { computeReward, recordOutcome } from '../../src/autonomy/strategy/outcomes';
import { getArms } from '../../src/autonomy/strategy/bandit';
import {
  findSimilarFailure,
  getSuccessBias,
  materialChangeAgainst,
  recordFailure,
  recordSuccessPattern,
  writePostMortem,
} from '../../src/autonomy/strategy/memory';
import { checkEligibility, proposeHypotheses } from '../../src/autonomy/strategy/propose';
import type { HypothesisProposal, OutcomeInput, OutcomeResults } from '../../src/autonomy/types';

/** Env this file overrides that tests/helpers.ts does not reset for us. */
const LOCAL_ENV = [
  'FAILURE_SIMILARITY_THRESHOLD',
  'EXPLORATION_RATIO',
  'MIN_SAMPLE_SIZE',
  'MAX_MONTHLY_EXPERIMENTS',
] as const;

afterEach(async () => {
  for (const key of LOCAL_ENV) delete process.env[key];
  await teardown();
});

// --- versioned strategy --------------------------------------------------------

describe('strategy versions are append-only', () => {
  it('appends a new version, links the previous one, and never rewrites history', async () => {
    const { db } = await freshDb();

    const v1 = await recordStrategyVersion({
      dimension: 'ICP_SEGMENT',
      armKey: 'wholesale-case-packs',
      config: { icp: 'Shopify wholesalers selling case packs', minOrderValue: 250 },
      reason: 'seed hypothesis from the verified category',
    });
    const v2 = await recordStrategyVersion({
      dimension: 'ICP_SEGMENT',
      armKey: 'wholesale-case-packs',
      config: { icp: 'Shopify wholesalers selling case packs', minOrderValue: 500 },
      reason: 'the 250 threshold matched almost every store, which is not a segment',
    });

    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);

    const history = await listStrategyHistory('ICP_SEGMENT', 'wholesale-case-packs');
    expect(history.map((h) => h.version)).toEqual([1, 2]);
    // The superseded row still holds exactly what it held when it was written.
    expect(history[0]!.config).toEqual({
      icp: 'Shopify wholesalers selling case packs',
      minOrderValue: 250,
    });
    expect(history[0]!.reason).toBe('seed hypothesis from the verified category');
    expect(history[0]!.active).toBe(false);
    expect(history[1]!.active).toBe(true);

    const active = await getActiveStrategy('ICP_SEGMENT', 'wholesale-case-packs');
    expect(active?.id).toBe(v2.id);
    expect(active?.config).toEqual({
      icp: 'Shopify wholesalers selling case packs',
      minOrderValue: 500,
    });

    const links = await db.query<{ previous_version_id: string | null; retired_at: string | null }>(
      'SELECT previous_version_id, retired_at FROM strategy_versions WHERE id = $1',
      [v2.id],
    );
    expect(links.rows[0]?.previous_version_id).toBe(v1.id);
    const retired = await db.query<{ retired_at: string | null }>(
      'SELECT retired_at FROM strategy_versions WHERE id = $1',
      [v1.id],
    );
    expect(retired.rows[0]?.retired_at).not.toBeNull();

    // Exactly one active row per arm, and every version still on disk.
    expect(await count('SELECT COUNT(*) AS n FROM strategy_versions')).toBe(2);
    expect(await count('SELECT COUNT(*) AS n FROM strategy_versions WHERE active')).toBe(1);
  });

  it('versions each arm independently', async () => {
    await freshDb();
    await recordStrategyVersion({
      dimension: 'PRICE_POINT',
      armKey: 'usd-19',
      config: { price: 19 },
      reason: 'incumbent entry price',
    });
    const other = await recordStrategyVersion({
      dimension: 'PRICE_POINT',
      armKey: 'usd-49',
      config: { price: 49 },
      reason: 'test whether fewer buyers at a higher price earns more',
    });
    expect(other.version).toBe(1);
    expect((await getActiveStrategy('PRICE_POINT', 'usd-19'))?.config).toEqual({ price: 19 });
  });

  it('refuses a config that touches the control plane, and writes nothing', async () => {
    await freshDb();
    await expect(
      recordStrategyVersion({
        dimension: 'PRICE_POINT',
        armKey: 'usd-29',
        config: { price: 29, limits: { max_emails_per_day: 500 } },
        reason: 'more volume at a higher price',
      }),
    ).rejects.toThrow(ControlPlaneViolation);
    expect(await count('SELECT COUNT(*) AS n FROM strategy_versions')).toBe(0);
  });

  it('refuses an unexplained change', async () => {
    await freshDb();
    await expect(
      recordStrategyVersion({
        dimension: 'SEND_TIME',
        armKey: 'tue-am',
        config: { hour: 9 },
        reason: '   ',
      }),
    ).rejects.toThrow(/reason/);
  });

  it('requires a hypothesis-driven change to name a complete hypothesis', async () => {
    const { db } = await freshDb();
    const insert = async (id: string, expectedBenefit: string): Promise<void> => {
      await db.query(
        `INSERT INTO strategy_hypotheses
           (id, dimension, proposal_json, hypothesis, reason, expected_benefit, experiment_scope, proposed_by, content_key)
         VALUES ($1,'SEND_TIME','{}','send earlier','replies cluster before lunch',$2,'one campaign','test',$1)`,
        [id, expectedBenefit],
      );
    };
    await insert('hyp_incomplete', '');
    await insert('hyp_complete', 'a higher reply rate per delivered message');

    await expect(
      recordStrategyVersion({
        dimension: 'SEND_TIME',
        armKey: 'tue-am',
        config: { hour: 9 },
        reason: 'replies cluster before lunch',
        hypothesisId: 'hyp_incomplete',
      }),
    ).rejects.toThrow(/expected benefit/);

    await expect(
      recordStrategyVersion({
        dimension: 'SEND_TIME',
        armKey: 'tue-am',
        config: { hour: 9 },
        reason: 'replies cluster before lunch',
        hypothesisId: 'hyp_missing_entirely',
      }),
    ).rejects.toThrow(/does not exist/);

    const ok = await recordStrategyVersion({
      dimension: 'SEND_TIME',
      armKey: 'tue-am',
      config: { hour: 9 },
      reason: 'replies cluster before lunch',
      hypothesisId: 'hyp_complete',
    });
    const linked = await db.query<{ hypothesis_id: string | null }>(
      'SELECT hypothesis_id FROM strategy_versions WHERE id = $1',
      [ok.id],
    );
    expect(linked.rows[0]?.hypothesis_id).toBe('hyp_complete');
  });
});

// --- reward ---------------------------------------------------------------------

/** A campaign that was delivered and did nothing. Every test varies from here. */
function results(overrides: Partial<OutcomeResults> = {}): OutcomeResults {
  return {
    qualifiedProspects: 150,
    delivered: 100,
    deliveryRate: 1,
    bounceRate: 0,
    replyRate: 0,
    negativeRate: 0,
    strongInterest: 0,
    priceAcceptances: 0,
    pilotSignups: 0,
    installRequests: 0,
    onboardingDetails: 0,
    paymentEvents: 0,
    timeToFirstInterestHours: null,
    timeToFirstCommitmentHours: null,
    finalResult: 'FAILED',
    failureReason: null,
    ...overrides,
  };
}

describe('the reward comes from downstream results only', () => {
  it('ranks strong commitment above price acceptance above pilot above strong reply above qualified reply', async () => {
    await freshDb();
    const strongCommitment = computeReward(results({ installRequests: 1 }));
    const priceAcceptance = computeReward(results({ priceAcceptances: 1 }));
    const pilotSignup = computeReward(results({ pilotSignups: 1 }));
    const strongReply = computeReward(results({ strongInterest: 1 }));
    const qualifiedReply = computeReward(results({ replyRate: 0.01 }));

    expect(strongCommitment).toBeGreaterThan(priceAcceptance);
    expect(priceAcceptance).toBeGreaterThan(pilotSignup);
    expect(pilotSignup).toBeGreaterThan(strongReply);
    expect(strongReply).toBeGreaterThan(qualifiedReply);
    expect(qualifiedReply).toBeGreaterThan(0);

    // Three commitments outweigh ten polite replies, which is the whole point.
    expect(computeReward(results({ installRequests: 3, replyRate: 0.03 }))).toBeGreaterThan(
      computeReward(results({ replyRate: 0.1 })),
    );
  });

  it('is unchanged by enormous engagement telemetry', async () => {
    await freshDb();
    const measured = results({ installRequests: 2, priceAcceptances: 1, replyRate: 0.06 });
    const withVanityMetrics = {
      ...measured,
      opens: 9_000_000,
      uniqueOpens: 4_500_000,
      openRate: 0.99,
      clicks: 250_000,
      clickRate: 0.87,
      landingVisits: 100_000,
    } as OutcomeResults;
    expect(computeReward(withVanityMetrics)).toBe(computeReward(measured));
  });

  it('never mentions an engagement signal in its own source', async () => {
    const source = await readFile(join(process.cwd(), 'src/autonomy/strategy/outcomes.ts'), 'utf8');
    expect(/open/i.test(source), 'the reward function must not reference email opens').toBe(false);
    expect(/click/i.test(source), 'the reward function must not reference clicks').toBe(false);
  });

  it('normalises per delivered volume so size alone cannot win', async () => {
    await freshDb();
    const small = computeReward(results({ delivered: 40, installRequests: 2 }));
    const large = computeReward(results({ delivered: 400, installRequests: 20 }));
    expect(large).toBeCloseTo(small, 6);

    // Ten times the volume, four times the commitments: still a worse strategy.
    const bigButWorse = computeReward(results({ delivered: 400, installRequests: 8 }));
    expect(bigButWorse).toBeLessThan(small);
  });

  it('clamps to [0,1] and refuses to treat a tiny sample as perfect', async () => {
    await freshDb();
    expect(computeReward(results())).toBe(0);
    expect(
      computeReward(
        results({ delivered: 100, installRequests: 60, priceAcceptances: 40, pilotSignups: 30 }),
      ),
    ).toBe(1);
    // Two delivered messages and one commitment is an anecdote, not a 100% strategy.
    expect(computeReward(results({ delivered: 2, installRequests: 1 }))).toBeLessThan(0.5);
    // Hostile replies are not qualified replies.
    expect(computeReward(results({ replyRate: 0.2, negativeRate: 0.2 }))).toBe(0);
  });
});

describe('recordOutcome stores the whole experiment and moves every arm it touched', () => {
  it('writes input strategy plus measured results, and updates the arms', async () => {
    const { db } = await freshDb();
    const opportunityId = await insertOpportunity(db, { state: 'VALIDATING' });
    const campaignId = await insertCampaign(db, opportunityId);

    const input: OutcomeInput = {
      opportunityId,
      campaignId,
      ecosystem: 'shopify',
      category: 'wholesale-minimums',
      problemType: 'enforcement',
      icp: 'wholesalers with case packs',
      source: 'shopify-app-store',
      queryFamily: null,
      competitorProfile: 'one paid incumbent, no free tier',
      wedgeType: 'enforcement',
      priceMonthly: 29,
      valueProposition: 'per-group minimums without a developer',
      emailVariant: 'plain-question-v1',
      landingVariant: 'single-cta',
      contactRoleStrategy: 'wholesale-inbox-first',
      sendTimeBucket: 'tue-0900',
      followupStrategy: 'one-line-nudge',
      strategyVersionIds: ['sv_one', 'sv_two'],
    };
    const measured = results({ delivered: 120, installRequests: 4, priceAcceptances: 3, replyRate: 0.1 });

    const { id, reward } = await recordOutcome(input, measured);
    expect(reward).toBeGreaterThan(0);

    const row = await db.query<Record<string, unknown>>(
      'SELECT * FROM strategy_outcomes WHERE id = $1',
      [id],
    );
    const stored = row.rows[0]!;
    expect(stored.campaign_id).toBe(campaignId);
    expect(stored.icp).toBe('wholesalers with case packs');
    expect(stored.email_variant).toBe('plain-question-v1');
    expect(stored.send_time_bucket).toBe('tue-0900');
    expect(toNumber(stored.price_monthly)).toBe(29);
    expect(toNumber(stored.delivered)).toBe(120);
    expect(toNumber(stored.install_requests)).toBe(4);
    expect(stored.final_result).toBe('FAILED');
    expect(toNumber(stored.reward)).toBeCloseTo(reward, 4);

    // One arm per dimension the experiment actually used...
    expect((await getArms('ICP_SEGMENT')).map((a) => a.armKey)).toEqual(['wholesalers with case packs']);
    expect((await getArms('PRICE_POINT')).map((a) => a.armKey)).toEqual(['usd-29']);
    expect((await getArms('MESSAGE_VARIANT')).map((a) => a.armKey)).toEqual(['plain-question-v1']);
    expect((await getArms('RESEARCH_SOURCE')).map((a) => a.armKey)).toEqual(['shopify-app-store']);
    // ...and none for the dimensions it did not.
    expect(await getArms('QUERY_FAMILY')).toEqual([]);

    const priceArm = (await getArms('PRICE_POINT'))[0]!;
    expect(priceArm.trials).toBe(1);
    expect(priceArm.alpha).toBeCloseTo(1 + reward, 4);
    expect(priceArm.beta).toBeCloseTo(2 - reward, 4);

    const segments = await count('SELECT COUNT(*) AS n FROM segment_performance');
    expect(segments).toBe(1);
  });
});

// --- failure memory ---------------------------------------------------------------

const DEAD_IDEA = {
  opportunityId: null,
  ecosystem: 'shopify',
  category: 'back-in-stock alerts',
  icp: 'independent coffee roasters',
  wedge: 'notify shoppers when a sold-out single-origin bean is restocked',
  wedgeType: 'notification',
  priceMonthly: 19,
  reasonFailed: 'NO_MEANINGFUL_RESPONSE',
  sampleSize: 120,
};

describe('failure memory blocks the weekly rediscovery of a dead idea', () => {
  it('blocks a near-identical retry', async () => {
    await freshDb();
    const failure = await recordFailure(DEAD_IDEA);

    const identical = await findSimilarFailure({
      category: DEAD_IDEA.category,
      icp: DEAD_IDEA.icp,
      wedge: DEAD_IDEA.wedge,
      priceMonthly: 19,
    });
    expect(identical?.failure.id).toBe(failure.id);
    expect(identical!.similarity).toBeGreaterThanOrEqual(0.8);

    // Re-worded, same idea, same everything that matters.
    const reworded = await findSimilarFailure({
      category: 'back in stock alerts',
      icp: 'independent coffee roaster',
      wedge: 'notify shoppers when a sold out single origin bean is restocked',
      priceMonthly: 22,
    });
    expect(reworded?.failure.id).toBe(failure.id);
  });

  it('allows a retry with a materially different price', async () => {
    await freshDb();
    await recordFailure(DEAD_IDEA);
    const dearer = await findSimilarFailure({
      category: DEAD_IDEA.category,
      icp: DEAD_IDEA.icp,
      wedge: DEAD_IDEA.wedge,
      priceMonthly: 79,
    });
    expect(dearer).toBeNull();
  });

  it('allows a retry with a materially different ICP even when the words barely change', async () => {
    // The threshold is lowered so the token overlap alone would NOT clear it:
    // this proves the material-change rule is what lets the retry through.
    await freshDb({ FAILURE_SIMILARITY_THRESHOLD: '0.3' });
    await recordFailure(DEAD_IDEA);

    const sameIcp = await findSimilarFailure({
      category: DEAD_IDEA.category,
      icp: DEAD_IDEA.icp,
      wedge: DEAD_IDEA.wedge,
      priceMonthly: 19,
    });
    expect(sameIcp).not.toBeNull();

    const differentIcp = await findSimilarFailure({
      category: DEAD_IDEA.category,
      icp: 'industrial fastener distributors',
      wedge: DEAD_IDEA.wedge,
      priceMonthly: 19,
    });
    expect(differentIcp).toBeNull();
  });

  it('names what counts as material', () => {
    const failure = { icp: 'coffee roasters', wedge: DEAD_IDEA.wedge, wedgeType: 'notification', priceMonthly: 19 };
    expect(
      materialChangeAgainst({ category: 'x', icp: 'dental practices', priceMonthly: 19 }, failure).reason,
    ).toMatch(/different ICP/);
    expect(
      materialChangeAgainst({ category: 'x', icp: 'coffee roasters', priceMonthly: 79 }, failure).reason,
    ).toMatch(/price differs/);
    expect(
      materialChangeAgainst(
        { category: 'x', icp: 'coffee roasters', wedge: 'reconcile wholesale invoices', priceMonthly: 19 },
        failure,
      ).reason,
    ).toMatch(/wedge type/);
    // A 20% price nudge is the same experiment.
    expect(
      materialChangeAgainst({ category: 'x', icp: 'coffee roasters', priceMonthly: 23 }, failure).material,
    ).toBe(false);
  });

  it('does not match an unrelated idea', async () => {
    await freshDb();
    await recordFailure(DEAD_IDEA);
    expect(
      await findSimilarFailure({
        category: 'wholesale minimum order rules',
        icp: 'industrial fastener distributors',
        wedge: 'enforce per-customer-group order minimums at checkout',
        priceMonthly: 49,
      }),
    ).toBeNull();
  });
});

// --- success patterns ----------------------------------------------------------------

describe('success bias comes from companies that committed', () => {
  it('refuses to learn from an opportunity with no measured commitment', async () => {
    const { db } = await freshDb();
    const opportunityId = await insertOpportunity(db, {
      state: 'READY_TO_BUILD',
      category: 'wholesale-minimums',
      target_customer: 'shopify wholesalers shipping case packs',
    });
    await recordSuccessPattern(opportunityId);
    expect(await count('SELECT COUNT(*) AS n FROM success_patterns')).toBe(0);
    expect(await getSuccessBias()).toEqual({ tokens: [], weight: 0 });
  });

  it('extracts tokens from a real winner and caps the bias below certainty', async () => {
    const { db } = await freshDb({ EXPLORATION_RATIO: '0.25' });
    const opportunityId = await insertOpportunity(db, {
      state: 'READY_TO_BUILD',
      category: 'wholesale-minimums',
      target_customer: 'shopify wholesalers shipping case packs',
      proposed_wedge: 'enforce per-customer-group order minimums at checkout',
    });
    const campaignId = await insertCampaign(db, opportunityId);
    const prospectId = await insertProspect(db, opportunityId);
    await insertDeliveredMessage(db, campaignId, prospectId);
    await insertCommitment(db, campaignId, 'alpha.example.com', 'EXPLICIT_PRICE_ACCEPTANCE');

    await recordSuccessPattern(opportunityId);

    const bias = await getSuccessBias();
    expect(bias.tokens).toContain('wholesaler');
    expect(bias.tokens).toContain('minimum');
    expect(bias.tokens).toContain('shopify');
    expect(bias.weight).toBeGreaterThan(0);
    // Exploration must survive success: the bias can never reach 1.
    expect(bias.weight).toBeLessThanOrEqual(0.75);

    const pattern = await db.query<{ commitment_rate: string | null }>(
      'SELECT commitment_rate FROM success_patterns WHERE opportunity_id = $1',
      [opportunityId],
    );
    expect(toNumber(pattern.rows[0]?.commitment_rate)).toBeCloseTo(1, 4);
  });
});

// --- post mortem ---------------------------------------------------------------------

describe('every failure writes a post-mortem the owner never sees', () => {
  it('composes the full lesson from measured evidence and stores it in failure memory', async () => {
    const { db } = await freshDb({ MIN_DELIVERED_BEFORE_STANDARD_EVALUATION: '5' });
    const opportunityId = await insertOpportunity(db, {
      name: 'Back-in-stock alerts',
      state: 'VALIDATION_FAILED',
      category: 'back-in-stock alerts',
      evidence_confidence: 'HIGH',
      proposed_wedge: 'notify shoppers when a sold-out single-origin bean is restocked',
      target_customer: 'independent coffee roasters',
      proposed_price_monthly: 19,
    });
    const campaignId = await insertCampaign(db, opportunityId, { price: 19 });
    for (let i = 0; i < 8; i++) {
      const prospectId = await insertProspect(db, opportunityId, { domain: `p${i}.example.com` });
      await insertDeliveredMessage(db, campaignId, prospectId);
    }

    const { id, lesson } = await writePostMortem(opportunityId);

    for (const section of [
      'WHY IT WAS TESTED',
      'EVIDENCE THAT EXISTED',
      'WHAT WAS TRIED',
      'SAMPLE SIZE',
      'RESULTS',
      'WHY IT FAILED',
      'WHAT WAS LEARNED',
      'AVOID THE CATEGORY',
      'WORTH RETESTING ONLY WITH',
    ]) {
      expect(lesson, `post-mortem is missing "${section}"`).toContain(section);
    }
    expect(lesson).toContain('SAMPLE SIZE: 8 delivered');
    expect(lesson).toContain('$19/month');
    expect(lesson).toContain('independent coffee roasters');
    // 8 delivered past a floor of 5 with nothing committed condemns the category.
    expect(lesson).toContain('AVOID THE CATEGORY: yes');
    expect(lesson).toContain('a materially different ICP');

    const stored = await db.query<{ lesson: string | null; avoid_category: boolean; sample_size: number }>(
      'SELECT lesson, avoid_category, sample_size FROM failure_memory WHERE id = $1',
      [id],
    );
    expect(stored.rows[0]?.lesson).toBe(lesson);
    expect(stored.rows[0]?.avoid_category).toBe(true);
    expect(toNumber(stored.rows[0]?.sample_size)).toBe(8);

    // The owner is never told about a failure. Not once.
    expect(await count('SELECT COUNT(*) AS n FROM owner_notifications')).toBe(0);

    // Writing it twice updates the same memory rather than duplicating it.
    const again = await writePostMortem(opportunityId);
    expect(again.id).toBe(id);
    expect(await count('SELECT COUNT(*) AS n FROM failure_memory')).toBe(1);
  });

  it('blames the execution, not the category, when the sample never got there', async () => {
    const { db } = await freshDb({ MIN_DELIVERED_BEFORE_STANDARD_EVALUATION: '75' });
    const opportunityId = await insertOpportunity(db, {
      state: 'VALIDATION_FAILED',
      category: 'shipping-rules',
    });
    const campaignId = await insertCampaign(db, opportunityId);
    const prospectId = await insertProspect(db, opportunityId);
    await insertDeliveredMessage(db, campaignId, prospectId);

    const { lesson } = await writePostMortem(opportunityId);
    expect(lesson).toContain('AVOID THE CATEGORY: no');
    expect(lesson).toContain('WHY IT FAILED: INSUFFICIENT_SAMPLE');
  });
});

// --- hypothesis admission ----------------------------------------------------------------

function proposal(overrides: Partial<HypothesisProposal> = {}): HypothesisProposal {
  return {
    dimension: 'ICP_SEGMENT',
    hypothesis: 'Aim at fastener distributors who publish a trade price list rather than all wholesalers',
    reason: 'the two replies that engaged both came from distributors with a public trade list',
    expectedBenefit: 'a higher qualified reply rate per delivered message',
    experimentScope: 'the next single campaign, 100 prospects',
    proposal: { icp: 'fastener distributors with a public trade price list', armKey: 'trade-list-distributors' },
    ...overrides,
  };
}

describe('the eligibility gate is deterministic and runs before any spend', () => {
  it('rejects a proposal naming a control-plane field', async () => {
    const { db } = await freshDb();
    await insertOpportunity(db, { state: 'DISCOVERED' });

    const inTheConfig = await checkEligibility(
      proposal({
        dimension: 'MESSAGE_VARIANT',
        proposal: { variant: 'higher-volume', maxEmailsPerDay: 500 },
      }),
    );
    expect(inTheConfig.eligible).toBe(false);
    expect(inTheConfig.reasons.join(' ')).toContain('maxEmailsPerDay');

    // Snake case, nested, is the same request.
    const nested = await checkEligibility(
      proposal({ proposal: { icp: 'x', overrides: { max_emails_per_day: 500 } } }),
    );
    expect(nested.eligible).toBe(false);
    expect(nested.reasons.join(' ')).toContain('maxEmailsPerDay');

    // And so is arguing for it in prose.
    const inProse = await checkEligibility(
      proposal({
        hypothesis: 'We should raise max emails per day so the sample completes in one week',
      }),
    );
    expect(inProse.eligible).toBe(false);
    expect(inProse.reasons.join(' ')).toContain('maxEmailsPerDay');
  });

  it('admits a clean proposal, then rejects the same idea as a duplicate', async () => {
    const { db } = await freshDb();
    await insertOpportunity(db, { state: 'DISCOVERED' });

    const clean = await checkEligibility(proposal());
    expect(clean).toEqual({ eligible: true, reasons: [], similarTo: null });

    await db.query(
      `INSERT INTO strategy_hypotheses
         (id, dimension, proposal_json, hypothesis, reason, expected_benefit, experiment_scope, proposed_by, content_key)
       VALUES ('hyp_dupe','ICP_SEGMENT','{}','x','y','z','w','test',$1)`,
      [(await import('../../src/autonomy/strategy/propose')).contentKeyFor(proposal())],
    );
    const duplicate = await checkEligibility(proposal());
    expect(duplicate.eligible).toBe(false);
    expect(duplicate.reasons.join(' ')).toContain('duplicates');
  });

  it('rejects a proposal with no population to test it on', async () => {
    await freshDb();
    const verdict = await checkEligibility(proposal());
    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('test population does not exist');
  });

  it('rejects a proposal that is a past failure wearing new words', async () => {
    const { db } = await freshDb();
    await insertOpportunity(db, { state: 'DISCOVERED' });
    const failure = await recordFailure(DEAD_IDEA);

    const verdict = await checkEligibility(
      proposal({
        hypothesis: 'Notify shoppers when a sold-out single-origin bean is restocked, for coffee roasters',
        proposal: {
          category: 'back-in-stock alerts',
          icp: 'independent coffee roasters',
          wedge: 'notify shoppers when a sold-out single-origin bean is restocked',
          price: 19,
        },
      }),
    );
    expect(verdict.eligible).toBe(false);
    expect(verdict.similarTo).toBe(failure.id);
    expect(verdict.reasons.join(' ')).toContain('substantially identical');
  });

  it('rejects everything once the experiment budget for the month is gone', async () => {
    const { db } = await freshDb({ MAX_MONTHLY_EXPERIMENTS: '1' });
    await insertOpportunity(db, { state: 'DISCOVERED' });
    await db.query(
      `INSERT INTO strategy_hypotheses
         (id, dimension, proposal_json, hypothesis, reason, expected_benefit, experiment_scope,
          proposed_by, status, content_key, admitted_at)
       VALUES ('hyp_live','ICP_SEGMENT','{}','x','y','z','w','test','ADMITTED','ck_live', now())`,
    );
    const verdict = await checkEligibility(proposal());
    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('no budget remains');
  });
});

describe('proposeHypotheses: the model proposes, code admits', () => {
  it('admits the clean proposal, records the rejected one with its reasons', async () => {
    const { db, llm } = await freshDb();
    await insertOpportunity(db, { state: 'DISCOVERED' });

    llm.register('strategy.propose', () => ({
      proposals: [
        proposal(),
        proposal({
          dimension: 'MESSAGE_VARIANT',
          hypothesis: 'Send the same message to far more people every day to finish the sample sooner',
          proposal: { variant: 'volume', maxEmailsPerDay: 400 },
        }),
      ],
    }));

    const round = await proposeHypotheses(5);
    expect(round.proposed).toBe(2);
    expect(round.admitted).toBe(1);
    expect(round.rejected).toHaveLength(1);
    expect(round.rejected[0]!.reasons.join(' ')).toContain('maxEmailsPerDay');

    const statuses = await db.query<{ status: string; rejection_reason: string | null }>(
      'SELECT status, rejection_reason FROM strategy_hypotheses ORDER BY status ASC',
    );
    expect(statuses.rows.map((r) => r.status)).toEqual(['ADMITTED', 'REJECTED']);
    expect(statuses.rows[1]?.rejection_reason).toContain('maxEmailsPerDay');

    // Only the admitted proposal reaches the strategy plane.
    const version = await getActiveStrategy('ICP_SEGMENT', 'trade-list-distributors');
    expect(version?.config).toMatchObject({ icp: 'fastener distributors with a public trade price list' });
    expect(await count('SELECT COUNT(*) AS n FROM strategy_versions')).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM strategy_versions WHERE hypothesis_id IS NOT NULL')).toBe(1);

    // Being admitted proves nothing about quality: the arm starts at the
    // uniform prior and has to earn its allocation from measured outcomes.
    const arms = await getArms('ICP_SEGMENT');
    expect(arms).toHaveLength(1);
    expect(arms[0]).toMatchObject({ armKey: 'trade-list-distributors', alpha: 1, beta: 1, trials: 0 });
  });

  it('proposes nothing, and throws nothing, when the model returns nothing', async () => {
    const { db } = await freshDb();
    await insertOpportunity(db, { state: 'DISCOVERED' });
    expect(await proposeHypotheses(3)).toEqual({ proposed: 0, admitted: 0, rejected: [] });
    expect(await count('SELECT COUNT(*) AS n FROM strategy_hypotheses')).toBe(0);
  });

  it('does not call the model at all when the experiment budget is gone', async () => {
    const { db, llm } = await freshDb({ MAX_MONTHLY_EXPERIMENTS: '0' });
    await insertOpportunity(db, { state: 'DISCOVERED' });
    llm.register('strategy.propose', () => ({ proposals: [proposal()] }));
    const round = await proposeHypotheses(3);
    expect(round).toEqual({ proposed: 0, admitted: 0, rejected: [] });
    expect(llm.calls).toEqual([]);
  });
});
