/**
 * The source registry.
 *
 * Two properties matter more than any number in here:
 *   1. nothing discovered is trusted until it has been probed, and
 *   2. trust is capped BY KIND, so scraped filler can never outrank primary
 *      commercial evidence no matter how well it probes.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { freshDb, teardown } from '../helpers';
import { resetFetchState } from '../../src/lib/fetch';
import {
  cappedTrust,
  computeYieldScore,
  evaluateSource,
  getSourceByName,
  listSources,
  proposeSource,
  recordSourceOutcome,
  scoreProbe,
  seedSources,
  sourceYield,
  MAX_ACCEPTABLE_COST_PER_CALL_USD,
  MIN_COST_BASIS_USD,
  MIN_PROBE_SCORE_FOR_VERIFIED,
  SEED_SOURCES,
  SOURCE_TRUST_CEILING,
  UNVERIFIED_TRUST,
  YIELD_WEIGHTS,
  type SourceProbe,
} from '../../src/autonomy/discovery/index';
import type { SourceKind } from '../../src/autonomy/types';

const FIXTURES = fileURLToPath(new URL('../fixtures/ecosystems/', import.meta.url));
const fixture = (name: string): string => readFileSync(`${FIXTURES}${name}`, 'utf8');

const RICH_URL = 'https://marketplace.example.com';
const BARREN_URL = 'https://links.example.org';
const MISSING_URL = 'https://gone.example.net';

const BASE_ENV: Record<string, string> = {
  FETCH_MIN_DELAY_MS: '0',
  FETCH_MAX_RETRIES: '0',
  FETCH_TIMEOUT_MS: '5000',
  MONTHLY_SEARCH_BUDGET_USD: '5',
  MONTHLY_LLM_BUDGET_USD: '20',
  KILL_SWITCH: 'false',
};

/** No network, ever. Anything unrouted 404s so a live URL fails loudly. */
function installFetchStub(routes: Record<string, string>): string[] {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    if (url.endsWith('/robots.txt')) {
      return new Response('User-agent: *\nAllow: /\n', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }
    const body = routes[url] ?? routes[url.replace(/\/$/, '')];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  });
  resetFetchState();
  return calls;
}

function routes(): Record<string, string> {
  return {
    [RICH_URL]: fixture('marketplace-listing.html'),
    [BARREN_URL]: fixture('barren-directory.html'),
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  resetFetchState();
  await teardown();
});

// --- the ceiling ---------------------------------------------------------------

describe('the per-kind trust ceiling', () => {
  it('lets only a marketplace reach the top', () => {
    const ceilings = Object.entries(SOURCE_TRUST_CEILING) as Array<[SourceKind, number]>;
    const best = ceilings.reduce((a, b) => (b[1] > a[1] ? b : a));
    expect(best[0]).toBe('MARKETPLACE');
    expect(SOURCE_TRUST_CEILING.MARKETPLACE).toBe(1);

    const others = ceilings.filter(([kind]) => kind !== 'MARKETPLACE');
    for (const [kind, ceiling] of others) {
      expect(ceiling, `${kind} must not tie or beat MARKETPLACE`).toBeLessThan(
        SOURCE_TRUST_CEILING.MARKETPLACE,
      );
    }
  });

  it('orders kinds by how close they are to primary commercial evidence', () => {
    expect(SOURCE_TRUST_CEILING.MARKETPLACE).toBeGreaterThan(SOURCE_TRUST_CEILING.REVIEW_SITE);
    expect(SOURCE_TRUST_CEILING.REVIEW_SITE).toBeGreaterThan(SOURCE_TRUST_CEILING.MERCHANT_SITE);
    expect(SOURCE_TRUST_CEILING.MERCHANT_SITE).toBeGreaterThan(SOURCE_TRUST_CEILING.SEARCH);
    expect(SOURCE_TRUST_CEILING.SEARCH).toBeGreaterThan(SOURCE_TRUST_CEILING.COMMUNITY);
    expect(SOURCE_TRUST_CEILING.COMMUNITY).toBeGreaterThan(SOURCE_TRUST_CEILING.OTHER);
  });

  it('structurally guarantees a verified marketplace outranks any OTHER source', () => {
    // A source is only VERIFIED at or above the probe threshold, and OTHER is
    // capped below it. So the worst verified MARKETPLACE still beats the best
    // possible OTHER — no tuning, no ordering accident.
    expect(SOURCE_TRUST_CEILING.OTHER).toBeLessThan(MIN_PROBE_SCORE_FOR_VERIFIED);
    expect(SOURCE_TRUST_CEILING.MARKETPLACE).toBeGreaterThanOrEqual(MIN_PROBE_SCORE_FOR_VERIFIED);
  });

  it('clamps a perfect probe down to the kind ceiling', () => {
    expect(cappedTrust('OTHER', 1)).toBe(SOURCE_TRUST_CEILING.OTHER);
    expect(cappedTrust('MARKETPLACE', 1)).toBe(1);
    expect(cappedTrust('COMMUNITY', 0.2)).toBe(0.2);
    expect(cappedTrust('MARKETPLACE', -5)).toBe(0);
  });
});

