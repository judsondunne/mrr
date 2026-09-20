/**
 * Web layer integration tests.
 *
 * Everything runs against a real PGlite database from `freshDb()`. Nothing
 * touches the network: the pipeline layers are `declare`-only stubs today, so
 * `@/app/_lib/pipeline` (the single place the web layer talks to them) is
 * mocked and the mock asserts on exactly what the route passed through.
 *
 * NOTE ON COVERAGE: these tests never import a `.tsx` module. The committed
 * tsconfig sets `"jsx": "preserve"`, which makes Vite refuse to parse any TSX
 * file ("make sure to not set jsx to preserve"), so component and page modules
 * cannot be imported here. Every page therefore delegates its logic to a `.ts`
 * module — `loadLandingView`, `buildSettingsStatus`, `runSetupCheck`,
 * `requireAdminPage`/`isAdminTokenValid` — and those are what is tested.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshDb, insertOpportunity, insertProspect, teardown } from '../helpers';
import type { Db } from '../../src/lib/db';

const pipelineMock = vi.hoisted(() => ({
  processUnsubscribe: vi.fn(),
  handleDeliveryWebhook: vi.fn(),
  handleInboundWebhook: vi.fn(),
  evaluateGate: vi.fn(),
}));

vi.mock('@/app/_lib/pipeline', () => pipelineMock);

/**
 * The job registry is real, but running a job would execute the whole pipeline.
 * The cron route's contract is "authenticate, then dispatch by name", so the
 * dispatch is stubbed and JOB_NAMES is kept exactly as the registry defines it.
 */
const registryMock = vi.hoisted(() => ({
  JOB_NAMES: [
    'discover_opportunities',
    'verify_categories',
    'generate_wedges',
    'discover_prospects',
    'qualify_prospects',
    'prepare_campaigns',
    'send_due_messages',
    'schedule_followups',
    'evaluate_campaigns',
    'cleanup_stale_opportunities',
    'recalculate_costs',
    'notify_validated_opportunities',
  ] as const,
  runJob: vi.fn(),
}));

vi.mock('@/jobs/registry', () => registryMock);

import { newId } from '@/lib/hash';
import { resetConfigCache } from '@/lib/config';
import { normalizeDomain } from '@/app/_lib/domain';
import { resetRateLimits } from '@/app/_lib/ratelimit';
import {
  VALIDATION_DISCLOSURE,
  ctaLabelFor,
  loadLandingView,
  priceCheckboxLabelFor,
  recordLandingVisit,
} from '@/app/_lib/landing';
import { buildSettingsStatus } from '@/app/_lib/settings-status';
import { runSetupChecks } from '@/lib/setup-check';
import { outreachBlocked, outreachBlockedReason, overallVerdict } from '@/app/_lib/setup-view';
import {
  ADMIN_COOKIE,
  isAdminTokenValid,
  isAuthorizedRequest,
  readPresentedToken,
  safeNextPath,
} from '@/app/admin/auth';
import { POST as pilotPost } from '@/app/api/pilot/route';
import { GET as healthGet } from '@/app/api/health/route';
import { GET as setupCheckGet } from '@/app/api/setup-check/route';
import { POST as adminLoginPost } from '@/app/api/admin/login/route';
import { GET as cronGet, POST as cronPost } from '@/app/api/cron/route';
import {
  GET as unsubscribeGet,
  POST as unsubscribePost,
} from '@/app/api/unsubscribe/route';
import { POST as deliveryWebhookPost } from '@/app/api/webhooks/resend/route';
import { POST as inboundWebhookPost } from '@/app/api/webhooks/resend-inbound/route';

// --- fixtures ---------------------------------------------------------------

const ADMIN_TOKEN = 'admin_token_0123456789abcdef0123456789abcdef';
const CRON_SECRET = 'cron_secret_0123456789abcdef0123456789abcd';

/** Deliberately distinctive so an accidental leak is unmistakable in a diff. */
const PLANTED_RESEND_KEY = 're_PLANTEDFAKEKEY_must_never_be_rendered_01234567';
const PLANTED_ANTHROPIC_KEY = 'sk-ant-PLANTEDFAKEKEY_must_never_be_rendered_0123';
const PLANTED_DB_URL = 'postgres://user:PLANTEDFAKEPASSWORD@db.example.com:5432/postgres';

const ENV_KEYS = [
  'ADMIN_TOKEN',
  'CRON_SECRET',
  'UNSUBSCRIBE_SECRET',
  'RESEND_API_KEY',
  'RESEND_WEBHOOK_SECRET',
  'RESEND_INBOUND_WEBHOOK_SECRET',
  'ANTHROPIC_API_KEY',
  'BRAVE_SEARCH_API_KEY',
  'DATABASE_URL',
  'PUBLIC_BASE_URL',
  'SENDER_EMAIL',
  'SENDER_COMPANY',
  'SENDER_POSTAL_ADDRESS',
  'SENDING_DOMAIN',
  'OWNER_NOTIFICATION_EMAIL',
  'STRIPE_SECRET_KEY',
  'STRIPE_PUBLISHABLE_KEY',
  'LLM_PROVIDER',
  'SEARCH_PROVIDER',
  'EMAIL_PROVIDER',
];

