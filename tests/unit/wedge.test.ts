import { describe, it, expect, afterEach } from 'vitest';
import { freshDb, teardown, insertOpportunity } from '../helpers.js';
import { contentHash, newId } from '../../src/lib/hash.js';
import type { Db } from '../../src/lib/db.js';
import {
  clusterComplaints,
  extractComplaintText,
  needsLlmNaming,
  severityFor,
  tagComplaintText,
} from '../../src/pipeline/wedge/clustering.js';
import {
  validateWedge,
  containsCustomerNoun,
  findBannedPhrases,
  MAX_V1_FEATURES,
} from '../../src/pipeline/wedge/generate.js';
import {
  generateWedgeFor,
  generateWedges,
  loadWedgeFor,
  rejectionReasonFor,
} from '../../src/pipeline/wedge/index.js';

afterEach(async () => {
  for (const key of Object.keys(ENV)) delete process.env[key];
  await teardown();
});

const ENV: Record<string, string> = {
  MAX_MVP_BUILD_DAYS: '7',
  MONTHLY_LLM_BUDGET_USD: '20',
  MONTHLY_SEARCH_BUDGET_USD: '5',
};

/** A wedge that a human would recognise as narrow and buildable. */
const GOOD_WEDGE = {
  statement:
    'For Shopify wholesalers who only sell case-pack quantities, enforce per-customer minimum order rules at checkout so retail stockists cannot place unprofitable orders.',
  productName: 'Case Pack Rules',
  targetCustomer:
    'Shopify merchants running a wholesale channel who sell only in case-pack quantities to independent retail stockists',
  coreWorkflow:
    'Set a minimum order value and case-pack multiple per customer tag, then block carts that do not meet it at checkout.',
  v1Features: [
    'Minimum order value per customer tag',
    'Case-pack quantity rounding in the cart',
    'Checkout block with a plain-language message',
    'CSV import of customer tags',
  ],
  excludedFromV1: ['Net-30 invoicing', 'Quote requests', 'Multi-currency price lists', 'Sales rep accounts'],
  proposedPriceMonthly: 29,
  estimatedBuildDays: 5,
  primaryCompetitor: 'Wholesale Gorilla',
  reasonSomeoneWouldSwitch:
    'They only need order minimums, not a whole wholesale channel, and will not pay $99/mo for the rest of it.',
  oneSentenceOutcome: 'Stockists can only place orders that are actually profitable to pack and ship.',
  capabilities: [
    'Minimum order value per customer tag',
    'Case-pack rounding in the cart',
    'Clear checkout messaging',
  ],
  whoItIsFor: 'Shopify merchants with a wholesale customer tag and case-pack only products',
};

const GENERIC_WEDGE = {
  ...GOOD_WEDGE,
  statement:
    'An AI-powered commerce optimization platform that helps businesses of all sizes unlock growth across every channel.',
  productName: 'CommerceAI',
  targetCustomer: 'Online businesses',
  coreWorkflow: 'Optimize everything, automatically, with best-in-class intelligence.',
  oneSentenceOutcome: 'Transform your business with an all-in-one solution.',
  whoItIsFor: 'Any business selling online',
};

async function insertCompetitor(db: Db, opportunityId: string, name = 'Wholesale Gorilla'): Promise<string> {
  const id = newId('cmp');
  await db.query(
    `INSERT INTO competitors
       (id, opportunity_id, name, url, current_pricing, has_permanent_free_tier, review_count, rating)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, opportunityId, name, `https://apps.shopify.com/${id}`, '$99/month', false, 140, 4.5],
  );
  return id;
}

async function insertReview(db: Db, competitorId: string, text: string, rating: number | null): Promise<string> {
  const id = newId('rev');
  await db.query(
    `INSERT INTO reviews
       (id, competitor_id, source_url, rating, text, payment_signal, complaint_tags, content_hash)
     VALUES ($1,$2,$3,$4,$5,'NONE','[]',$6)`,
    [id, competitorId, 'https://apps.shopify.com/gorilla/reviews', rating, text, contentHash(text)],
  );
  return id;
}