// --- seeding -------------------------------------------------------------------

describe('seedSources', () => {
  it('registers the code-declared sources and is idempotent', async () => {
    const { db } = await freshDb(BASE_ENV);

    const first = await seedSources();
    const second = await seedSources();

    expect(first.created).toBe(SEED_SOURCES.length);
    expect(second.created).toBe(0);

    const rows = await db.query<{ n: string | number }>('SELECT COUNT(*) AS n FROM source_registry');
    expect(Number(rows.rows[0]?.n)).toBe(SEED_SOURCES.length);
  });

  it('registers the marketplace, the search engine, merchant, review and competitor pages', async () => {
    await freshDb(BASE_ENV);
    await seedSources();

    const sources = await listSources();
    const byName = new Map(sources.map((s) => [s.name, s]));

    expect(byName.get('Shopify App Store')?.kind).toBe('MARKETPLACE');
    expect(byName.get('Shopify App Store')?.structured).toBe(true);
    expect(byName.get('Shopify App Store')?.trustLevel).toBe(1);
    expect(byName.get('Brave Search')?.kind).toBe('SEARCH');
    expect(byName.get('Public merchant websites')?.kind).toBe('MERCHANT_SITE');
    expect(byName.get('Public review pages')?.kind).toBe('REVIEW_SITE');
    expect(byName.get('Public competitor pages')).toBeDefined();
  });

  it('never seeds a source above its kind ceiling', async () => {
    await freshDb(BASE_ENV);
    await seedSources();

    for (const source of await listSources()) {
      expect(source.trustLevel).toBeLessThanOrEqual(SOURCE_TRUST_CEILING[source.kind]);
    }
  });
});

// --- proposing ------------------------------------------------------------------

describe('proposeSource', () => {
  it('registers a discovered candidate as UNVERIFIED and barely trusted', async () => {
    await freshDb(BASE_ENV);

    const { created } = await proposeSource({
      name: 'Example Marketplace',
      kind: 'MARKETPLACE',
      baseUrl: `${RICH_URL}/apps?ref=discovery`,
      ecosystem: 'example',
      reason: 'surfaced by generic ecosystem exploration',
    });

    expect(created).toBe(true);
    const stored = await getSourceByName('Example Marketplace');
    expect(stored?.status).toBe('UNVERIFIED');
    expect(stored?.trustLevel).toBe(UNVERIFIED_TRUST);
    // Even a MARKETPLACE candidate starts below every ceiling in the table.
    expect(stored?.trustLevel).toBeLessThan(SOURCE_TRUST_CEILING.OTHER);
    // Only the origin is kept; a tracking query string is not a source.
    expect(stored?.baseUrl).toBe(RICH_URL);
  });

  it('is idempotent by name', async () => {
    await freshDb(BASE_ENV);
    const first = await proposeSource({
      name: 'Example Marketplace',
      kind: 'MARKETPLACE',
      baseUrl: RICH_URL,
      reason: 'first sighting',
    });
    const second = await proposeSource({
      name: 'Example Marketplace',
      kind: 'MARKETPLACE',
      baseUrl: RICH_URL,
      reason: 'seen again',
    });

    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
  });

  it('refuses a base URL that is not http(s)', async () => {
    await freshDb(BASE_ENV);
    await expect(
      proposeSource({ name: 'Weird', kind: 'OTHER', baseUrl: 'ftp://files.example.com', reason: 'x' }),
    ).rejects.toThrow(/SOURCE_INVALID|http/i);
    await expect(
      proposeSource({ name: 'Weird', kind: 'OTHER', baseUrl: 'not a url', reason: 'x' }),
    ).rejects.toThrow();
  });
});

// --- evaluating --------------------------------------------------------------------