interface Seeded {
  opportunityId: string;
  campaignId: string;
  slug: string;
}

async function seedCampaign(
  db: Db,
  opts: { price?: number; copy?: Record<string, unknown> } = {},
): Promise<Seeded> {
  const opportunityId = await insertOpportunity(db, { state: 'VALIDATING' });
  const campaignId = newId('cmp');
  const slug = `pilot-${campaignId}`;
  await db.query(
    `INSERT INTO campaigns
       (id, opportunity_id, state, offer_name, price_monthly, landing_slug,
        landing_copy_json, target_count, started_at)
     VALUES ($1,$2,'BATCH_1','Minimum Order Rules',$3,$4,$5,150, now())`,
    [campaignId, opportunityId, opts.price ?? 29, slug, JSON.stringify(opts.copy ?? {})],
  );
  return { opportunityId, campaignId, slug };
}

function jsonRequest(url: string, body: unknown, ip = '203.0.113.7'): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

async function commitmentsFor(db: Db, campaignId: string) {
  const { rows } = await db.query<{
    type: string;
    company_key: string;
    price_monthly: string | number;
    source: string;
    verified: boolean;
    evidence_text: string;
    evidence_url: string | null;
    prospect_id: string | null;
    dedupe_key: string;
  }>(
    `SELECT type, company_key, price_monthly, source, verified, evidence_text,
            evidence_url, prospect_id, dedupe_key
       FROM commitments WHERE campaign_id = $1 ORDER BY type`,
    [campaignId],
  );
  return rows;
}

beforeEach(() => {
  resetRateLimits();
  for (const mock of Object.values(pipelineMock)) mock.mockReset();
  registryMock.runJob.mockReset();
});

afterEach(async () => {
  for (const key of ENV_KEYS) delete process.env[key];
  resetConfigCache();
  resetRateLimits();
  await teardown();
});

// --- A. landing page --------------------------------------------------------

