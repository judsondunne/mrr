import { afterEach, describe, expect, it } from 'vitest';
import { freshDb, insertOpportunity, teardown } from '../helpers';
import { resetConfigCache } from '../../src/lib/config';
import { contentHash, newId } from '../../src/lib/hash';
import type { Db } from '../../src/lib/db';
import type { EvidenceItem, ExtractedReview } from '../../src/lib/contracts';
import {
  assessCategoryEvidence,
  classifyCompetitorEvidence,
  classifyResearchEvidence,
  makeEvidence,
  meetsConfidence,
  usageDurationMonths,
  type CompetitorFacts,
} from '../../src/pipeline/verification/evidence';
import {
  ALL_RULES,
  estimateBuildDays,
  evaluateRejectionRules,
  HARD_MAX_BUILD_DAYS,
  REJECT_PENALTY_THRESHOLD,
} from '../../src/pipeline/verification/rejection-rules';
import { verifyCategories, verifyOpportunity } from '../../src/pipeline/verification/index';

const BASE_ENV: Record<string, string> = {
  REQUIRED_CATEGORY_EVIDENCE_CONFIDENCE: 'HIGH',
  DEEP_VERIFICATIONS_PER_DAY: '3',
  MAX_MVP_BUILD_DAYS: '7',
  KILL_SWITCH: 'false',
};

/**
 * The rule engine is pure code, so these tests only need config — spinning up a
 * database for each of them would dominate the suite runtime for nothing.
 */
function pureConfig(overrides: Record<string, string> = {}): void {
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    process.env[key] = value;
  }
  resetConfigCache();
}

afterEach(async () => {
  await teardown();
});

// --- builders ----------------------------------------------------------------

const A_URL = 'https://apps.shopify.com/order-limits-pro';
const B_URL = 'https://apps.shopify.com/minmax-order-rules';

function review(over: Partial<ExtractedReview> = {}): ExtractedReview {
  return {
    sourceUrl: `${A_URL}/reviews`,
    rating: 5,
    reviewDate: '2025-03-01',
    merchantName: 'Harbour Supply Co',
    merchantDomainIfPublic: null,
    usageDuration: '2 months',
    text: 'Great app.',
    paymentSignal: 'NONE',
    complaintTags: [],
    ...over,
  };
}

function competitor(over: Partial<CompetitorFacts> = {}): CompetitorFacts {
  return {
    name: 'Order Limits Pro',
    url: A_URL,
    currentPricing: 'Basic: $14.99/mo; Growth: $29.99/mo',
    freePlanDetails: null,
    hasPermanentFreeTier: false,
    reviewCount: 1204,
    rating: 4.8,
    launchAge: 'March 2018',
    paidPlanPrices: [14.99, 29.99],
    disclosureText: '',
    observedAt: '2025-06-01',
    reviews: [],
    ...over,
  };
}

// --- evidence rules ----------------------------------------------------------