describe('evaluateSource', () => {
  it('promotes a real commercial page from UNVERIFIED to VERIFIED', async () => {
    await freshDb(BASE_ENV);
    installFetchStub(routes());

    const { id } = await proposeSource({
      name: 'Example Marketplace',
      kind: 'MARKETPLACE',
      baseUrl: RICH_URL,
      reason: 'probe me',
    });
    expect((await getSourceByName('Example Marketplace'))?.status).toBe('UNVERIFIED');

    const verdict = await evaluateSource(id);

    expect(verdict.status).toBe('VERIFIED');
    expect(verdict.trustLevel).toBeGreaterThanOrEqual(MIN_PROBE_SCORE_FOR_VERIFIED);
    expect(verdict.notes).toMatch(/pricing markers/);
    expect((await getSourceByName('Example Marketplace'))?.status).toBe('VERIFIED');
  });

  it('rejects a page carrying no commercial evidence', async () => {
    await freshDb(BASE_ENV);
    installFetchStub(routes());

    const { id } = await proposeSource({
      name: 'Volunteer link list',
      kind: 'COMMUNITY',
      baseUrl: BARREN_URL,
      reason: 'looked plausible in search results',
    });
    const verdict = await evaluateSource(id);

    expect(verdict.status).toBe('REJECTED');
    expect(verdict.trustLevel).toBe(0);
  });

  it('rejects a source it cannot reach', async () => {
    await freshDb(BASE_ENV);
    installFetchStub(routes());

    const { id } = await proposeSource({
      name: 'Vanished directory',
      kind: 'REVIEW_SITE',
      baseUrl: MISSING_URL,
      reason: 'a link that used to work',
    });
    const verdict = await evaluateSource(id);

    expect(verdict.status).toBe('REJECTED');
    expect(verdict.trustLevel).toBe(0);
    expect(verdict.notes).toMatch(/not accessible/i);
  });

  it('caps an OTHER source below a MARKETPLACE source reading the same page', async () => {
    await freshDb(BASE_ENV);
    installFetchStub(routes());

    const marketplace = await proposeSource({
      name: 'Primary marketplace',
      kind: 'MARKETPLACE',
      baseUrl: RICH_URL,
      reason: 'primary evidence',
    });
    const scraped = await proposeSource({
      name: 'SEO listicle mirroring the marketplace',
      kind: 'OTHER',
      baseUrl: RICH_URL,
      reason: 'identical bytes, no standing',
    });

    const marketplaceVerdict = await evaluateSource(marketplace.id);
    // Evaluated second, so it even probes as MORE stable (content unchanged).
    const scrapedVerdict = await evaluateSource(scraped.id);

    expect(scrapedVerdict.status).toBe('VERIFIED');
    expect(scrapedVerdict.trustLevel).toBe(SOURCE_TRUST_CEILING.OTHER);
    expect(scrapedVerdict.trustLevel).toBeLessThan(marketplaceVerdict.trustLevel);

    const ordered = await listSources();
    expect(ordered[0]?.name).toBe('Primary marketplace');
  });

  it('never demotes a class-of-sites source it cannot probe', async () => {
    await freshDb(BASE_ENV);
    installFetchStub(routes());
    await seedSources();

    const before = await getSourceByName('Public merchant websites');
    expect(before?.baseUrl).toBeNull();

    const verdict = await evaluateSource(before?.id ?? '');

    expect(verdict.status).toBe('VERIFIED');
    expect(verdict.trustLevel).toBe(SOURCE_TRUST_CEILING.MERCHANT_SITE);
    expect(verdict.notes).toMatch(/no single address to probe/);
  });

  it('throws for a source that does not exist', async () => {
    await freshDb(BASE_ENV);
    await expect(evaluateSource('src_nope')).rejects.toThrow(/SOURCE_NOT_FOUND|no source/);
  });
});

// --- the probe score, in isolation ------------------------------------------------

describe('scoreProbe', () => {
  const probe = (over: Partial<SourceProbe> = {}): SourceProbe => ({
    accessible: true,
    httpStatus: 200,
    textChars: 3000,
    contentChanged: false,
    pricingMarkers: 8,
    reviewMarkers: 6,
    vendorMarkers: 5,
    costPerCall: 0,
    provenValue: 0,
    error: null,
    ...over,
  });

  it('scores an unreachable source at zero', () => {
    expect(scoreProbe(probe({ accessible: false, error: 'HTTP 404' })).score).toBe(0);
  });

  it('rewards commercial evidence above everything else', () => {
    const rich = scoreProbe(probe()).score;
    const empty = scoreProbe(probe({ pricingMarkers: 0, reviewMarkers: 0, vendorMarkers: 0 })).score;
    expect(rich - empty).toBeCloseTo(0.4, 5);
  });

  it('penalizes an expensive source', () => {
    const free = scoreProbe(probe({ costPerCall: 0 })).score;
    const dear = scoreProbe(probe({ costPerCall: MAX_ACCEPTABLE_COST_PER_CALL_USD })).score;
    expect(dear).toBeLessThan(free);
  });

  it('is deterministic', () => {
    expect(scoreProbe(probe()).score).toBe(scoreProbe(probe()).score);
  });
});

