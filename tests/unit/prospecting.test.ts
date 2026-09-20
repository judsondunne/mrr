import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { freshDb, teardown, insertOpportunity } from '../helpers.js';
import { resetFetchState } from '../../src/lib/fetch.js';
import { newId } from '../../src/lib/hash.js';
import type { Db } from '../../src/lib/db.js';
import type { Wedge } from '../../src/lib/contracts.js';
import {
  normalizeDomain,
  registrableDomain,
  isDisallowedProspectDomain,
  domainToCompanyName,
} from '../../src/pipeline/prospecting/domain.js';
import {
  classifyEmail,
  detectCountry,
  extractEmailCandidates,
  findPublicContact,
  looksLikePerson,
} from '../../src/pipeline/prospecting/contact.js';
import {
  buildIcpSignals,
  deterministicIcpCheck,
  qualifyProspect,
} from '../../src/pipeline/prospecting/qualify.js';
import { buildProspectQueries, discoverProspectsFor } from '../../src/pipeline/prospecting/discover.js';
import {
  discoverProspects,
  qualifyProspects,
  getProspectCounts,
  rejectionReasonForProspectability,
} from '../../src/pipeline/prospecting/index.js';

afterEach(async () => {
  vi.unstubAllGlobals();
  resetFetchState();
  // These switches are not in the shared reset list; clearing them keeps this
  // file's fetch/threshold settings from silently changing another file's test.
  for (const key of Object.keys(ENV)) delete process.env[key];
  await teardown();
});

const ENV: Record<string, string> = {
  MIN_QUALIFIED_PROSPECTS: '3',
  PREFERRED_QUALIFIED_PROSPECTS: '5',
  RESPECT_ROBOTS_TXT: 'false',
  FETCH_MIN_DELAY_MS: '0',
  FETCH_MAX_RETRIES: '0',
  MONTHLY_LLM_BUDGET_USD: '20',
  MONTHLY_SEARCH_BUDGET_USD: '5',
};