describe('deterministic complaint tagging', () => {
  it('tags known complaint classes by phrase and stem', () => {
    expect(tagComplaintText('it is way too expensive for what it does')).toContain('PRICING');
    expect(tagComplaintText('we hit the limit on the number of rules')).toContain('LIMITS');
    expect(tagComplaintText('the app kept crashing and broke my theme')).toEqual(
      expect.arrayContaining(['BUGS_RELIABILITY', 'INTEGRATION']),
    );
    expect(tagComplaintText('setup was a nightmare, we needed a developer')).toContain('COMPLEXITY_SETUP');
    expect(tagComplaintText('wish it had a way to set minimums per tag')).toContain('MISSING_FEATURE');
  });

  it('does not tag plain praise', () => {
    expect(tagComplaintText('this app is great and the team is lovely')).toEqual([]);
  });

  it('keeps only the complaint sentences of a positive review', () => {
    const text = 'Great app overall. The only downside is that setup was a nightmare.';
    const complaint = extractComplaintText(text, 5);
    expect(complaint).not.toContain('Great app overall');
    expect(complaint).toContain('setup was a nightmare');
  });

  it('treats a low-rated review as a complaint in full', () => {
    expect(extractComplaintText('The dashboard is fine.', 1)).toBe('The dashboard is fine.');
  });

  it('blends volume with the inherent severity of the class', () => {
    expect(severityFor(1, 10, 'MEDIUM')).toBe('LOW');
    expect(severityFor(3, 10, 'MEDIUM')).toBe('MEDIUM');
    expect(severityFor(3, 10, 'HIGH')).toBe('HIGH');
    expect(severityFor(5, 10, 'MEDIUM')).toBe('HIGH');
  });

  it('only escalates to the reasoner when deterministic tagging is insufficient', () => {
    expect(needsLlmNaming({ totalComplaintReviews: 8, untaggedComplaintReviews: 1, deterministicClusters: 6 })).toBe(false);
    expect(needsLlmNaming({ totalComplaintReviews: 8, untaggedComplaintReviews: 4, deterministicClusters: 3 })).toBe(true);
    expect(needsLlmNaming({ totalComplaintReviews: 6, untaggedComplaintReviews: 0, deterministicClusters: 1 })).toBe(true);
    expect(needsLlmNaming({ totalComplaintReviews: 0, untaggedComplaintReviews: 0, deterministicClusters: 0 })).toBe(false);
  });
});