// --- performance ---------------------------------------------------------------------

describe('recordSourceOutcome', () => {
  it('accumulates counters and recomputes a deterministic yield score', async () => {
    const { db } = await freshDb(BASE_ENV);
    await seedSources();
    const marketplace = await getSourceByName('Shopify App Store');
    const id = marketplace?.id ?? '';

    await recordSourceOutcome({ sourceId: id, fetches: 10, candidatesFound: 6, categoriesVerified: 2, spendUsd: 0.5 });
    await recordSourceOutcome({ sourceId: id, fetches: 10, failures: 1, commitments: 1, spendUsd: 0.5 });

    const rows = await db.query<{
      fetches: number;
      failures: number;
      categories_verified: number;
      commitments: number;
      spend_usd: string;
      yield_score: string;
    }>('SELECT fetches, failures, categories_verified, commitments, spend_usd, yield_score FROM source_performance WHERE source_id = $1', [id]);

    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.fetches).toBe(20);
    expect(rows.rows[0]?.failures).toBe(1);
    expect(rows.rows[0]?.categories_verified).toBe(2);
    expect(rows.rows[0]?.commitments).toBe(1);
    expect(Number(rows.rows[0]?.spend_usd)).toBeCloseTo(1, 6);

    const expected = computeYieldScore({
      fetches: 20,
      failures: 1,
      candidatesFound: 6,
      categoriesVerified: 2,
      commitments: 1,
      spendUsd: 1,
    });
    expect(Number(rows.rows[0]?.yield_score)).toBeCloseTo(expected, 5);
    expect(await sourceYield(id)).toBeCloseTo(expected, 5);
  });

  it('ignores an outcome for a source that is not registered', async () => {
    const { db } = await freshDb(BASE_ENV);
    await recordSourceOutcome({ sourceId: 'src_nope', fetches: 1 });
    const rows = await db.query<{ n: string | number }>('SELECT COUNT(*) AS n FROM source_performance');
    expect(Number(rows.rows[0]?.n)).toBe(0);
  });
});

describe('computeYieldScore', () => {
  const base = {
    fetches: 0,
    failures: 0,
    candidatesFound: 0,
    categoriesVerified: 0,
    commitments: 0,
    spendUsd: 0,
  };

  it('measures verified categories and commitments per dollar', () => {
    expect(computeYieldScore({ ...base, categoriesVerified: 2, spendUsd: 1 })).toBe(
      YIELD_WEIGHTS.categoryVerified * 2,
    );
    expect(computeYieldScore({ ...base, commitments: 2, spendUsd: 1 })).toBe(
      YIELD_WEIGHTS.commitment * 2,
    );
  });

  it('values a commitment above a verified category', () => {
    expect(YIELD_WEIGHTS.commitment).toBeGreaterThan(YIELD_WEIGHTS.categoryVerified);
  });

  it('falls as the same result costs more', () => {
    const cheap = computeYieldScore({ ...base, categoriesVerified: 3, spendUsd: 1 });
    const dear = computeYieldScore({ ...base, categoriesVerified: 3, spendUsd: 10 });
    expect(dear).toBeLessThan(cheap);
  });

  it('does not treat a free source as infinitely productive', () => {
    const free = computeYieldScore({ ...base, categoriesVerified: 1, spendUsd: 0 });
    expect(Number.isFinite(free)).toBe(true);
    expect(free).toBe(YIELD_WEIGHTS.categoryVerified / MIN_COST_BASIS_USD);
  });

  it('discounts a source that keeps failing', () => {
    const reliable = computeYieldScore({ ...base, fetches: 10, categoriesVerified: 2, spendUsd: 1 });
    const flaky = computeYieldScore({
      ...base,
      fetches: 10,
      failures: 5,
      categoriesVerified: 2,
      spendUsd: 1,
    });
    expect(flaky).toBeCloseTo(reliable / 2, 5);
  });

  it('produces nothing for a source that produced nothing', () => {
    expect(computeYieldScore({ ...base, candidatesFound: 50, spendUsd: 2 })).toBe(0);
  });
});