describe('payment evidence classification', () => {
  it('marks an incumbent with no free tier as a strong signal', () => {
    const items = classifyCompetitorEvidence(competitor());
    const strong = items.filter((i) => i.confidence === 'HIGH');
    expect(strong.map((i) => i.type)).toEqual(['INCUMBENT_NO_FREE_TIER']);
    expect(items.map((i) => i.type)).toContain('PRICING_PAGE_EXISTS');
  });

  it('does not emit a payment signal for a competitor with a free tier', () => {
    const items = classifyCompetitorEvidence(
      competitor({ hasPermanentFreeTier: true, freePlanDetails: 'Free: up to 50 orders' }),
    );
    expect(items.map((i) => i.type)).not.toContain('INCUMBENT_NO_FREE_TIER');
  });

  it('turns merchant payment language into strong review evidence', () => {
    const items = classifyCompetitorEvidence(
      competitor({
        reviews: [
          review({ paymentSignal: 'PAID_PLAN_REFERENCED', text: 'We pay for the Growth plan.' }),
          review({ paymentSignal: 'EXCEEDS_FREE_TIER', text: 'We hit the limit and had to upgrade.' }),
        ],
      }),
    );
    expect(items.map((i) => i.type)).toEqual(
      expect.arrayContaining(['CUSTOMER_REFERENCES_PAID_PLAN', 'CUSTOMER_EXCEEDS_FREE_TIER']),
    );
  });

  it('counts a year or more of continuous use as a supporting signal only', () => {
    const items = classifyCompetitorEvidence(
      competitor({ reviews: [review({ usageDuration: 'Over 3 years' })] }),
    );
    const sustained = items.find((i) => i.type === 'SUSTAINED_USAGE_DURATION');
    expect(sustained?.confidence).toBe('MEDIUM');

    const short = classifyCompetitorEvidence(
      competitor({ reviews: [review({ usageDuration: '2 months' })] }),
    );
    expect(short.map((i) => i.type)).not.toContain('SUSTAINED_USAGE_DURATION');
  });

  it('parses usage durations into months', () => {
    expect(usageDurationMonths('Over 3 years')).toBe(36);
    expect(usageDurationMonths('18 months')).toBe(18);
    expect(usageDurationMonths('a while')).toBeNull();
    expect(usageDurationMonths(null)).toBeNull();
  });

  it('records source, quote, date, type and confidence on every item', () => {
    const items = classifyCompetitorEvidence(
      competitor({ reviews: [review({ paymentSignal: 'PAID_PLAN_REFERENCED', text: 'We pay monthly.' })] }),
    );
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.sourceUrl).toMatch(/^https:/);
      expect(item.quote.length).toBeGreaterThan(0);
      expect(['HIGH', 'MEDIUM', 'LOW']).toContain(item.confidence);
      expect(item.type).toBeTruthy();
    }
    const fromReview = items.find((i) => i.type === 'CUSTOMER_REFERENCES_PAID_PLAN');
    expect(fromReview?.date).toBe('2025-03-01');
  });

  it('classifies research pages into supporting and weak signals only', () => {
    const items = classifyResearchEvidence(
      'The app was listed for sale on Flippa after its Product Hunt launch. Estimated market size is large.',
      'https://example.com/post',
      '2025-01-01',
    );
    const byType = new Map(items.map((i) => [i.type, i]));
    expect(byType.get('ACQUISITION_LISTING')?.confidence).toBe('MEDIUM');
    expect(byType.get('PRODUCT_HUNT_LAUNCH')?.confidence).toBe('LOW');
    expect(byType.get('AI_MARKET_ESTIMATE')?.confidence).toBe('LOW');
  });
});