describe('clustering fixture reviews', () => {
  it('produces the expected clusters with evidence, without calling an LLM', async () => {
    const ctx = await freshDb(ENV);
    const oppId = await insertOpportunity(ctx.db, { state: 'CATEGORY_VERIFIED' });
    const compId = await insertCompetitor(ctx.db, oppId);

    await insertReview(ctx.db, compId, 'The app works but it is way too expensive for what it does, and we hit the limit on rules.', 2);
    await insertReview(ctx.db, compId, 'Support never replied to my ticket and the app stopped working after a theme update.', 1);
    await insertReview(ctx.db, compId, 'Great app overall. The only downside is that setup was a nightmare and we had to hire a developer.', 5);
    await insertReview(ctx.db, compId, 'Wish it had a way to set different minimums per customer tag. There is no way to do it today.', 3);
    await insertReview(ctx.db, compId, 'Solid app, no complaints.', 4);
    await insertReview(ctx.db, compId, 'Honestly too complicated. The onboarding has a steep learning curve.', 2);
    await insertReview(ctx.db, compId, 'Hard to set up without editing the theme yourself.', 2);
    await insertReview(ctx.db, compId, 'Took hours to configure and the documentation is poor.', 2);

    const clusters = await clusterComplaints(oppId);
    const byName = new Map(clusters.map((c) => [c.code, c]));

    expect(byName.has('PRICING')).toBe(true);
    expect(byName.has('LIMITS')).toBe(true);
    expect(byName.has('SUPPORT')).toBe(true);
    expect(byName.has('BUGS_RELIABILITY')).toBe(true);
    expect(byName.has('MISSING_FEATURE')).toBe(true);

    const setup = byName.get('COMPLEXITY_SETUP');
    expect(setup).toBeDefined();
    expect(setup?.count).toBe(4);
    expect(setup?.severity).toBe('HIGH');
    expect(setup?.evidenceReviewIds).toHaveLength(4);
    expect(setup?.source).toBe('DETERMINISTIC');

    // Highest severity, highest volume cluster leads the wedge.
    expect(clusters[0]?.code).toBe('COMPLEXITY_SETUP');
    expect(clusters[0]?.relevance).toBe('PRIMARY_WEDGE_TARGET');

    // Deterministic tagging handled it: no model was consulted.
    expect(ctx.llm.calls).toHaveLength(0);

    const persisted = await ctx.db.query<{ name: string; count: number; severity: string; evidence_review_ids: unknown }>(
      'SELECT name, count, severity, evidence_review_ids FROM complaint_clusters WHERE opportunity_id = $1',
      [oppId],
    );
    expect(persisted.rows.length).toBe(clusters.length);

    // Re-running replaces rather than duplicates.
    await clusterComplaints(oppId);
    const again = await ctx.db.query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM complaint_clusters WHERE opportunity_id = $1',
      [oppId],
    );
    expect(Number(again.rows[0]?.n)).toBe(clusters.length);
  });

  it('escalates to the reasoner only when the taxonomy cannot classify the complaints', async () => {
    const ctx = await freshDb(ENV);
    const oppId = await insertOpportunity(ctx.db, { state: 'CATEGORY_VERIFIED' });
    const compId = await insertCompetitor(ctx.db, oppId);

    await insertReview(ctx.db, compId, 'The weekly digest is a disappointment for our team.', 2);
    await insertReview(ctx.db, compId, 'I am frustrated by how the digest lands in the middle of the night.', 2);
    await insertReview(ctx.db, compId, 'The onboarding emails are annoying.', 2);
    await insertReview(ctx.db, compId, 'Our issue is that the digest arrives at 3am every Tuesday.', 2);

    ctx.llm.register('wedge.cluster_untagged', () => ({
      clusters: [
        {
          name: 'Notification timing and noise',
          description: 'Digest and onboarding emails arrive at the wrong time.',
          severity: 'MEDIUM',
          mergeIntoCode: null,
          snippetIndexes: [0, 1, 2, 3, 99],
        },
      ],
    }));

    const clusters = await clusterComplaints(oppId);
    expect(ctx.llm.calls.map((c) => c.task)).toContain('wedge.cluster_untagged');
    expect(ctx.llm.calls[0]?.tier).toBe('reasoner');

    const named = clusters.find((c) => c.name === 'Notification timing and noise');
    expect(named).toBeDefined();
    expect(named?.source).toBe('LLM');
    // The out-of-range index the model invented is dropped.
    expect(named?.evidenceReviewIds).toHaveLength(4);
  });
});