describe('landing page', () => {
  it('loads the stored copy and the exact price, with the honest disclosure', async () => {
    const { db } = await freshDb();
    const { slug, campaignId } = await seedCampaign(db, {
      price: 29,
      copy: {
        productName: 'Wholesale Minimums',
        oneSentenceOutcome: 'Stop hand-checking every wholesale order for minimums.',
        capabilities: ['Per-customer minimums', 'Blocks checkout below minimum', 'CSV import'],
        whoItIsFor: 'Shopify stores selling wholesale to trade customers',
        notIncluded: ['Invoicing'],
      },
    });

    const view = await loadLandingView(slug);
    expect(view).not.toBeNull();
    const landing = view!;

    expect(landing.campaignId).toBe(campaignId);
    expect(landing.copy.productName).toBe('Wholesale Minimums');
    expect(landing.copy.oneSentenceOutcome).toContain('hand-checking');
    expect(landing.copy.capabilities).toHaveLength(3);
    expect(landing.copy.capabilities[0]).toBe('Per-customer minimums');
    expect(landing.copy.whoItIsFor).toContain('Shopify');
    expect(landing.copy.notIncluded).toEqual(['Invoicing']);

    // The exact price, and the exact required CTA / checkbox wording.
    expect(landing.priceMonthly).toBe(29);
    expect(landing.priceLabel).toBe('$29');
    expect(landing.ctaLabel).toBe('Join the pilot at $29/month');
    expect(landing.priceCheckboxLabel).toBe("I'd like to use this at $29/month when available.");

    // The transparency statement is a fixed constant the page always renders.
    expect(VALIDATION_DISCLOSURE).toContain('being validated');
    expect(VALIDATION_DISCLOSURE).toContain('not built yet');
    expect(VALIDATION_DISCLOSURE).toContain('nothing is for sale on this page');
  });

  it('takes the price from the campaign, never from the generated copy', async () => {
    const { db } = await freshDb();
    const { slug } = await seedCampaign(db, {
      price: 19,
      copy: { productName: 'P', priceMonthly: 999, price: '$999' },
    });

    const view = await loadLandingView(slug);
    expect(view?.priceLabel).toBe('$19');
    expect(view?.ctaLabel).toBe('Join the pilot at $19/month');
    expect(JSON.stringify(view)).not.toContain('999');
  });

  it('falls back to stored wedge/offer data instead of inventing copy', async () => {
    const { db } = await freshDb();
    const { slug } = await seedCampaign(db, { price: 49, copy: {} });

    const view = await loadLandingView(slug);
    // offer_name is the only name we have; nothing is fabricated.
    expect(view?.copy.productName).toBe('Minimum Order Rules');
    expect(view?.copy.capabilities).toEqual([]);
    expect(view?.copy.problem).toBe('');
  });

  it('returns null for an unknown slug', async () => {
    await freshDb();
    expect(await loadLandingView('does-not-exist')).toBeNull();
  });

  it('records a landing visit, and never throws when it cannot', async () => {
    const { db } = await freshDb();
    const seeded = await seedCampaign(db);
    const prospectId = await insertProspect(db, seeded.opportunityId, { domain: 'shop.com' });

    await recordLandingVisit({
      campaignId: seeded.campaignId,
      opportunityId: seeded.opportunityId,
      slug: seeded.slug,
      referrer: 'https://mail.example.com/thread',
      prospectId,
    });

    const { rows } = await db.query<{ slug: string; referrer: string | null; prospect_id: string }>(
      `SELECT slug, referrer, prospect_id FROM landing_visits WHERE campaign_id = $1`,
      [seeded.campaignId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.slug).toBe(seeded.slug);
    expect(rows[0]?.prospect_id).toBe(prospectId);

    // Best effort: a bad campaign id must be swallowed, not thrown.
    await expect(
      recordLandingVisit({
        campaignId: 'cmp_does_not_exist',
        opportunityId: 'opp_does_not_exist',
        slug: 'nope',
      }),
    ).resolves.toBeUndefined();
  });

  it('builds the CTA and checkbox text from the price', () => {
    expect(ctaLabelFor('$7')).toBe('Join the pilot at $7/month');
    expect(priceCheckboxLabelFor('$7.50')).toBe(
      "I'd like to use this at $7.50/month when available.",
    );
  });
});

// --- B. pilot signup --------------------------------------------------------

describe('pilot signup', () => {
  it('creates PILOT_SIGNUP and EXPLICIT_PRICE_ACCEPTANCE with the normalized company key', async () => {
    const { db } = await freshDb();
    const seeded = await seedCampaign(db, { price: 29 });
    const prospectId = await insertProspect(db, seeded.opportunityId, { domain: 'shop.com' });

    const res = await pilotPost(
      jsonRequest('http://localhost:3000/api/pilot', {
        slug: seeded.slug,
        email: 'Buyer@Shop.com',
        domain: 'https://WWW.Shop.com/path?utm=1',
        question: 'We ship 40 wholesale orders a week.',
        priceAccepted: true,
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.alreadyRecorded).toBe(false);
    expect(body.companyKey).toBe('shop.com');
    expect(body.recorded).toEqual(['PILOT_SIGNUP', 'EXPLICIT_PRICE_ACCEPTANCE']);

    const rows = await commitmentsFor(db, seeded.campaignId);
    expect(rows.map((r) => r.type)).toEqual(['EXPLICIT_PRICE_ACCEPTANCE', 'PILOT_SIGNUP']);

    for (const row of rows) {
      expect(row.company_key).toBe('shop.com');
      expect(Number(row.price_monthly)).toBe(29);
      expect(row.source).toBe('LANDING_FORM');
      expect(row.verified).toBe(true);
      expect(row.prospect_id).toBe(prospectId);
      expect(row.evidence_url).toContain(`/v/${seeded.slug}`);
      // Evidence is what they actually submitted.
      expect(row.evidence_text).toContain('buyer@shop.com');
      expect(row.evidence_text).toContain('shop.com');
      expect(row.evidence_text).toContain('CHECKED');
      expect(row.evidence_text).toContain('40 wholesale orders a week');
      expect(row.dedupe_key).toBe(`${seeded.campaignId}:shop.com:${row.type}`);
    }
  });

  it('does not double-count a repeat submission from the same company', async () => {
    const { db } = await freshDb();
    const seeded = await seedCampaign(db, { price: 29 });

    const payload = {
      slug: seeded.slug,
      email: 'owner@shop.com',
      domain: 'shop.com',
      priceAccepted: true,
    };

    const first = await pilotPost(jsonRequest('http://localhost:3000/api/pilot', payload));
    expect(first.status).toBe(200);

    // Same company, different person, different spelling of the domain.
    const second = await pilotPost(
      jsonRequest('http://localhost:3000/api/pilot', {
        ...payload,
        email: 'ops@shop.com',
        domain: 'HTTPS://www.shop.com/contact',
      }),
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as Record<string, unknown>;
    expect(secondBody.ok).toBe(true);
    expect(secondBody.alreadyRecorded).toBe(true);
    expect(secondBody.recorded).toEqual([]);

    const rows = await commitmentsFor(db, seeded.campaignId);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.type))).toEqual(
      new Set(['PILOT_SIGNUP', 'EXPLICIT_PRICE_ACCEPTANCE']),
    );
  });

  it('records PILOT_SIGNUP but NOT EXPLICIT_PRICE_ACCEPTANCE without the price checkbox', async () => {
    const { db } = await freshDb();
    const seeded = await seedCampaign(db, { price: 29 });

    const res = await pilotPost(
      jsonRequest('http://localhost:3000/api/pilot', {
        slug: seeded.slug,
        email: 'owner@other.com',
        domain: 'other.com',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.priceAccepted).toBe(false);

    const rows = await commitmentsFor(db, seeded.campaignId);
    expect(rows.map((r) => r.type)).toEqual(['PILOT_SIGNUP']);
    expect(rows[0]?.evidence_text).toContain('not checked');
  });

  it('rejects a malformed email, an unusable domain and an unknown campaign', async () => {
    const { db } = await freshDb();
    const seeded = await seedCampaign(db);

    const badEmail = await pilotPost(
      jsonRequest('http://localhost:3000/api/pilot', {
        slug: seeded.slug,
        email: 'not-an-email',
        domain: 'shop.com',
      }),
    );
    expect(badEmail.status).toBe(400);

    const badDomain = await pilotPost(
      jsonRequest('http://localhost:3000/api/pilot', {
        slug: seeded.slug,
        email: 'a@b.com',
        domain: 'http://localhost',
      }),
    );
    expect(badDomain.status).toBe(400);

    const unknown = await pilotPost(
      jsonRequest('http://localhost:3000/api/pilot', {
        slug: 'no-such-slug',
        email: 'a@b.com',
        domain: 'shop.com',
      }),
    );
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error).toBe('UNKNOWN_CAMPAIGN');

    expect(await commitmentsFor(db, seeded.campaignId)).toHaveLength(0);
  });

  it('drops honeypot submissions without writing anything', async () => {
    const { db } = await freshDb();
    const seeded = await seedCampaign(db);

    const res = await pilotPost(
      jsonRequest('http://localhost:3000/api/pilot', {
        slug: seeded.slug,
        email: 'bot@spam.com',
        domain: 'spam.com',
        priceAccepted: true,
        website: 'http://spam.example',
      }),
    );
    expect(res.status).toBe(400);
    expect(await commitmentsFor(db, seeded.campaignId)).toHaveLength(0);
  });

  it('rate limits a single client', async () => {
    const { db } = await freshDb();
    const seeded = await seedCampaign(db);

    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const res = await pilotPost(
        jsonRequest(
          'http://localhost:3000/api/pilot',
          { slug: seeded.slug, email: `p${i}@shop${i}.com`, domain: `shop${i}.com` },
          '198.51.100.9',
        ),
      );
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
  });
});

// --- C. domain normalization ------------------------------------------------

describe('domain normalization', () => {
  it('reduces submitted URLs and emails to a stable company key', () => {
    expect(normalizeDomain('https://WWW.Shop.com/path')).toBe('shop.com');
    expect(normalizeDomain('http://shop.com')).toBe('shop.com');
    expect(normalizeDomain('  Shop.COM  ')).toBe('shop.com');
    expect(normalizeDomain('www.shop.com:8443/a/b?c=d#e')).toBe('shop.com');
    expect(normalizeDomain('//shop.com/')).toBe('shop.com');
    expect(normalizeDomain('shop.com.')).toBe('shop.com');
    expect(normalizeDomain('Owner@Shop.co.uk')).toBe('shop.co.uk');
    expect(normalizeDomain('https://user:pw@shop.com/x')).toBe('shop.com');
  });

  it('keeps meaningful subdomains so hosted stores stay distinct companies', () => {
    expect(normalizeDomain('https://acme.myshopify.com')).toBe('acme.myshopify.com');
    expect(normalizeDomain('https://other.myshopify.com')).toBe('other.myshopify.com');
    expect(normalizeDomain('www.shop.myshopify.com')).toBe('shop.myshopify.com');
  });

  it('rejects anything that is not a usable domain', () => {
    for (const bad of ['', '   ', 'localhost', 'not a domain', 'http://', '.', '..', 'shop']) {
      expect(normalizeDomain(bad)).toBeNull();
    }
    expect(normalizeDomain(null)).toBeNull();
    expect(normalizeDomain(undefined)).toBeNull();
  });
});

// --- D. admin auth ----------------------------------------------------------

describe('admin auth', () => {
  it('accepts a valid token from the header or the cookie and rejects everything else', async () => {
    await freshDb({ ADMIN_TOKEN });

    expect(isAdminTokenValid(ADMIN_TOKEN)).toBe(true);
    expect(isAdminTokenValid('wrong')).toBe(false);
    expect(isAdminTokenValid('')).toBe(false);
    expect(isAdminTokenValid(null)).toBe(false);

    const withHeader = new Request('http://localhost/admin', {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const withCookie = new Request('http://localhost/admin', {
      headers: { cookie: `other=1; ${ADMIN_COOKIE}=${encodeURIComponent(ADMIN_TOKEN)}` },
    });
    const withWrongCookie = new Request('http://localhost/admin', {
      headers: { cookie: `${ADMIN_COOKIE}=nope` },
    });
    const withNothing = new Request('http://localhost/admin');

    expect(isAuthorizedRequest(withHeader)).toBe(true);
    expect(isAuthorizedRequest(withCookie)).toBe(true);
    expect(isAuthorizedRequest(withWrongCookie)).toBe(false);
    expect(isAuthorizedRequest(withNothing)).toBe(false);

    expect(readPresentedToken(withHeader.headers)).toBe(ADMIN_TOKEN);
    expect(readPresentedToken(withCookie.headers)).toBe(ADMIN_TOKEN);
  });

  it('fails closed when ADMIN_TOKEN is not configured', async () => {
    await freshDb({ ADMIN_TOKEN: '' });
    expect(isAdminTokenValid('')).toBe(false);
    expect(isAdminTokenValid('anything')).toBe(false);
    expect(
      isAuthorizedRequest(new Request('http://localhost/admin', { headers: { cookie: 'mrr_admin=' } })),
    ).toBe(false);
  });

  it('refuses an admin API request without a token and serves it with one', async () => {
    await freshDb({ ADMIN_TOKEN });

    const anonymous = await setupCheckGet(new Request('http://localhost/api/setup-check'));
    expect(anonymous.status).toBe(401);
    expect((await anonymous.json()).error).toBe('UNAUTHORIZED');

    const wrong = await setupCheckGet(
      new Request('http://localhost/api/setup-check', {
        headers: { authorization: 'Bearer definitely-not-the-token-000000000000' },
      }),
    );
    expect(wrong.status).toBe(401);

    const viaHeader = await setupCheckGet(
      new Request('http://localhost/api/setup-check', {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
    );
    expect(viaHeader.status).toBe(200);

    const viaCookie = await setupCheckGet(
      new Request('http://localhost/api/setup-check', {
        headers: { cookie: `${ADMIN_COOKIE}=${ADMIN_TOKEN}` },
      }),
    );
    expect(viaCookie.status).toBe(200);
    const report = (await viaCookie.json()) as { checks: unknown[]; verdict: string };
    expect(Array.isArray(report.checks)).toBe(true);
  });

  it('exchanges a correct token for an httpOnly cookie and rejects a wrong one', async () => {
    await freshDb({ ADMIN_TOKEN });

    const rejected = await adminLoginPost(
      jsonRequest('http://localhost/api/admin/login', { token: 'wrong-token' }, '198.51.100.20'),
    );
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get('set-cookie')).toBeNull();

    const accepted = await adminLoginPost(
      jsonRequest('http://localhost/api/admin/login', { token: ADMIN_TOKEN }, '198.51.100.21'),
    );
    expect(accepted.status).toBe(200);
    const cookie = accepted.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${ADMIN_COOKIE}=`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
  });

  it('never turns ?next= into an open redirect', () => {
    expect(safeNextPath('/admin/costs')).toBe('/admin/costs');
    expect(safeNextPath('https://evil.example/admin')).toBe('/admin');
    expect(safeNextPath('//evil.example')).toBe('/admin');
    expect(safeNextPath('/not-admin')).toBe('/admin');
    expect(safeNextPath(null)).toBe('/admin');
  });
});

// --- E. settings must not leak secrets --------------------------------------

describe('admin settings', () => {
  it('reports credential presence only — no planted secret appears anywhere', async () => {
    await freshDb({
      ADMIN_TOKEN,
      CRON_SECRET,
      UNSUBSCRIBE_SECRET: 'unsub_PLANTEDFAKEKEY_0123456789',
      RESEND_API_KEY: PLANTED_RESEND_KEY,
      RESEND_WEBHOOK_SECRET: 'whsec_PLANTEDFAKEKEY_0123456789',
      ANTHROPIC_API_KEY: PLANTED_ANTHROPIC_KEY,
      BRAVE_SEARCH_API_KEY: 'BSA_PLANTEDFAKEKEY_0123456789',
      DATABASE_URL: PLANTED_DB_URL,
      STRIPE_SECRET_KEY: 'sk_live_PLANTEDFAKEKEY_0123456789',
      OWNER_NOTIFICATION_EMAIL: 'planted-owner@example.com',
      SENDER_POSTAL_ADDRESS: '1 PLANTEDFAKE Street, Boston MA',
    });

    const rendered = JSON.stringify(buildSettingsStatus());

    for (const secret of [
      PLANTED_RESEND_KEY,
      PLANTED_ANTHROPIC_KEY,
      PLANTED_DB_URL,
      ADMIN_TOKEN,
      CRON_SECRET,
      'PLANTEDFAKEKEY',
      'PLANTEDFAKEPASSWORD',
      'PLANTEDFAKE',
      'planted-owner@example.com',
    ]) {
      expect(rendered).not.toContain(secret);
    }

    // Not even a prefix or a fragment of a key.
    expect(rendered).not.toContain('re_');
    expect(rendered).not.toContain('sk-ant-');
    expect(rendered).not.toContain('whsec_');
    expect(rendered).not.toContain('postgres://');

    // It still tells the operator what is configured.
    const rows = buildSettingsStatus().flatMap((group) => group.rows);
    const resend = rows.find((row) => row.label === 'RESEND_API_KEY');
    expect(resend?.value).toBe('set');
    expect(resend?.kind).toBe('secret');
    const stripePublishable = rows.find((row) => row.label === 'STRIPE_PUBLISHABLE_KEY');
    expect(stripePublishable?.value).toBe('not set');

    // Non-secret operational values are still visible.
    expect(rows.find((row) => row.label === 'AUTONOMY_ENABLED')?.value).toBe('false');
    expect(rows.find((row) => row.label === 'MAX_EMAILS_PER_DAY')?.value).toBe('75');
  });
});

// --- F. setup check ---------------------------------------------------------

describe('setup check', () => {
  it('reports every required line and says plainly that outreach is blocked', async () => {
    await freshDb({ ADMIN_TOKEN });
    const report = await runSetupChecks();

    const names = report.checks.map((check) => check.name);
    for (const required of [
      'DATABASE',
      'RESEND SEND',
      'RESEND INBOUND',
      'SEARCH',
      'LLM',
      'CRON',
      'WEBHOOK',
      'DOMAIN',
      'OWNER NOTIFICATION',
    ]) {
      expect(names).toContain(required);
    }

    // The database is real here, so that line passes; the credential lines do not.
    expect(report.checks.find((c) => c.name === 'DATABASE')?.ok).toBe(true);
    expect(report.allOk).toBe(false);

    // The web layer's verdict must state the blockage explicitly.
    expect(outreachBlocked(report)).toBe(true);
    expect(outreachBlockedReason(report)).toBeTruthy();
    expect(overallVerdict(report)).toContain('NOT READY');
    expect(overallVerdict(report)).toContain('Outreach is blocked');

    // Failing lines carry a remediation hint.
    for (const check of report.checks) {
      if (!check.ok) expect(check.remediation.length).toBeGreaterThan(5);
    }

    // Nothing a credential-holder could read off the screen.
    const rendered = JSON.stringify({ ...report, verdict: overallVerdict(report) });
    expect(rendered).not.toContain(ADMIN_TOKEN);
  });

  it('never renders a secret value in a check detail', async () => {
    await freshDb({
      ADMIN_TOKEN,
      CRON_SECRET,
      RESEND_API_KEY: PLANTED_RESEND_KEY,
      RESEND_WEBHOOK_SECRET: 'whsec_PLANTEDFAKEKEY_0123456789',
      UNSUBSCRIBE_SECRET: 'unsub_PLANTEDFAKEKEY_0123456789',
    });
    const report = await runSetupChecks();
    const rendered = JSON.stringify({ ...report, verdict: overallVerdict(report) });

    for (const secret of [
      PLANTED_RESEND_KEY,
      ADMIN_TOKEN,
      CRON_SECRET,
      'PLANTEDFAKEKEY',
    ]) {
      expect(rendered).not.toContain(secret);
    }
  });
});

// --- G. cron ----------------------------------------------------------------

describe('cron', () => {
  it('rejects a missing or wrong bearer token', async () => {
    await freshDb({ CRON_SECRET });

    const anonymous = await cronPost(
      new Request('http://localhost/api/cron?job=discover_opportunities', { method: 'POST' }),
    );
    expect(anonymous.status).toBe(401);

    const wrong = await cronPost(
      new Request('http://localhost/api/cron?job=discover_opportunities', {
        method: 'POST',
        headers: { authorization: 'Bearer wrong-secret-0000000000000000000000' },
      }),
    );
    expect(wrong.status).toBe(401);
    expect((await wrong.json()).error).toBe('UNAUTHORIZED');

    const malformed = await cronPost(
      new Request('http://localhost/api/cron?job=x', {
        method: 'POST',
        headers: { authorization: CRON_SECRET },
      }),
    );
    expect(malformed.status).toBe(401);

    expect(registryMock.runJob).not.toHaveBeenCalled();
  });

  it('fails closed when CRON_SECRET is not configured', async () => {
    await freshDb({ CRON_SECRET: '' });
    const res = await cronPost(
      new Request('http://localhost/api/cron?job=send_due_messages', {
        method: 'POST',
        headers: { authorization: 'Bearer ' },
      }),
    );
    expect(res.status).toBe(401);
    expect(registryMock.runJob).not.toHaveBeenCalled();
  });

  it('dispatches a known job through the registry indirection, on POST and GET', async () => {
    await freshDb({ CRON_SECRET });
    registryMock.runJob.mockResolvedValue({
      job: 'send_due_messages',
      status: 'SUCCESS',
      recordsProcessed: 3,
      durationMs: 12,
      cost: 0,
      error: null,
    });

    const res = await cronPost(
      new Request('http://localhost/api/cron?job=send_due_messages', {
        method: 'POST',
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.status).toBe('SUCCESS');
    expect(body.recordsProcessed).toBe(3);
    expect(registryMock.runJob).toHaveBeenCalledWith('send_due_messages');

    // Vercel Cron issues GET.
    const viaGet = await cronGet(
      new Request('http://localhost/api/cron?job=send_due_messages', {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
    );
    expect(viaGet.status).toBe(200);
    expect(registryMock.runJob).toHaveBeenCalledTimes(2);
  });

  it('refuses an unknown or missing job name', async () => {
    await freshDb({ CRON_SECRET });

    const unknown = await cronPost(
      new Request('http://localhost/api/cron?job=rm_rf_everything', {
        method: 'POST',
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
    );
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toBe('UNKNOWN_JOB');

    const missing = await cronPost(
      new Request('http://localhost/api/cron', {
        method: 'POST',
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
    );
    expect(missing.status).toBe(400);
    expect(registryMock.runJob).not.toHaveBeenCalled();
  });
});

// --- H. health --------------------------------------------------------------

describe('health', () => {
  it('answers without auth and leaks nothing', async () => {
    await freshDb({
      ADMIN_TOKEN,
      CRON_SECRET,
      RESEND_API_KEY: PLANTED_RESEND_KEY,
      DATABASE_URL: PLANTED_DB_URL,
    });

    const res = await healthGet();
    expect(res.status).toBe(200);

    const raw = await res.text();
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.status).toBe('ok');
    expect(body.database).toBe(true);
    expect(body.migrationsApplied).toBe(true);
    expect(body.lastJobStatus).toBeNull();

    for (const secret of [PLANTED_RESEND_KEY, PLANTED_DB_URL, ADMIN_TOKEN, CRON_SECRET, 'PLANTED']) {
      expect(raw).not.toContain(secret);
    }
    // No configuration, versions or internals.
    expect(Object.keys(body).sort()).toEqual([
      'database',
      'lastJobAt',
      'lastJobStatus',
      'migrationsApplied',
      'ok',
      'status',
      'time',
    ]);
  });

  it('reports the status of the most recent job run', async () => {
    const { db } = await freshDb();
    await db.query(
      `INSERT INTO job_runs (id, job, status, started_at, completed_at, records_processed)
       VALUES ($1,'send_due_messages','FAILED', now(), now(), 0)`,
      [newId('jr')],
    );

    const raw = await (await healthGet()).text();
    expect(JSON.parse(raw).lastJobStatus).toBe('FAILED');
    // The job NAME is internal detail and must not appear on a public endpoint.
    expect(raw).not.toContain('send_due_messages');
  });
});

// --- I. unsubscribe ---------------------------------------------------------

describe('unsubscribe', () => {
  it('suppresses on a single GET with no confirmation step', async () => {
    await freshDb();
    pipelineMock.processUnsubscribe.mockResolvedValue({ ok: true, email: 'owner@shop.com' });

    const res = await unsubscribeGet(
      new Request('http://localhost/api/unsubscribe?token=signed-token-value-1234'),
    );

    expect(pipelineMock.processUnsubscribe).toHaveBeenCalledTimes(1);
    expect(pipelineMock.processUnsubscribe).toHaveBeenCalledWith('signed-token-value-1234');
    expect(res.status).toBe(303);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('/unsubscribe');
    expect(location).toContain('status=unsubscribed');
    // The recipient's address is never put in a URL.
    expect(location).not.toContain('owner@shop.com');
  });

  it('supports RFC 8058 one-click POST', async () => {
    await freshDb();
    pipelineMock.processUnsubscribe.mockResolvedValue({ ok: true, email: 'owner@shop.com' });

    const res = await unsubscribePost(
      new Request('http://localhost/api/unsubscribe?token=signed-token-value-1234', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.status).toBe('UNSUBSCRIBED');
    expect(pipelineMock.processUnsubscribe).toHaveBeenCalledWith('signed-token-value-1234');
  });

  it('never error-pages: an invalid token or an internal failure still gets a confirmation page', async () => {
    await freshDb();

    pipelineMock.processUnsubscribe.mockResolvedValue({ ok: false, email: null });
    const invalid = await unsubscribeGet(
      new Request('http://localhost/api/unsubscribe?token=bad-token-value-1234'),
    );
    expect(invalid.status).toBe(303);
    expect(invalid.headers.get('location')).toContain('status=invalid_token');

    pipelineMock.processUnsubscribe.mockRejectedValue(new Error('database on fire'));
    const broken = await unsubscribeGet(
      new Request('http://localhost/api/unsubscribe?token=good-token-value-1234'),
    );
    expect(broken.status).toBe(303);
    expect(broken.headers.get('location')).toContain('status=error');
    // The internal reason is never handed to the recipient.
    expect(broken.headers.get('location')).not.toContain('fire');

    const missing = await unsubscribeGet(new Request('http://localhost/api/unsubscribe'));
    expect(missing.status).toBe(303);
    expect(missing.headers.get('location')).toContain('/unsubscribe');
  });

  it('answers 400 for a one-click POST with no token at all', async () => {
    await freshDb();
    const res = await unsubscribePost(
      new Request('http://localhost/api/unsubscribe', { method: 'POST' }),
    );
    expect(res.status).toBe(400);
    expect(pipelineMock.processUnsubscribe).not.toHaveBeenCalled();
  });
});

// --- J. webhooks ------------------------------------------------------------

describe('webhooks', () => {
  const RAW = '{"type":"email.delivered",\n  "data": {"email_id":"abc"} }';

  it('passes the raw body and headers through untouched', async () => {
    await freshDb();
    pipelineMock.handleDeliveryWebhook.mockResolvedValue({
      accepted: true,
      duplicate: false,
      eventType: 'email.delivered',
    });

    const res = await deliveryWebhookPost(
      new Request('http://localhost/api/webhooks/resend', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'svix-signature': 'v1,abc' },
        body: RAW,
      }),
    );

    expect(res.status).toBe(200);
    const [rawBody, headers] = pipelineMock.handleDeliveryWebhook.mock.calls[0] as [
      string,
      Record<string, string>,
    ];
    // Byte-for-byte: signature verification depends on it.
    expect(rawBody).toBe(RAW);
    expect(headers['svix-signature']).toBe('v1,abc');
  });

  it('answers 200 for a duplicate so the provider stops retrying', async () => {
    await freshDb();
    pipelineMock.handleDeliveryWebhook.mockResolvedValue({
      accepted: false,
      duplicate: true,
      eventType: 'email.delivered',
    });

    const res = await deliveryWebhookPost(
      new Request('http://localhost/api/webhooks/resend', { method: 'POST', body: RAW }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).duplicate).toBe(true);
  });

  it('answers 401 on a signature failure and 400 on a malformed payload', async () => {
    await freshDb();

    pipelineMock.handleDeliveryWebhook.mockResolvedValue({
      accepted: false,
      duplicate: false,
      eventType: 'unknown',
      detail: 'invalid signature',
    });
    const badSignature = await deliveryWebhookPost(
      new Request('http://localhost/api/webhooks/resend', { method: 'POST', body: RAW }),
    );
    expect(badSignature.status).toBe(401);

    pipelineMock.handleDeliveryWebhook.mockResolvedValue({
      accepted: false,
      duplicate: false,
      eventType: 'unknown',
      detail: 'payload could not be parsed',
    });
    const malformed = await deliveryWebhookPost(
      new Request('http://localhost/api/webhooks/resend', { method: 'POST', body: 'not json' }),
    );
    expect(malformed.status).toBe(400);

    pipelineMock.handleDeliveryWebhook.mockRejectedValue(
      new Error('webhook signature verification failed'),
    );
    const thrownSignature = await deliveryWebhookPost(
      new Request('http://localhost/api/webhooks/resend', { method: 'POST', body: RAW }),
    );
    expect(thrownSignature.status).toBe(401);
  });

  it('never leaks an internal error into the response body', async () => {
    await freshDb();
    pipelineMock.handleDeliveryWebhook.mockRejectedValue(
      new Error('connection to postgres://user:hunter2@db failed'),
    );

    const res = await deliveryWebhookPost(
      new Request('http://localhost/api/webhooks/resend', { method: 'POST', body: RAW }),
    );
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('postgres://');
    expect(JSON.parse(text)).toEqual({ ok: false, error: 'REJECTED' });
  });

  it('handles the inbound webhook the same way', async () => {
    await freshDb();
    pipelineMock.handleInboundWebhook.mockResolvedValue({
      accepted: true,
      duplicate: false,
      classification: 'INTERESTED_STRONG',
      commitmentsCreated: 1,
      autoReplied: false,
      suppressed: false,
    });

    const res = await inboundWebhookPost(
      new Request('http://localhost/api/webhooks/resend-inbound', {
        method: 'POST',
        headers: { 'svix-id': 'evt_1' },
        body: RAW,
      }),
    );
    expect(res.status).toBe(200);
    const [rawBody, headers] = pipelineMock.handleInboundWebhook.mock.calls[0] as [
      string,
      Record<string, string>,
    ];
    expect(rawBody).toBe(RAW);
    expect(headers['svix-id']).toBe('evt_1');

    pipelineMock.handleInboundWebhook.mockResolvedValue({
      accepted: false,
      duplicate: false,
      classification: null,
      commitmentsCreated: 0,
      autoReplied: false,
      suppressed: false,
    });
    const rejected = await inboundWebhookPost(
      new Request('http://localhost/api/webhooks/resend-inbound', { method: 'POST', body: RAW }),
    );
    expect(rejected.status).toBe(400);
  });
});
