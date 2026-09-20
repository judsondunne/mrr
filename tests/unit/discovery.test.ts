import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { freshDb, teardown } from '../helpers.js';
import { resetFetchState } from '../../src/lib/fetch.js';
import {
  discoverOpportunities,
  getAdapter,
  getAdapters,
  research,
} from '../../src/pipeline/discovery/index.js';
import {
  normalizeListingUrl,
  reviewsUrl,
  ShopifyEvidenceExtractor,
  ShopifyProspectFinder,
  SHOPIFY_SEED_CATEGORIES,
} from '../../src/pipeline/discovery/shopify.js';
import {
  classifyReviewPaymentSignal,
  extractMonthlyPrices,
  extractUsageDuration,
  htmlToText,
  parseAppListing,
  parseReviews,
  tagComplaints,
} from '../../src/pipeline/discovery/parse.js';
import { storeSourceDocument } from '../../src/pipeline/discovery/source-documents.js';
import type { Db } from '../../src/lib/db.js';

// --- fixtures ----------------------------------------------------------------

const FIXTURES = fileURLToPath(new URL('../fixtures/shopify/', import.meta.url));
const fixture = (name: string): string => readFileSync(`${FIXTURES}${name}`, 'utf8');

const PAID_URL = 'https://apps.shopify.com/order-limits-pro';
const PAID2_URL = 'https://apps.shopify.com/minmax-order-rules';
const FREE_URL = 'https://apps.shopify.com/cart-rule-guard';
const AMBIGUOUS_URL = 'https://apps.shopify.com/enterprise-order-rules';
const BROKEN_URL = 'https://apps.shopify.com/broken-app';

const BASE_ENV: Record<string, string> = {
  FETCH_MIN_DELAY_MS: '0',
  FETCH_MAX_RETRIES: '0',
  FETCH_TIMEOUT_MS: '5000',
  MONTHLY_SEARCH_BUDGET_USD: '5',
  MONTHLY_LLM_BUDGET_USD: '20',
  DISCOVERY_CANDIDATES_PER_DAY: '20',
  KILL_SWITCH: 'false',
};

function routes(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    [PAID_URL]: fixture('app-listing-paid.html'),
    [reviewsUrl(PAID_URL)]: fixture('reviews-paid-signals.html'),
    [PAID2_URL]: fixture('app-listing-paid-2.html'),
    [reviewsUrl(PAID2_URL)]: fixture('reviews-generic.html'),
    [FREE_URL]: fixture('app-listing-free-tier.html'),
    [reviewsUrl(FREE_URL)]: fixture('reviews-generic.html'),
    [AMBIGUOUS_URL]: fixture('app-listing-ambiguous.html'),
    [BROKEN_URL]: fixture('app-listing-malformed.html'),
    ...overrides,
  };
}

/**
 * The suite must never touch a network. Every fetch is answered from a fixture;
 * anything unrouted is a 404 so an accidental live URL fails loudly.
 */
function installFetchStub(routeMap: Record<string, string>): string[] {
  const calls: string[] = [];
  const stub = async (input: string | URL | Request): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    if (url.endsWith('/robots.txt')) {
      return new Response('User-agent: *\nAllow: /\n', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }
    const body = routeMap[url];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  };
  vi.stubGlobal('fetch', stub);
  resetFetchState();
  return calls;
}