describe('evidence confidence', () => {
  it('reaches HIGH only with a strong signal plus an independent second signal', () => {
    const assessment = assessCategoryEvidence([
      competitor(),
      competitor({ name: 'MinMax Order Rules', url: B_URL, paidPlanPrices: [9, 24] }),
    ]);

    expect(assessment.confidence).toBe('HIGH');
    expect(assessment.paidCompetitorCount).toBe(2);
    expect(assessment.strong.length).toBeGreaterThanOrEqual(2);
    expect(assessment.all.map((i) => i.type)).toContain('MULTIPLE_PAID_COMPETITORS');
    expect(new Set(assessment.strong.map((i) => i.sourceUrl)).size).toBeGreaterThan(1);
  });

  it('reaches HIGH with one competitor when two distinct kinds of proof exist', () => {
    const assessment = assessCategoryEvidence([
      competitor({
        reviews: [
          review({ paymentSignal: 'PAID_PLAN_REFERENCED', text: 'We pay for the Growth plan.' }),
        ],
      }),
    ]);
    expect(assessment.confidence).toBe('HIGH');
    expect(new Set(assessment.strong.map((i) => i.type)).size).toBe(2);
  });

  it('stays at MEDIUM when every strong signal comes from one source', () => {
    const assessment = assessCategoryEvidence([competitor({ reviewCount: 0 })]);
    expect(assessment.strong).toHaveLength(1);
    expect(assessment.confidence).toBe('MEDIUM');
    expect(assessment.reasons.join(' ')).toMatch(/single source/);
  });

  it('never lets weak-only evidence exceed LOW', () => {
    const weakOnly = assessCategoryEvidence([
      competitor({
        hasPermanentFreeTier: true,
        freePlanDetails: 'Free: 50 orders',
        paidPlanPrices: [],
        currentPricing: 'Free; Growth: $19/mo',
        reviewCount: 800,
        reviews: [review({ usageDuration: '3 months' }), review({ usageDuration: '1 month' })],
      }),
    ]);

    expect(weakOnly.strong).toEqual([]);
    expect(weakOnly.confidence).toBe('LOW');
    expect(weakOnly.all.map((i) => i.type)).toEqual(
      expect.arrayContaining(['PRICING_PAGE_EXISTS', 'GENERIC_REVIEWS']),
    );
  });

  it('cannot be pushed to HIGH by piling on weak evidence', () => {
    const weak: EvidenceItem[] = ['PRODUCT_HUNT_LAUNCH', 'DOWNLOADS_NO_PAID_PROOF', 'AI_MARKET_ESTIMATE'].flatMap(
      (type, i) =>
        [0, 1, 2].map((j) =>
          makeEvidence({
            type: type as EvidenceItem['type'],
            sourceUrl: `https://example.com/${i}-${j}`,
            quote: 'lots of buzz',
          }),
        ),
    );
    const assessment = assessCategoryEvidence(
      [competitor({ hasPermanentFreeTier: true, paidPlanPrices: [], currentPricing: null, reviewCount: 0 })],
      weak,
    );

    expect(assessment.strong).toEqual([]);
    expect(assessment.confidence).not.toBe('HIGH');
    expect(assessment.confidence).toBe('LOW');
  });

  it('returns NONE when nothing at all was extracted', () => {
    expect(assessCategoryEvidence([]).confidence).toBe('NONE');
  });

  it('orders confidence levels correctly', () => {
    expect(meetsConfidence('HIGH', 'HIGH')).toBe(true);
    expect(meetsConfidence('MEDIUM', 'HIGH')).toBe(false);
    expect(meetsConfidence('MEDIUM', 'LOW')).toBe(true);
    expect(meetsConfidence('NONE', 'LOW')).toBe(false);
  });
});

// --- rejection rules ---------------------------------------------------------

const REPRESENTATIVE_INPUT: Record<string, string> = {
  REGULATED_MEDICAL: 'A symptom checker that supports patient triage for pharmacies.',
  FINANCIAL_CUSTODY: 'We hold customer funds in escrow until the order ships.',
  LEGAL_ADVICE: 'Gives merchants legal advice about their terms of service.',
  WEAPONS: 'Compliance tooling for firearm retailers.',
  GAMBLING: 'A casino style spin-to-win loyalty game.',
  ADULT_SERVICES: 'Age gating for adult content storefronts.',
  DECEPTIVE_MARKETING: 'Automatically generates fake reviews to boost conversion.',
  SURVEILLANCE: 'Employee monitoring for warehouse staff.',
  BYPASS_PLATFORM_PROTECTIONS: 'Bypass rate limits on the platform API for faster syncing.',
  PROPRIETARY_DATASET_REQUIRED: 'Needs a proprietary dataset of competitor prices to work.',
  NETWORK_EFFECTS: 'Only useful once many users have joined the shared directory.',
  TWO_SIDED_MARKETPLACE: 'A marketplace connecting buyers and sellers of surplus stock.',
  ENTERPRISE_SALES: 'Sold through enterprise sales with a procurement process.',
  MANUAL_PROFESSIONAL_SERVICES: 'A done-for-you service delivered on an agency retainer.',
  MISSION_CRITICAL_INFRA: 'Mission-critical infrastructure with 24/7 on-call support.',
  HIGH_LIABILITY_RULE_FAILURE: 'Automates tax filing for every jurisdiction a merchant sells into.',
  INTEGRATION_COMPLEXITY: 'Requires ERP integration with NetSuite and EDI feeds.',
  GENERIC_AI_WRAPPER: 'An AI-powered copywriter that writes product descriptions.',
  GENERIC_CHATBOT: 'An AI chatbot for your store that answers shopper questions.',
  GENERIC_MEETING_ASSISTANT: 'A meeting assistant that summarizes supplier calls.',
  GENERIC_CRM: 'A CRM for small merchants to track their contacts.',
  GENERIC_PROJECT_MANAGEMENT: 'A project management tool with a kanban board for store tasks.',
  DOMINATED_BY_FREE_NATIVE_FEATURE: 'Shopify already does this natively for free in every plan.',
};