describe('code-side wedge validator', () => {
  it('accepts a genuinely narrow wedge', () => {
    const result = validateWedge(GOOD_WEDGE, { maxBuildDays: 7 });
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.wedge?.statement).toBe(GOOD_WEDGE.statement);
  });

  it('rejects a generic "AI-powered commerce platform" wedge', () => {
    const result = validateWedge(GENERIC_WEDGE, { maxBuildDays: 7 });
    expect(result.ok).toBe(false);
    const codes = result.problems.map((p) => p.code);
    expect(codes).toContain('GENERIC_STATEMENT');
    expect(codes).toContain('NO_SPECIFIC_CUSTOMER');
    expect(codes).toContain('CUSTOMER_NOT_NARROW');
    expect(result.wedge).toBeNull();
  });

  it('rejects a seven-feature V1', () => {
    const result = validateWedge(
      {
        ...GOOD_WEDGE,
        v1Features: [
          'Minimum order value per customer tag',
          'Case-pack rounding',
          'Checkout block message',
          'CSV import',
          'Analytics dashboard',
          'Multi-currency price lists',
          'Sales rep accounts',
        ],
      },
      { maxBuildDays: 7 },
    );
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.code)).toContain('TOO_MANY_V1_FEATURES');
    expect(MAX_V1_FEATURES).toBe(5);
  });

  it('rejects an over-budget build estimate', () => {
    const result = validateWedge({ ...GOOD_WEDGE, estimatedBuildDays: 21 }, { maxBuildDays: 7 });
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.code)).toContain('BUILD_TOO_LONG');
  });

  it('rejects a price outside the sane self-serve band', () => {
    expect(validateWedge({ ...GOOD_WEDGE, proposedPriceMonthly: 2 }, { maxBuildDays: 7 }).problems.map((p) => p.code)).toContain('PRICE_OUT_OF_RANGE');
    expect(validateWedge({ ...GOOD_WEDGE, proposedPriceMonthly: 480 }, { maxBuildDays: 7 }).problems.map((p) => p.code)).toContain('PRICE_OUT_OF_RANGE');
  });

  it('rejects a V1 feature that is also on the NOT-in-V1 list', () => {
    const result = validateWedge(
      { ...GOOD_WEDGE, excludedFromV1: ['CSV import of customer tags', 'Net-30 invoicing'] },
      { maxBuildDays: 7 },
    );
    expect(result.problems.map((p) => p.code)).toContain('V1_CONTRADICTS_EXCLUSIONS');
  });

  it('rejects a malformed answer outright', () => {
    expect(validateWedge(null).ok).toBe(false);
    expect(validateWedge({ statement: 'hi' }).problems[0]?.code).toBe('MALFORMED');
  });

  it('knows a marketing phrase from a customer noun', () => {
    expect(findBannedPhrases('an all-in-one platform')).toEqual(expect.arrayContaining(['platform', 'all-in-one']));
    expect(containsCustomerNoun('Shopify wholesalers')).toBe(true);
    expect(containsCustomerNoun('modern teams')).toBe(false);
  });

  it('maps validator problems to the right kill reason', () => {
    expect(rejectionReasonFor([{ code: 'BUILD_TOO_LONG', message: '' }])).toBe('BUILD_TOO_LARGE');
    expect(rejectionReasonFor([{ code: 'GENERIC_STATEMENT', message: '' }])).toBe('GENERIC_AI_WRAPPER');
    expect(rejectionReasonFor([{ code: 'NO_COMPETITOR', message: '' }])).toBe('MANUAL');
  });
});