async function countRows(db: Db, table: string, where = '', params: unknown[] = []): Promise<number> {
  const res = await db.query<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM ${table} ${where}`,
    params,
  );
  return Number(res.rows[0]?.n ?? 0);
}

afterEach(async () => {
  vi.unstubAllGlobals();
  resetFetchState();
  await teardown();
});

// --- deterministic extraction ------------------------------------------------

describe('deterministic listing extraction', () => {
  it('extracts plans, prices, trial and no-free-tier verdict from a paid listing', () => {
    const listing = parseAppListing(fixture('app-listing-paid.html'), PAID_URL);

    expect(listing.name).toBe('Order Limits Pro');
    expect(listing.developer).toBe('Ruleworks Software');
    expect(listing.plans.map((p) => p.name)).toEqual(['Basic', 'Growth', 'Plus']);
    expect(listing.plans.map((p) => p.priceMonthly)).toEqual([14.99, 29.99, 99]);
    expect(listing.hasPermanentFreeTier).toBe(false);
    expect(listing.freeTrialDays).toBe(7);
    expect(listing.reviewCount).toBe(1204);
    expect(listing.rating).toBe(4.8);
    expect(listing.launchAge).toBe('March 2018');
    expect(listing.currentPricing).toContain('Basic: $14.99/mo');
    expect(listing.ambiguous).toBe(false);
    expect(listing.parseWarnings).toEqual([]);
  });

  it('normalizes annual pricing to a monthly figure and reads attribute-only metadata', () => {
    const listing = parseAppListing(fixture('app-listing-paid-2.html'), PAID2_URL);

    expect(listing.name).toBe('MinMax Order Rules');
    expect(listing.plans.map((p) => p.priceMonthly)).toEqual([9, 24, 20]);
    expect(listing.reviewCount).toBe(318);
    expect(listing.rating).toBe(4.6);
    expect(listing.hasPermanentFreeTier).toBe(false);
  });

  it('detects a permanent free tier and keeps its details', () => {
    const listing = parseAppListing(fixture('app-listing-free-tier.html'), FREE_URL);

    expect(listing.hasPermanentFreeTier).toBe(true);
    expect(listing.freePlanDetails).toContain('Up to 50 orders per month');
    expect(listing.plans.some((p) => p.isFree)).toBe(true);
    expect(listing.plans.find((p) => p.name === 'Growth')?.priceMonthly).toBe(19);
    expect(listing.reviewCount).toBe(342);
    expect(listing.rating).toBe(4.2);
  });

  it('does not treat a free trial as a permanent free tier', () => {
    const listing = parseAppListing(fixture('app-listing-paid.html'), PAID_URL);
    expect(listing.freeTrialDays).toBe(7);
    expect(listing.hasPermanentFreeTier).toBe(false);
  });

  it('flags a page as ambiguous only when pricing exists but cannot be parsed', () => {
    const ambiguous = parseAppListing(fixture('app-listing-ambiguous.html'), AMBIGUOUS_URL);
    expect(ambiguous.plans).toHaveLength(0);
    expect(ambiguous.hasPermanentFreeTier).toBeNull();
    expect(ambiguous.ambiguous).toBe(true);

    const clear = parseAppListing(fixture('app-listing-paid.html'), PAID_URL);
    expect(clear.ambiguous).toBe(false);
  });

  it('never throws on a malformed page', () => {
    const broken = fixture('app-listing-malformed.html');
    expect(() => parseAppListing(broken, BROKEN_URL)).not.toThrow();
    expect(() => parseReviews(broken, BROKEN_URL)).not.toThrow();
    expect(() => htmlToText(broken)).not.toThrow();

    const listing = parseAppListing(broken, BROKEN_URL);
    expect(listing.url).toBe(BROKEN_URL);
    expect(listing.plans.every((p) => p.priceMonthly === null || p.priceMonthly >= 0)).toBe(true);
    expect(listing.rating).toBeNull();
  });

  it('never throws on empty or nonsense input', () => {
    expect(() => parseAppListing('', 'https://apps.shopify.com/x')).not.toThrow();
    expect(() => parseAppListing('<<<>>>not html at all', 'https://apps.shopify.com/x')).not.toThrow();
    expect(parseReviews('', 'https://apps.shopify.com/x')).toEqual([]);
  });

  it('extracts monthly prices from free text', () => {
    expect(extractMonthlyPrices('$14.99 / month').map((p) => p.amount)).toEqual([14.99]);
    expect(extractMonthlyPrices('$240 per year').map((p) => p.amount)).toEqual([20]);
    expect(extractMonthlyPrices('call us for a quote')).toEqual([]);
  });
});

describe('deterministic review extraction', () => {
  it('reads ratings, dates, merchants, durations and payment signals', () => {
    const reviews = parseReviews(fixture('reviews-paid-signals.html'), reviewsUrl(PAID_URL));

    expect(reviews).toHaveLength(4);
    expect(reviews.map((r) => r.rating)).toEqual([5, 4, 5, 2]);
    expect(reviews.map((r) => r.reviewDate)).toEqual([
      '2025-04-18',
      '2025-02-02',
      '2024-11-09',
      '2024-09-30',
    ]);
    expect(reviews[0]?.merchantName).toBe('Harbour Supply Co');
    expect(reviews[0]?.usageDuration).toBe('Over 3 years');
    expect(reviews.map((r) => r.paymentSignal)).toEqual([
      'PAID_PLAN_REFERENCED',
      'EXCEEDS_FREE_TIER',
      'NONE',
      'NONE',
    ]);
    expect(reviews[3]?.complaintTags).toContain('missing-feature');
  });

  it('classifies payment language without an LLM', () => {
    expect(classifyReviewPaymentSignal('We pay for the Growth plan every month')).toBe(
      'PAID_PLAN_REFERENCED',
    );
    expect(classifyReviewPaymentSignal('we hit the limit and had to upgrade')).toBe(
      'EXCEEDS_FREE_TIER',
    );
    expect(classifyReviewPaymentSignal('Great app, easy to install')).toBe('NONE');
  });

  it('extracts usage duration phrasings', () => {
    expect(extractUsageDuration('Over 3 years using the app')).toBe('Over 3 years');
    expect(extractUsageDuration('About 2 years using the app')).toBe('About 2 years');
    expect(extractUsageDuration('no duration here')).toBeNull();
  });

  it('tags complaints deterministically', () => {
    expect(tagComplaints('the app is slow and the price hike was too expensive')).toEqual(
      expect.arrayContaining(['pricing', 'performance']),
    );
    expect(tagComplaints('perfect, no notes')).toEqual([]);
  });
});

// --- URL handling ------------------------------------------------------------

describe('listing URL normalization', () => {
  it('accepts real listing URLs and canonicalizes sub-pages', () => {
    expect(normalizeListingUrl(PAID_URL)).toBe(PAID_URL);
    expect(normalizeListingUrl(`${PAID_URL}/reviews?page=2`)).toBe(PAID_URL);
    expect(normalizeListingUrl('https://apps.shopify.com/Order-Limits-Pro')).toBe(PAID_URL);
  });

  it('rejects non-listing and off-marketplace URLs', () => {
    expect(normalizeListingUrl('https://apps.shopify.com/categories/selling-products')).toBeNull();
    expect(normalizeListingUrl('https://apps.shopify.com/search?q=order')).toBeNull();
    expect(normalizeListingUrl('https://example.com/order-limits-pro')).toBeNull();
    expect(normalizeListingUrl('not a url')).toBeNull();
  });
});

describe('adapter registry', () => {
  it('exposes exactly the shopify adapter', () => {
    expect(getAdapters().map((a) => a.ecosystem)).toEqual(['shopify']);
    expect(getAdapter('SHOPIFY')?.ecosystem).toBe('shopify');
    expect(getAdapter('woocommerce')).toBeNull();
  });

  it('seeds narrow categories with unique slugs', () => {
    const slugs = SHOPIFY_SEED_CATEGORIES.map((s) => s.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs.length).toBeGreaterThanOrEqual(15);
  });

  it('refuses to pretend it can find prospects', async () => {
    await expect(new ShopifyProspectFinder().find()).rejects.toThrow(/NOT_IMPLEMENTED|not implemented/i);
  });
});

// --- extraction against the stubbed network ----------------------------------

describe('ShopifyEvidenceExtractor', () => {
  it('stores the listing and reviews as source documents and derives evidence', async () => {
    const { db } = await freshDb(BASE_ENV);
    installFetchStub(routes());

    const extracted = await new ShopifyEvidenceExtractor().extractCompetitor(PAID_URL);

    expect(extracted).not.toBeNull();
    expect(extracted?.name).toBe('Order Limits Pro');
    expect(extracted?.hasPermanentFreeTier).toBe(false);
    expect(extracted?.reviews).toHaveLength(4);
    expect(extracted?.evidence.map((e) => e.type)).toEqual(
      expect.arrayContaining([
        'INCUMBENT_NO_FREE_TIER',
        'CUSTOMER_REFERENCES_PAID_PLAN',
        'CUSTOMER_EXCEEDS_FREE_TIER',
        'SUSTAINED_USAGE_DURATION',
      ]),
    );
    for (const item of extracted?.evidence ?? []) {
      expect(item.sourceUrl).toMatch(/^https:\/\/apps\.shopify\.com\//);
      expect(item.quote.length).toBeGreaterThan(0);
    }

    expect(await countRows(db, 'source_documents')).toBe(2);
    const types = await db.query<{ source_type: string }>(
      'SELECT source_type FROM source_documents ORDER BY source_type',
    );
    expect(types.rows.map((r) => r.source_type)).toEqual(['APP_LISTING', 'REVIEWS']);
  });

  it('survives a malformed listing without throwing', async () => {
    await freshDb(BASE_ENV);
    installFetchStub(routes());

    const extracted = await new ShopifyEvidenceExtractor().extractCompetitor(BROKEN_URL);
    expect(extracted).not.toBeNull();
    expect(extracted?.url).toBe(BROKEN_URL);
  });

  it('returns null rather than throwing when the page cannot be fetched', async () => {
    await freshDb(BASE_ENV);
    installFetchStub({});

    const extracted = await new ShopifyEvidenceExtractor().extractCompetitor(
      'https://apps.shopify.com/missing-app',
    );
    expect(extracted).toBeNull();
  });

  it('uses the fast LLM tier only for genuinely ambiguous pricing', async () => {
    const { llm } = await freshDb(BASE_ENV);
    llm.register('shopify_pricing_disambiguation', () => ({
      hasPermanentFreeTier: false,
      monthlyPrices: [49, 149],
      planNames: ['Launch', 'Scale'],
      freeTrialDays: null,
    }));
    installFetchStub(routes());

    const extractor = new ShopifyEvidenceExtractor();

    await extractor.extractCompetitor(PAID_URL);
    expect(llm.calls).toHaveLength(0); // deterministic parse succeeded

    const ambiguous = await extractor.extractCompetitor(AMBIGUOUS_URL);
    expect(llm.calls.map((c) => c.tier)).toEqual(['fast']);
    expect(ambiguous?.hasPermanentFreeTier).toBe(false);
    expect(ambiguous?.currentPricing).toContain('Launch');
  });

  it('never re-analyzes unchanged content (content-hash dedup)', async () => {
    const { db, llm } = await freshDb(BASE_ENV);
    llm.register('shopify_pricing_disambiguation', () => ({
      hasPermanentFreeTier: false,
      monthlyPrices: [49],
      planNames: ['Launch'],
      freeTrialDays: null,
    }));
    installFetchStub(routes());

    const extractor = new ShopifyEvidenceExtractor();
    await extractor.extractCompetitor(AMBIGUOUS_URL);
    expect(llm.calls).toHaveLength(1);
    expect(await countRows(db, 'source_documents', 'WHERE url = $1', [AMBIGUOUS_URL])).toBe(1);

    // Same bytes again: no new source document, no new analysis.
    await extractor.extractCompetitor(AMBIGUOUS_URL);
    expect(llm.calls).toHaveLength(1);
    expect(await countRows(db, 'source_documents', 'WHERE url = $1', [AMBIGUOUS_URL])).toBe(1);

    // Changed content: a new document version, and analysis runs again.
    const changed = fixture('app-listing-ambiguous.html').replace(
      'Plans are named Launch, Scale and Custom.',
      'Plans are named Pilot, Volume and Bespoke and are quoted per region.',
    );
    installFetchStub(routes({ [AMBIGUOUS_URL]: changed }));
    await extractor.extractCompetitor(AMBIGUOUS_URL);
    expect(llm.calls).toHaveLength(2);
    expect(await countRows(db, 'source_documents', 'WHERE url = $1', [AMBIGUOUS_URL])).toBe(2);
  });
});

describe('source document storage', () => {
  it('reports isNew=false for identical content and ignores whitespace churn', async () => {
    const { db } = await freshDb(BASE_ENV);
    const first = await storeSourceDocument({
      url: 'https://example.com/a',
      sourceType: 'COMMUNITY',
      text: 'Hello   World',
    });
    const second = await storeSourceDocument({
      url: 'https://example.com/a',
      sourceType: 'COMMUNITY',
      text: 'hello world',
    });

    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);
    expect(second.contentHash).toBe(first.contentHash);
    expect(await countRows(db, 'source_documents')).toBe(1);
  });
});

// --- the discovery pass ------------------------------------------------------

function registerSearch(search: { register: (needle: string, results: Array<{ title: string; url: string; description: string }>) => unknown }): void {
  search.register('minimum order amount', [
    { title: 'Order Limits Pro', url: PAID_URL, description: 'Minimum order rules' },
    { title: 'MinMax Order Rules', url: `${PAID2_URL}/reviews`, description: 'Order limits' },
    {
      title: 'Order limits category',
      url: 'https://apps.shopify.com/categories/orders-and-shipping',
      description: 'Category page',
    },
    { title: 'Unrelated', url: 'https://example.com/blog/order-limits', description: 'Blog' },
  ]);
}

describe('discoverOpportunities', () => {
  it('creates an opportunity with competitors, reviews and source documents', async () => {
    const { db, search } = await freshDb(BASE_ENV);
    registerSearch(search);
    installFetchStub(routes());

    const result = await discoverOpportunities(5);

    expect(result.candidatesFound).toBe(1);
    expect(result.opportunitiesCreated).toBe(1);
    expect(result.duplicatesSkipped).toBe(0);

    const opp = await db.query<{ id: string; state: string; category: string; dedupe_key: string }>(
      'SELECT id, state, category, dedupe_key FROM opportunities',
    );
    expect(opp.rows).toHaveLength(1);
    expect(opp.rows[0]?.state).toBe('DISCOVERED');
    expect(opp.rows[0]?.dedupe_key).toBe('shopify:minimum-maximum-order-rules');

    expect(await countRows(db, 'competitors')).toBe(2);
    expect(await countRows(db, 'reviews')).toBe(7);
    expect(await countRows(db, 'source_documents')).toBe(4);

    const linked = await countRows(db, 'source_documents', 'WHERE opportunity_id IS NOT NULL');
    expect(linked).toBe(4);
  });

  it('is idempotent: a second pass creates zero duplicates', async () => {
    const { db, search } = await freshDb(BASE_ENV);
    registerSearch(search);
    installFetchStub(routes());

    const first = await discoverOpportunities(5);
    const opportunities = await countRows(db, 'opportunities');
    const competitors = await countRows(db, 'competitors');
    const reviews = await countRows(db, 'reviews');
    const documents = await countRows(db, 'source_documents');

    const second = await discoverOpportunities(5);

    expect(first.opportunitiesCreated).toBe(1);
    expect(second.opportunitiesCreated).toBe(0);
    expect(second.duplicatesSkipped).toBe(1);
    expect(second.opportunityIds).toEqual(first.opportunityIds);

    expect(await countRows(db, 'opportunities')).toBe(opportunities);
    expect(await countRows(db, 'competitors')).toBe(competitors);
    expect(await countRows(db, 'reviews')).toBe(reviews);
    expect(await countRows(db, 'source_documents')).toBe(documents);
  });

  it('uses the cached search result instead of searching twice', async () => {
    const { search } = await freshDb(BASE_ENV);
    registerSearch(search);
    installFetchStub(routes());

    await discoverOpportunities(5);
    const firstPassQueries = search.queries.length;
    await discoverOpportunities(5);

    expect(firstPassQueries).toBeGreaterThan(0);
    expect(search.queries.length).toBe(firstPassQueries);
  });

  it('stops before spending when the search budget is gone', async () => {
    const { search } = await freshDb({ ...BASE_ENV, MONTHLY_SEARCH_BUDGET_USD: '0' });
    registerSearch(search);
    installFetchStub(routes());

    const result = await discoverOpportunities(5);

    expect(result.candidatesFound).toBe(0);
    expect(search.queries).toHaveLength(0);
  });

  it('skips the pass entirely when the kill switch is on', async () => {
    const { search } = await freshDb({ ...BASE_ENV, KILL_SWITCH: 'true' });
    registerSearch(search);
    installFetchStub(routes());

    const result = await discoverOpportunities(5);

    expect(result).toEqual({
      candidatesFound: 0,
      opportunitiesCreated: 0,
      duplicatesSkipped: 0,
      opportunityIds: [],
    });
    expect(search.queries).toHaveLength(0);
  });
});

// --- generic research helper -------------------------------------------------

describe('research helper', () => {
  it('searches once, fetches pages, and stores cleaned text', async () => {
    const { db, search } = await freshDb(BASE_ENV);
    search.register('order limits', [
      { title: 'Order Limits Pro', url: PAID_URL, description: 'listing' },
    ]);
    installFetchStub(routes());

    const first = await research('order limits shopify', { fetchPages: 1, sourceType: 'APP_LISTING' });

    expect(first.budgetExhausted).toBe(false);
    expect(first.results).toHaveLength(1);
    expect(first.pages).toHaveLength(1);
    expect(first.pages[0]?.isNew).toBe(true);
    expect(first.pages[0]?.text).toContain('Order Limits Pro');
    expect(first.pages[0]?.text).not.toContain('<script');
    expect(await countRows(db, 'source_documents')).toBe(1);

    const second = await research('order limits shopify', { fetchPages: 1, sourceType: 'APP_LISTING' });
    expect(search.queries).toHaveLength(1); // served from the search cache
    expect(second.pages[0]?.isNew).toBe(false); // content unchanged
    expect(await countRows(db, 'source_documents')).toBe(1);
  });

  it('reports an exhausted budget instead of searching', async () => {
    const { search } = await freshDb({ ...BASE_ENV, MONTHLY_SEARCH_BUDGET_USD: '0' });
    search.register('anything', [{ title: 't', url: PAID_URL, description: 'd' }]);

    const result = await research('anything at all');

    expect(result.budgetExhausted).toBe(true);
    expect(result.results).toEqual([]);
    expect(search.queries).toHaveLength(0);
  });
});