describe('auto-rejection rules', () => {
  it('has a representative input for every rule', () => {
    for (const rule of ALL_RULES) {
      expect(REPRESENTATIVE_INPUT[rule.id], `missing representative input for ${rule.id}`).toBeTruthy();
    }
  });

  for (const rule of ALL_RULES) {
    it(`fires ${rule.id}`, () => {
      pureConfig();
      const verdict = evaluateRejectionRules({
        name: 'Candidate category',
        category: 'candidate-category',
        description: REPRESENTATIVE_INPUT[rule.id] ?? '',
      });

      expect(verdict.matches.map((m) => m.ruleId)).toContain(rule.id);
      if (rule.strength === 'HARD') {
        expect(verdict.rejected).toBe(true);
        expect(verdict.matches.map((m) => m.reason)).toContain(rule.reason);
      } else if (rule.weight >= REJECT_PENALTY_THRESHOLD) {
        expect(verdict.rejected).toBe(true);
        expect(verdict.reason).toBe(rule.reason);
      } else {
        expect(verdict.penalty).toBeGreaterThan(0);
      }
    });
  }

  it('lets a clean narrow category through', () => {
    pureConfig();
    const verdict = evaluateRejectionRules({
      name: 'Minimum and maximum order rules',
      category: 'minimum-maximum-order-rules',
      description: 'Enforce minimum order value, quantity or weight per cart or customer group.',
      corpus: 'Order Limits Pro Basic: $14.99/mo. Merchants say it stopped tiny wholesale orders.',
      estimatedBuildDays: 4,
    });
    expect(verdict.rejected).toBe(false);
    expect(verdict.reason).toBeNull();
  });

  it('keeps hard rules away from the competitor corpus', () => {
    pureConfig();
    const verdict = evaluateRejectionRules({
      name: 'Review moderation rules',
      category: 'review-moderation-rules',
      description: 'Flag reviews that break a merchant policy before they publish.',
      corpus: 'A reviewer wrote: this app finally stopped the fake reviews problem on our store.',
    });
    expect(verdict.rejected).toBe(false);
  });

  it('accumulates penalties until the threshold rejects', () => {
    pureConfig();
    const single = evaluateRejectionRules({
      name: 'Contact tracker',
      category: 'contact-tracker',
      description: 'A CRM for small merchants.',
    });
    expect(single.rejected).toBe(false);
    expect(single.penalty).toBeGreaterThan(0);
    expect(single.penalty).toBeLessThan(REJECT_PENALTY_THRESHOLD);

    const combined = evaluateRejectionRules({
      name: 'Contact tracker',
      category: 'contact-tracker',
      description: 'A CRM for small merchants with a kanban board project management tool.',
    });
    expect(combined.penalty).toBeGreaterThanOrEqual(REJECT_PENALTY_THRESHOLD);
    expect(combined.rejected).toBe(true);
  });

  it('rejects an MVP that cannot be built in one to two weeks', () => {
    pureConfig();
    const verdict = evaluateRejectionRules({
      name: 'Big build',
      category: 'big-build',
      description: 'A narrow tool.',
      estimatedBuildDays: HARD_MAX_BUILD_DAYS + 1,
    });
    expect(verdict.rejected).toBe(true);
    expect(verdict.reason).toBe('BUILD_TOO_LARGE');
    expect(verdict.ruleId).toBe('MVP_TOO_LARGE');
  });

  it('penalizes but does not reject an MVP just over the preferred size', () => {
    pureConfig();
    const verdict = evaluateRejectionRules({
      name: 'Slightly big build',
      category: 'slightly-big-build',
      description: 'A narrow tool.',
      estimatedBuildDays: 9,
    });
    expect(verdict.rejected).toBe(false);
    expect(verdict.matches.map((m) => m.ruleId)).toContain('MVP_OVER_PREFERRED_SIZE');
  });

  it('rejects a category the operator marked as dominated by a free native feature', () => {
    pureConfig();
    const verdict = evaluateRejectionRules({
      name: 'Discount codes',
      category: 'discount-codes',
      description: 'Create discount codes.',
      dominatedByFreeNativeFeature: true,
    });
    expect(verdict.rejected).toBe(true);
    expect(verdict.reason).toBe('DOMINATED_BY_FREE_NATIVE_FEATURE');
  });
});