describe('wedge generation end to end', () => {
  it('moves a verified category to WEDGE_GENERATED and persists the wedge', async () => {
    const ctx = await freshDb(ENV);
    const oppId = await insertOpportunity(ctx.db, { state: 'CATEGORY_VERIFIED' });
    await insertCompetitor(ctx.db, oppId);
    ctx.llm.register('wedge.synthesize', () => GOOD_WEDGE);

    const result = await generateWedgeFor(oppId);
    expect(result.rejected).toBe(false);
    expect(result.wedge?.statement).toBe(GOOD_WEDGE.statement);
    expect(ctx.llm.calls.find((c) => c.task === 'wedge.synthesize')?.tier).toBe('reasoner');

    const row = await ctx.db.query<{
      state: string;
      proposed_wedge: string;
      target_customer: string;
      proposed_price_monthly: string;
      estimated_build_days: number;
    }>(
      `SELECT state, proposed_wedge, target_customer, proposed_price_monthly, estimated_build_days
         FROM opportunities WHERE id = $1`,
      [oppId],
    );
    expect(row.rows[0]?.state).toBe('WEDGE_GENERATED');
    expect(row.rows[0]?.proposed_wedge).toBe(GOOD_WEDGE.statement);
    expect(row.rows[0]?.target_customer).toBe(GOOD_WEDGE.targetCustomer);
    expect(Number(row.rows[0]?.proposed_price_monthly)).toBe(29);
    expect(Number(row.rows[0]?.estimated_build_days)).toBe(5);

    const stored = await loadWedgeFor(oppId);
    expect(stored?.v1Features).toHaveLength(4);

    const audit = await ctx.db.query<{ from_state: string; to_state: string }>(
      `SELECT from_state, to_state FROM audit_events
        WHERE entity_id = $1 AND event_type = 'STATE_TRANSITION'`,
      [oppId],
    );
    expect(audit.rows[0]?.from_state).toBe('CATEGORY_VERIFIED');
    expect(audit.rows[0]?.to_state).toBe('WEDGE_GENERATED');
  });

  it('is idempotent: a second run does not re-synthesize', async () => {
    const ctx = await freshDb(ENV);
    const oppId = await insertOpportunity(ctx.db, { state: 'CATEGORY_VERIFIED' });
    ctx.llm.register('wedge.synthesize', () => GOOD_WEDGE);

    await generateWedgeFor(oppId);
    const callsAfterFirst = ctx.llm.calls.length;
    const second = await generateWedgeFor(oppId);

    expect(second.rejected).toBe(false);
    expect(second.wedge?.statement).toBe(GOOD_WEDGE.statement);
    expect(ctx.llm.calls.length).toBe(callsAfterFirst);
  });

  it('retries with the validator complaints attached and accepts the fixed wedge', async () => {
    const ctx = await freshDb(ENV);
    const oppId = await insertOpportunity(ctx.db, { state: 'CATEGORY_VERIFIED' });

    let calls = 0;
    const seenPrompts: string[] = [];
    ctx.llm.register('wedge.synthesize', (req) => {
      calls += 1;
      seenPrompts.push(req.user);
      return calls === 1 ? { ...GOOD_WEDGE, estimatedBuildDays: 24 } : GOOD_WEDGE;
    });

    const result = await generateWedgeFor(oppId);
    expect(calls).toBe(2);
    expect(result.rejected).toBe(false);
    expect(result.wedge?.estimatedBuildDays).toBe(5);
    expect(seenPrompts[1]).toContain('BUILD_TOO_LONG');
  });

  it('kills the category when no narrow wedge survives the retries', async () => {
    const ctx = await freshDb(ENV);
    const oppId = await insertOpportunity(ctx.db, { state: 'CATEGORY_VERIFIED' });
    ctx.llm.register('wedge.synthesize', () => GENERIC_WEDGE);

    const result = await generateWedgeFor(oppId);
    expect(result.rejected).toBe(true);
    expect(result.wedge).toBeNull();
    expect(result.rejectionDetail).toContain('GENERIC_AI_WRAPPER');

    const row = await ctx.db.query<{ state: string; rejection_reason: string }>(
      'SELECT state, rejection_reason FROM opportunities WHERE id = $1',
      [oppId],
    );
    expect(row.rows[0]?.state).toBe('CATEGORY_REJECTED');
    expect(row.rows[0]?.rejection_reason).toBe('GENERIC_AI_WRAPPER');
  });

  it('only picks up opportunities in CATEGORY_VERIFIED', async () => {
    const ctx = await freshDb(ENV);
    const verified = await insertOpportunity(ctx.db, { state: 'CATEGORY_VERIFIED' });
    const discovered = await insertOpportunity(ctx.db, { state: 'DISCOVERED' });
    ctx.llm.register('wedge.synthesize', () => GOOD_WEDGE);

    const results = await generateWedges(10);
    expect(results.map((r) => r.opportunityId)).toEqual([verified]);

    const skipped = await generateWedgeFor(discovered);
    expect(skipped.wedge).toBeNull();
    expect(skipped.rejectionDetail).toContain('DISCOVERED');
  });
});