const WEDGE: Wedge = {
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
  ],
  excludedFromV1: ['Net-30 invoicing', 'Quote requests'],
  proposedPriceMonthly: 29,
  estimatedBuildDays: 5,
  primaryCompetitor: 'Wholesale Gorilla',
  reasonSomeoneWouldSwitch: 'They only need order minimums and will not pay $99/mo for a whole wholesale suite.',
  oneSentenceOutcome: 'Stockists can only place orders that are profitable to pack and ship.',
  capabilities: ['Minimum order value per customer tag', 'Case-pack rounding', 'Clear checkout messaging'],
  whoItIsFor: 'Shopify merchants with a wholesale customer tag and case-pack only products',
};

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/merchants/${name}`, import.meta.url)), 'utf8');
}

const NORTHFIELD = fixture('northfield-wholesale.html');
const HARBORVIEW = fixture('harborview-contact.html');
const CEDAR_LANE = fixture('cedar-lane-trade.html');
const DRIFTWOOD = fixture('driftwood-form-only.html');
const MILLBROOK = fixture('millbrook-personal-email.html');
const APP_VENDOR = fixture('appvendor-not-icp.html');

/** Serves fixtures for known URLs and 404s everything else. No network. */
function stubFetch(routes: Record<string, string>): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: unknown): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : String((input as { url?: string }).url ?? '');
    calls.push(url);
    const body = routes[url] ?? routes[url.replace(/\/$/, '')];
    if (body === undefined) {
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
    }
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  });
  return { calls };
}

const REACHABLE_ROUTES: Record<string, string> = {
  'https://northfieldsupply.com/pages/wholesale': NORTHFIELD,
  'https://northfieldsupply.com/': NORTHFIELD,
  'https://northfieldsupply.com/pages/contact': NORTHFIELD,
  'https://harborviewgoods.com/pages/contact': HARBORVIEW,
  'https://harborviewgoods.com/': HARBORVIEW,
  'https://cedarlaneprovisions.com/pages/stockists': CEDAR_LANE,
  'https://cedarlaneprovisions.com/': CEDAR_LANE,
};

const REACHABLE_RESULTS = [
  {
    title: 'Wholesale & Trade Accounts | Northfield Supply Co',
    url: 'https://northfieldsupply.com/pages/wholesale',
    description: 'Case-pack wholesale for retail stockists.',
  },
  {
    title: 'Harborview Goods — Wholesale enquiries',
    url: 'https://harborviewgoods.com/pages/contact',
    description: 'Trade accounts and case-pack minimums.',
  },
  {
    title: 'Cedar Lane Provisions | Stockists',
    url: 'https://cedarlaneprovisions.com/pages/stockists',
    description: 'Become a stockist.',
  },
];

const UNREACHABLE_ROUTES: Record<string, string> = {
  'https://driftwoodgoods.com/pages/wholesale': DRIFTWOOD,
  'https://driftwoodgoods.com/': DRIFTWOOD,
  'https://millbrookceramics.com/pages/wholesale': MILLBROOK,
  'https://millbrookceramics.com/': MILLBROOK,
};

const UNREACHABLE_RESULTS = [
  {
    title: 'Driftwood Goods — Wholesale',
    url: 'https://driftwoodgoods.com/pages/wholesale',
    description: 'Wholesale and stockist enquiries.',
  },
  {
    title: 'Millbrook Ceramics — Wholesale',
    url: 'https://millbrookceramics.com/pages/wholesale',
    description: 'Wholesale and stockist orders.',
  },
];

async function seedOpportunityWithWedge(db: Db, state: string): Promise<string> {
  const id = await insertOpportunity(db, { state });
  await db.query(
    `UPDATE opportunities
        SET wedge_json = $1, proposed_wedge = $2, target_customer = $3,
            proposed_price_monthly = $4, estimated_build_days = $5
      WHERE id = $6`,
    [
      JSON.stringify(WEDGE),
      WEDGE.statement,
      WEDGE.targetCustomer,
      WEDGE.proposedPriceMonthly,
      WEDGE.estimatedBuildDays,
      id,
    ],
  );
  return id;
}

describe('domain normalization (the unique company key)', () => {
  it('collapses www, case, subdomain and path variants onto one key', () => {
    const variants = [
      'https://www.Example.com/wholesale?utm=1',
      'http://example.com',
      'EXAMPLE.COM',
      'https://shop.example.com/pages/trade',
      'www.example.com.',
      'example.com/',
    ];
    const keys = new Set(variants.map((v) => normalizeDomain(v)));
    expect([...keys]).toEqual(['example.com']);
  });

  it('keeps multi-label public suffixes intact', () => {
    expect(normalizeDomain('https://shop.harborview.co.uk/trade')).toBe('harborview.co.uk');
    expect(normalizeDomain('https://www.cedar.com.au')).toBe('cedar.com.au');
    expect(registrableDomain('a.b.c.example.org')).toBe('example.org');
  });

  it('treats each tenant of a multi-tenant host as its own company', () => {
    expect(normalizeDomain('https://northfield.myshopify.com/pages/wholesale')).toBe(
      'northfield.myshopify.com',
    );
    expect(normalizeDomain('https://acme.myshopify.com')).not.toBe(
      normalizeDomain('https://northfield.myshopify.com'),
    );
  });

  it('returns null for things that are not company web domains', () => {
    expect(normalizeDomain('')).toBeNull();
    expect(normalizeDomain('not a domain')).toBeNull();
    expect(normalizeDomain('https://192.168.0.10/admin')).toBeNull();
    expect(normalizeDomain('mailto:hello@example.com')).toBeNull();
  });

  it('refuses marketplaces, social networks and public-sector domains as prospects', () => {
    expect(isDisallowedProspectDomain('shopify.com')).toBe(true);
    expect(isDisallowedProspectDomain('facebook.com')).toBe(true);
    expect(isDisallowedProspectDomain('trustpilot.com')).toBe(true);
    expect(isDisallowedProspectDomain('city.gov')).toBe(true);
    expect(isDisallowedProspectDomain('northfieldsupply.com')).toBe(false);
  });

  it('derives a readable fallback company name', () => {
    expect(domainToCompanyName('northfield-supply.com')).toBe('Northfield Supply');
  });
});

describe('public contact extraction', () => {
  it('finds a published role address and remembers where it came from', async () => {
    await freshDb(ENV);
    stubFetch(REACHABLE_ROUTES);

    const finding = await findPublicContact({
      domain: 'harborviewgoods.com',
      seedUrls: ['https://harborviewgoods.com/pages/contact'],
    });

    expect(finding).not.toBeNull();
    expect(finding?.email).toBe('support@harborviewgoods.com');
    expect(finding?.isRole).toBe(true);
    expect(finding?.sourceUrl).toBe('https://harborviewgoods.com/pages/contact');
    expect(finding?.country).toBe('US');
  });

  it('refuses to invent an address when the page publishes none', async () => {
    await freshDb(ENV);
    stubFetch(UNREACHABLE_ROUTES);

    const finding = await findPublicContact({
      domain: 'driftwoodgoods.com',
      seedUrls: ['https://driftwoodgoods.com/pages/wholesale'],
    });

    // The page deliberately writes "orders [at] driftwoodgoods [dot] com".
    // We do not decode obfuscation and we never construct an address.
    expect(finding).toBeNull();
  });

  it('refuses a personal free-mail address', async () => {
    await freshDb(ENV);
    stubFetch(UNREACHABLE_ROUTES);

    const finding = await findPublicContact({
      domain: 'millbrookceramics.com',
      seedUrls: ['https://millbrookceramics.com/pages/wholesale'],
    });
    expect(finding).toBeNull();
  });

  it('extracts every published address on a page and ranks role accounts first', () => {
    const candidates = extractEmailCandidates(
      HARBORVIEW,
      'https://harborviewgoods.com/pages/contact',
      'harborviewgoods.com',
    );
    expect(candidates.map((c) => c.email)).toEqual([
      'support@harborviewgoods.com',
      'wholesale@harborviewgoods.com',
    ]);
    expect(candidates[0]?.viaMailto).toBe(true);
    expect(candidates[0]?.sameDomain).toBe(true);
  });

  it('judges addresses without ever generating one', () => {
    expect(classifyEmail('hello@northfieldsupply.com', 'northfieldsupply.com').ok).toBe(true);
    expect(classifyEmail('orders@cedarlaneprovisions.com', 'cedarlaneprovisions.com').ok).toBe(true);
    expect(classifyEmail('jane.doe@northfieldsupply.com', 'northfieldsupply.com').ok).toBe(false);
    expect(classifyEmail('john.smith@gmail.com', 'millbrookceramics.com').ok).toBe(false);
    expect(classifyEmail('sarah@gmail.com', 'millbrookceramics.com').ok).toBe(false);
    expect(classifyEmail('hello@gmail.com', 'millbrookceramics.com').ok).toBe(true);
    expect(classifyEmail('noreply@northfieldsupply.com', 'northfieldsupply.com').ok).toBe(false);
    expect(classifyEmail('info@example.com', 'example.com').ok).toBe(false);
    expect(classifyEmail('logo@2x.png', 'northfieldsupply.com').ok).toBe(false);
    expect(classifyEmail('not-an-address', 'northfieldsupply.com').ok).toBe(false);
    expect(classifyEmail('hello@someoneelse.com', 'northfieldsupply.com').ok).toBe(false);
  });

  it('recognises a named individual', () => {
    expect(looksLikePerson('jane.doe')).toBe(true);
    expect(looksLikePerson('j.smith')).toBe(true);
    expect(looksLikePerson('sarah')).toBe(true);
    expect(looksLikePerson('wholesale.orders')).toBe(false);
    expect(looksLikePerson('hello')).toBe(false);
  });

  it('only reports a country when it is publicly evident', () => {
    expect(detectCountry('1820 NW Quimby St, Portland, OR 97209', 'northfieldsupply.com')).toBe('US');
    expect(detectCountry('anything at all', 'harborview.co.uk')).toBe('GB');
    expect(detectCountry('call us on +61 2 5550 1234', 'example.com')).toBe('AU');
    expect(detectCountry('we ship worldwide', 'example.com')).toBeNull();
  });
});

describe('ICP qualification', () => {
  it('qualifies a real wholesale page deterministically', () => {
    const signals = buildIcpSignals(WEDGE, 'shopify');
    const verdict = deterministicIcpCheck(NORTHFIELD, signals);
    expect(verdict.decision).toBe('FIT');
    expect(verdict.score).toBeGreaterThan(0);
  });

  it('rejects a vendor that sells to the ICP rather than being it', () => {
    const signals = buildIcpSignals(WEDGE, 'shopify');
    const verdict = deterministicIcpCheck(APP_VENDOR, signals);
    expect(verdict.decision).toBe('NOT_FIT');
    expect(verdict.reason).toContain('sells to merchants');
  });

  it('never qualifies from a search snippet when the site cannot be fetched', async () => {
    const ctx = await freshDb(ENV);
    const oppId = await seedOpportunityWithWedge(ctx.db, 'PROSPECTING');
    stubFetch({});

    const prospectId = newId('pr');
    await ctx.db.query(
      `INSERT INTO prospects (id, opportunity_id, company_name, domain, ecosystem, public_evidence_url, status)
       VALUES ($1,$2,'Ghost Goods','ghostgoods.com','shopify','https://ghostgoods.com/pages/wholesale','DISCOVERED')`,
      [prospectId, oppId],
    );

    const outcome = await qualifyProspect({
      prospect: {
        id: prospectId,
        domain: 'ghostgoods.com',
        company_name: 'Ghost Goods',
        public_evidence_url: 'https://ghostgoods.com/pages/wholesale',
      },
      wedge: WEDGE,
      ecosystem: 'shopify',
    });

    expect(outcome.status).toBe('DISQUALIFIED');
    expect(outcome.icpFit).toBe(false);
    expect(outcome.reason).toContain('refusing to qualify from a search snippet');
    expect(ctx.llm.calls).toHaveLength(0);
  });

  it('records evidence, reason, score and the public contact source', async () => {
    const ctx = await freshDb(ENV);
    const oppId = await seedOpportunityWithWedge(ctx.db, 'PROSPECTING');
    stubFetch(REACHABLE_ROUTES);

    const prospectId = newId('pr');
    await ctx.db.query(
      `INSERT INTO prospects (id, opportunity_id, company_name, domain, ecosystem, public_evidence_url, status)
       VALUES ($1,$2,'Northfield Supply Co','northfieldsupply.com','shopify','https://northfieldsupply.com/pages/wholesale','DISCOVERED')`,
      [prospectId, oppId],
    );

    const outcome = await qualifyProspect({
      prospect: {
        id: prospectId,
        domain: 'northfieldsupply.com',
        company_name: 'Northfield Supply Co',
        public_evidence_url: 'https://northfieldsupply.com/pages/wholesale',
      },
      wedge: WEDGE,
      ecosystem: 'shopify',
    });

    expect(outcome.status).toBe('QUALIFIED');
    expect(outcome.contactEmail).toBe('hello@northfieldsupply.com');
    expect(outcome.usedLlm).toBe(false);

    const row = await ctx.db.query<{
      status: string;
      qualification_reason: string;
      qualification_score: string;
      public_evidence_url: string;
      contact_email: string;
      contact_source_url: string;
      email_is_public: boolean;
      country: string;
      contact_name_if_public: string | null;
    }>('SELECT * FROM prospects WHERE id = $1', [prospectId]);
    const stored = row.rows[0];
    expect(stored?.status).toBe('QUALIFIED');
    expect(stored?.contact_email).toBe('hello@northfieldsupply.com');
    expect(stored?.contact_source_url).toBe('https://northfieldsupply.com/pages/wholesale');
    expect(stored?.email_is_public).toBe(true);
    expect(stored?.country).toBe('US');
    expect(stored?.public_evidence_url).toBe('https://northfieldsupply.com/pages/wholesale');
    expect(Number(stored?.qualification_score)).toBeGreaterThan(0);
    expect(stored?.qualification_reason).toContain('public role address published at');
    // We never infer a person's name from a page.
    expect(stored?.contact_name_if_public).toBeNull();
  });
});

describe('prospect discovery', () => {
  it('builds targeted, deterministic queries from the wedge', () => {
    const queries = buildProspectQueries(WEDGE, { ecosystem: 'shopify', category: 'minimum-order-rules' });
    expect(queries.length).toBeGreaterThan(5);
    expect(queries.map((q) => q.query)).toEqual(
      buildProspectQueries(WEDGE, { ecosystem: 'shopify', category: 'minimum-order-rules' }).map((q) => q.query),
    );
    expect(queries.some((q) => q.query.includes('"wholesale" "minimum order"'))).toBe(true);
    expect(queries.some((q) => q.query.includes('"powered by shopify"'))).toBe(true);
    expect(queries.some((q) => q.query.includes('Wholesale Gorilla'))).toBe(true);
  });

  it('deduplicates: the same domain discovered twice yields one prospect row', async () => {
    const ctx = await freshDb(ENV);
    const oppId = await seedOpportunityWithWedge(ctx.db, 'PROSPECTING');
    stubFetch(REACHABLE_ROUTES);
    ctx.search.register('wholesale', [
      ...REACHABLE_RESULTS,
      // Same company, different spelling of the URL.
      {
        title: 'Northfield Supply Co',
        url: 'https://WWW.northfieldsupply.com/pages/contact?utm_source=x',
        description: 'duplicate',
      },
    ]);

    const first = await discoverProspectsFor({
      opportunityId: oppId,
      wedge: WEDGE,
      ecosystem: 'shopify',
      category: 'minimum-order-rules',
    });
    expect(first.inserted).toBe(3);

    const second = await discoverProspectsFor({
      opportunityId: oppId,
      wedge: WEDGE,
      ecosystem: 'shopify',
      category: 'minimum-order-rules',
    });
    expect(second.inserted).toBe(0);

    const rows = await ctx.db.query<{ domain: string; company_name: string; public_evidence_url: string }>(
      'SELECT domain, company_name, public_evidence_url FROM prospects WHERE opportunity_id = $1 ORDER BY domain',
      [oppId],
    );
    expect(rows.rows.map((r) => r.domain)).toEqual([
      'cedarlaneprovisions.com',
      'harborviewgoods.com',
      'northfieldsupply.com',
    ]);
    // Company name came from the fetched page, not the search snippet.
    expect(rows.rows[2]?.company_name).toBe('Northfield Supply Co');
  });

  it('skips marketplaces and directories found in the results', async () => {
    const ctx = await freshDb(ENV);
    const oppId = await seedOpportunityWithWedge(ctx.db, 'PROSPECTING');
    stubFetch(REACHABLE_ROUTES);
    ctx.search.register('wholesale', [
      { title: 'Shopify App Store', url: 'https://apps.shopify.com/minimum-order', description: 'app' },
      { title: 'Reddit thread', url: 'https://www.reddit.com/r/shopify/comments/abc', description: 'thread' },
      ...REACHABLE_RESULTS,
    ]);

    const outcome = await discoverProspectsFor({
      opportunityId: oppId,
      wedge: WEDGE,
      ecosystem: 'shopify',
      category: 'minimum-order-rules',
    });
    expect(outcome.inserted).toBe(3);
    expect(outcome.skipped).toBeGreaterThanOrEqual(2);
  });
});

describe('prospectability decision', () => {
  it('names the right rejection reason', () => {
    expect(rejectionReasonForProspectability({ total: 0, pending: 0, qualifiedReachable: 0, icpFit: 0 }, 3)).toBe(
      'ICP_DISCOVERY_FAILED',
    );
    expect(rejectionReasonForProspectability({ total: 9, pending: 0, qualifiedReachable: 1, icpFit: 9 }, 3)).toBe(
      'PROSPECTS_NOT_REACHABLE',
    );
    expect(rejectionReasonForProspectability({ total: 9, pending: 0, qualifiedReachable: 1, icpFit: 2 }, 3)).toBe(
      'INSUFFICIENT_PROSPECTS',
    );
  });

  it('reaches CAMPAIGN_READY when enough prospects are qualified and reachable', async () => {
    const ctx = await freshDb(ENV);
    const oppId = await seedOpportunityWithWedge(ctx.db, 'WEDGE_GENERATED');
    stubFetch(REACHABLE_ROUTES);
    ctx.search.register('wholesale', REACHABLE_RESULTS);

    const discovered = await discoverProspects(5);
    expect(discovered[0]?.discovered).toBe(3);

    const midState = await ctx.db.query<{ state: string }>('SELECT state FROM opportunities WHERE id = $1', [oppId]);
    expect(midState.rows[0]?.state).toBe('PROSPECTING');

    const qualified = await qualifyProspects(5);
    expect(qualified[0]?.qualified).toBe(3);
    expect(qualified[0]?.rejected).toBe(false);

    const row = await ctx.db.query<{ state: string; prospectability_score: string }>(
      'SELECT state, prospectability_score FROM opportunities WHERE id = $1',
      [oppId],
    );
    expect(row.rows[0]?.state).toBe('CAMPAIGN_READY');
    expect(Number(row.rows[0]?.prospectability_score)).toBeGreaterThan(0);

    const counts = await getProspectCounts(oppId);
    expect(counts.qualifiedReachable).toBe(3);
    expect(counts.pending).toBe(0);

    // Re-running is safe: the opportunity has left PROSPECTING.
    const again = await qualifyProspects(5);
    expect(again).toHaveLength(0);
  });

  it('kills the opportunity when the customers cannot be reached', async () => {
    const ctx = await freshDb({ ...ENV, MIN_QUALIFIED_PROSPECTS: '2', PREFERRED_QUALIFIED_PROSPECTS: '4' });
    const oppId = await seedOpportunityWithWedge(ctx.db, 'WEDGE_GENERATED');
    stubFetch(UNREACHABLE_ROUTES);
    ctx.search.register('wholesale', UNREACHABLE_RESULTS);

    await discoverProspects(5);
    const firstPass = await qualifyProspects(5);
    // Discovery was still productive, so we do not give up yet.
    expect(firstPass[0]?.rejected).toBe(false);

    await discoverProspects(5);
    const secondPass = await qualifyProspects(5);
    expect(secondPass[0]?.rejected).toBe(true);
    expect(secondPass[0]?.rejectionDetail).toContain('PROSPECTS_NOT_REACHABLE');

    const row = await ctx.db.query<{ state: string; rejection_reason: string }>(
      'SELECT state, rejection_reason FROM opportunities WHERE id = $1',
      [oppId],
    );
    expect(row.rows[0]?.state).toBe('PROSPECTABILITY_REJECTED');
    expect(row.rows[0]?.rejection_reason).toBe('PROSPECTS_NOT_REACHABLE');

    const counts = await getProspectCounts(oppId);
    expect(counts.icpFit).toBe(2);
    expect(counts.qualifiedReachable).toBe(0);
  });

  it('does nothing for an opportunity with no wedge recorded', async () => {
    const ctx = await freshDb(ENV);
    const oppId = await insertOpportunity(ctx.db, { state: 'WEDGE_GENERATED' });
    stubFetch({});

    const results = await discoverProspects(5);
    expect(results[0]?.opportunityId).toBe(oppId);
    expect(results[0]?.rejectionDetail).toContain('no wedge recorded');

    const row = await ctx.db.query<{ state: string }>('SELECT state FROM opportunities WHERE id = $1', [oppId]);
    expect(row.rows[0]?.state).toBe('WEDGE_GENERATED');
  });
});