describe('build day estimation', () => {
  it('is deterministic and driven by the category, not competitor copy', () => {
    pureConfig();
    const simple = estimateBuildDays({
      name: 'Order tagging automation',
      category: 'order-tagging-automation',
      description: 'Tag orders automatically from order attributes.',
    });
    const complex = estimateBuildDays({
      name: 'Inventory synchronization',
      category: 'inventory-sync',
      description: 'Two-way sync of inventory across stores with webhooks and a reporting dashboard.',
    });

    expect(simple.days).toBeLessThan(complex.days);
    expect(simple.days).toBeGreaterThan(0);
    expect(estimateBuildDays({ name: 'x', category: 'y' }).days).toBe(
      estimateBuildDays({ name: 'x', category: 'y' }).days,
    );

    const corpusOnly = estimateBuildDays({
      name: 'Order tagging automation',
      category: 'order-tagging-automation',
      description: 'Tag orders automatically from order attributes.',
      corpus: 'machine learning forecast dashboard multi-currency erp integration webhook',
    });
    expect(corpusOnly.days).toBe(simple.days);
  });
});

// --- database-backed verification --------------------------------------------

interface SeedCompetitor {
  name: string;
  url: string;
  pricing: string | null;
  freeTier: boolean | null;
  prices: number[];
  reviewCount: number;
  description?: string;
  reviews?: Array<{ text: string; signal: ExtractedReview['paymentSignal']; duration: string | null }>;
}

async function seedCompetitor(db: Db, opportunityId: string, spec: SeedCompetitor): Promise<void> {
  const competitorId = newId('cmp');
  await db.query(
    `INSERT INTO competitors
       (id, opportunity_id, name, url, current_pricing, free_plan_details,
        has_permanent_free_tier, review_count, rating, launch_age, evidence_json, payment_evidence_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'[]'::jsonb)`,
    [
      competitorId,
      opportunityId,
      spec.name,
      spec.url,
      spec.pricing,
      spec.freeTier === true ? 'Free: limited usage' : null,
      spec.freeTier,
      spec.reviewCount,
      4.7,
      '2019',
      JSON.stringify({
        paidPlanPrices: spec.prices,
        description: spec.description ?? '',
        observedAt: '2025-06-01',
      }),
    ],
  );

  for (const r of spec.reviews ?? []) {
    await db.query(
      `INSERT INTO reviews
         (id, competitor_id, source_url, rating, review_date, merchant_name,
          usage_duration, text, payment_signal, complaint_tags, content_hash)
       VALUES ($1,$2,$3,5,'2025-03-01','A Merchant',$4,$5,$6,'[]'::jsonb,$7)`,
      [
        newId('rev'),
        competitorId,
        `${spec.url}/reviews`,
        r.duration,
        r.text,
        r.signal,
        contentHash(r.text),
      ],
    );
  }
}

async function stateOf(db: Db, id: string): Promise<{
  state: string;
  rejection_reason: string | null;
  evidence_confidence: string | null;
  estimated_build_days: number | null;
}> {
  const res = await db.query<{
    state: string;
    rejection_reason: string | null;
    evidence_confidence: string | null;
    estimated_build_days: number | null;
  }>(
    'SELECT state, rejection_reason, evidence_confidence, estimated_build_days FROM opportunities WHERE id = $1',
    [id],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`no opportunity ${id}`);
  return row;
}

describe('verifyOpportunity', () => {
  it('verifies a category with strong, independent payment evidence', async () => {
    const { db } = await freshDb(BASE_ENV);
    const id = await insertOpportunity(db, {
      name: 'Minimum and maximum order rules',
      category: 'minimum-maximum-order-rules',
    });
    await seedCompetitor(db, id, {
      name: 'Order Limits Pro',
      url: A_URL,
      pricing: 'Basic: $14.99/mo; Growth: $29.99/mo',
      freeTier: false,
      prices: [14.99, 29.99],
      reviewCount: 1204,
      reviews: [
        { text: 'We pay for the Growth plan and it paid for itself.', signal: 'PAID_PLAN_REFERENCED', duration: 'Over 3 years' },
      ],
    });
    await seedCompetitor(db, id, {
      name: 'MinMax Order Rules',
      url: B_URL,
      pricing: 'Starter: $9/mo; Standard: $24/mo',
      freeTier: false,
      prices: [9, 24],
      reviewCount: 318,
      reviews: [{ text: 'Works fine so far.', signal: 'NONE', duration: '18 months' }],
    });

    const outcome = await verifyOpportunity(id);

    expect(outcome.verified).toBe(true);
    expect(outcome.confidence).toBe('HIGH');
    expect(outcome.paidCompetitorCount).toBe(2);
    expect(outcome.strongEvidence.length).toBeGreaterThan(0);
    expect(outcome.rejectionReason).toBeNull();

    const row = await stateOf(db, id);
    expect(row.state).toBe('CATEGORY_VERIFIED');
    expect(row.evidence_confidence).toBe('HIGH');
    expect(Number(row.estimated_build_days)).toBeGreaterThan(0);
    expect(row.rejection_reason).toBeNull();
  });

  it('rejects a category with no payment evidence at all', async () => {
    const { db } = await freshDb(BASE_ENV);
    const id = await insertOpportunity(db, {
      name: 'Untested niche',
      category: 'untested-niche',
    });

    const outcome = await verifyOpportunity(id);

    expect(outcome.verified).toBe(false);
    expect(outcome.confidence).toBe('NONE');
    expect(outcome.rejectionReason).toBe('NO_PAYMENT_EVIDENCE');

    const row = await stateOf(db, id);
    expect(row.state).toBe('CATEGORY_REJECTED');
    expect(row.rejection_reason).toBe('NO_PAYMENT_EVIDENCE');
  });

  it('rejects a category whose only evidence is weak', async () => {
    const { db } = await freshDb(BASE_ENV);
    const id = await insertOpportunity(db, { name: 'Free tier land', category: 'free-tier-land' });
    await seedCompetitor(db, id, {
      name: 'Everything Free',
      url: A_URL,
      pricing: 'Free; Growth: $19/mo',
      freeTier: true,
      prices: [],
      reviewCount: 900,
      reviews: [{ text: 'Nice app, easy to install.', signal: 'NONE', duration: '2 months' }],
    });

    const outcome = await verifyOpportunity(id);

    expect(outcome.strongEvidence).toEqual([]);
    expect(outcome.confidence).not.toBe('HIGH');
    expect(outcome.rejectionReason).toBe('ONLY_WEAK_EVIDENCE');
    expect((await stateOf(db, id)).state).toBe('CATEGORY_REJECTED');
  });

  it('rejects a disallowed domain before weighing any evidence', async () => {
    const { db } = await freshDb(BASE_ENV);
    const id = await insertOpportunity(db, {
      name: 'Patient triage reminders',
      category: 'patient-triage-reminders',
    });
    await seedCompetitor(db, id, {
      name: 'Triage Pro',
      url: A_URL,
      pricing: '$49/mo',
      freeTier: false,
      prices: [49],
      reviewCount: 500,
      reviews: [{ text: 'We pay for this every month.', signal: 'PAID_PLAN_REFERENCED', duration: 'Over 2 years' }],
    });

    const outcome = await verifyOpportunity(id);

    expect(outcome.verified).toBe(false);
    expect(outcome.rejectionReason).toBe('DISALLOWED_DOMAIN');
    expect((await stateOf(db, id)).rejection_reason).toBe('DISALLOWED_DOMAIN');
  });

  it('records every transition through the state machine audit trail', async () => {
    const { db } = await freshDb(BASE_ENV);
    const id = await insertOpportunity(db, { name: 'Untested niche', category: 'untested-niche' });

    await verifyOpportunity(id);

    const events = await db.query<{ from_state: string; to_state: string; event_type: string }>(
      `SELECT from_state, to_state, event_type FROM audit_events
        WHERE entity_id = $1 AND event_type = 'STATE_TRANSITION' ORDER BY created_at`,
      [id],
    );
    expect(events.rows.map((e) => `${e.from_state}->${e.to_state}`)).toEqual([
      'DISCOVERED->CATEGORY_VERIFYING',
      'CATEGORY_VERIFYING->CATEGORY_REJECTED',
    ]);

    const rejections = await db.query<{ n: string | number }>(
      `SELECT COUNT(*) AS n FROM audit_events WHERE entity_id = $1 AND event_type = 'REJECTION'`,
      [id],
    );
    expect(Number(rejections.rows[0]?.n ?? 0)).toBe(1);
  });

  it('refuses to re-verify an opportunity that has already moved on', async () => {
    const { db } = await freshDb(BASE_ENV);
    const id = await insertOpportunity(db, {
      name: 'Already done',
      category: 'already-done',
      state: 'CATEGORY_VERIFIED',
    });
    await expect(verifyOpportunity(id)).rejects.toThrow(/CATEGORY_VERIFIED/);
  });

  it('raises a typed error for an unknown opportunity', async () => {
    await freshDb(BASE_ENV);
    await expect(verifyOpportunity('opp_does_not_exist')).rejects.toThrow(/no opportunity/);
  });
});

describe('verifyCategories', () => {
  it('respects the daily deep-verification cap', async () => {
    const { db } = await freshDb({ ...BASE_ENV, DEEP_VERIFICATIONS_PER_DAY: '2' });
    for (let i = 0; i < 4; i++) {
      await insertOpportunity(db, { name: `Niche ${i}`, category: `niche-${i}` });
    }

    const first = await verifyCategories(10);
    expect(first).toHaveLength(2);

    // The cap counts work already done today, so a second call does nothing.
    const second = await verifyCategories(10);
    expect(second).toHaveLength(0);

    const remaining = await db.query<{ n: string | number }>(
      `SELECT COUNT(*) AS n FROM opportunities WHERE state = 'DISCOVERED'`,
    );
    expect(Number(remaining.rows[0]?.n ?? 0)).toBe(2);
  });

  it('keeps going when one opportunity fails to verify', async () => {
    const { db } = await freshDb(BASE_ENV);
    const good = await insertOpportunity(db, { name: 'Good one', category: 'good-one' });
    await seedCompetitor(db, good, {
      name: 'Order Limits Pro',
      url: A_URL,
      pricing: '$14.99/mo',
      freeTier: false,
      prices: [14.99],
      reviewCount: 1204,
      reviews: [{ text: 'We pay for the Growth plan.', signal: 'PAID_PLAN_REFERENCED', duration: 'Over 3 years' }],
    });
    await insertOpportunity(db, { name: 'Empty one', category: 'empty-one' });

    const outcomes = await verifyCategories(10);

    expect(outcomes).toHaveLength(2);
    expect(outcomes.filter((o) => o.verified)).toHaveLength(1);
    expect(outcomes.filter((o) => o.rejectionReason === 'NO_PAYMENT_EVIDENCE')).toHaveLength(1);
  });

  it('does nothing when the kill switch is on', async () => {
    const { db } = await freshDb({ ...BASE_ENV, KILL_SWITCH: 'true' });
    await insertOpportunity(db, { name: 'Niche', category: 'niche' });
    expect(await verifyCategories(10)).toEqual([]);
  });
});
