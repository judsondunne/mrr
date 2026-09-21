/**
 * Suppression and unsubscribe.
 *
 * The contract being tested: once an address or its domain is suppressed, no
 * code path in this system will email it again — including a message that was
 * already drafted and approved before the suppression happened.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { freshDb, teardown, insertProspect } from '../helpers';
import { resetConfigCache } from '../../src/lib/config';
import { newId } from '../../src/lib/hash';
import type { Db } from '../../src/lib/db';
import {
  suppress,
  isSuppressed,
  filterSuppressed,
  normalizeDomain,
  normalizeEmail,
  domainOfEmail,
  companyKeyFor,
  isCountryAllowed,
} from '../../src/pipeline/outreach/suppression';
import {
  buildUnsubscribeUrl,
  buildUnsubscribeToken,
  verifyUnsubscribeToken,
  processUnsubscribe,
  extractUnsubscribeToken,
} from '../../src/pipeline/outreach/unsubscribe';
import { prepareCampaigns } from '../../src/pipeline/outreach/campaign';
import { sendDueMessages } from '../../src/pipeline/outreach/send';
import type { Wedge } from '../../src/lib/contracts';

const ORIGINAL_ENV = { ...process.env };

const BASE_ENV: Record<string, string> = {
  AUTONOMY_ENABLED: 'true',
  OUTREACH_ENABLED: 'true',
  KILL_SWITCH: 'false',
  PUBLIC_BASE_URL: 'https://validator.example',
  UNSUBSCRIBE_SECRET: 'unsubscribe-secret-used-only-by-tests',
  SENDER_COMPANY: 'Example Labs LLC',
  SENDER_EMAIL: 'founder@validator.example',
  SENDER_POSTAL_ADDRESS: '55 Test Street, Boston MA 02118',
  OWNER_NAME: 'Alex Founder',
  ALLOWED_OUTREACH_COUNTRIES: 'US',
  SENDING_WINDOW_START_HOUR: '0',
  SENDING_WINDOW_END_HOUR: '24',
  SENDING_WEEKDAYS_ONLY: 'false',
  SENDING_TIMEZONE: 'America/New_York',
  MAX_EMAILS_PER_DAY: '75',
  INITIAL_EMAIL_BATCH: '5',
  MONTHLY_LLM_BUDGET_USD: '20',
};

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value !== undefined) process.env[key] = value;
  }
  resetConfigCache();
}

afterEach(async () => {
  await teardown();
  restoreEnv();
});

function env(overrides: Record<string, string> = {}): Record<string, string> {
  return { ...BASE_ENV, ...overrides };
}

const WEDGE: Wedge = {
  statement: 'For Shopify stores with a wholesale channel, enforce minimum order rules without a B2B replatform.',
  productName: 'Minimum Order Rules',
  targetCustomer: 'Shopify stores that sell wholesale to small independent retailers',
  coreWorkflow: 'enforcing minimum order quantities at checkout',
  v1Features: ['per-customer minimums', 'collection-level minimums', 'cart warnings'],
  excludedFromV1: ['multi-currency pricing'],
  proposedPriceMonthly: 19,
  estimatedBuildDays: 5,
  primaryCompetitor: 'Wholesale Club',
  reasonSomeoneWouldSwitch: 'the full B2B rebuild the incumbent requires',
  oneSentenceOutcome: 'keep wholesale orders under your minimum out of checkout',
  capabilities: ['per-customer minimum order values', 'collection-level minimums', 'clear cart messaging'],
  whoItIsFor: 'Shopify stores with a wholesale channel',
};

async function seedOpportunity(db: Db): Promise<string> {
  const id = newId('opp');
  await db.query(
    `INSERT INTO opportunities
       (id, name, ecosystem, category, state, evidence_confidence, estimated_build_days,
        proposed_price_monthly, wedge_json, dedupe_key)
     VALUES ($1,'Minimum order rules','shopify','minimum-order-rules','CAMPAIGN_READY','HIGH',5,19,$2,$3)`,
    [id, JSON.stringify(WEDGE), `shopify:minimum-order-rules:${id}`],
  );
  return id;
}

// ---------------------------------------------------------------------------

describe('suppression list', () => {
  it('suppresses an address without suppressing its whole domain', async () => {
    await freshDb(env());
    await suppress({ email: 'Owner@Example.COM ', reason: 'UNSUBSCRIBE' });

    expect(await isSuppressed('owner@example.com')).toBe(true);
    expect(await isSuppressed('OWNER@EXAMPLE.COM')).toBe(true);
    expect(await isSuppressed('somebody-else@example.com')).toBe(false);
  });

  it('suppresses every address at a suppressed domain', async () => {
    await freshDb(env());
    await suppress({ domain: 'www.Blocked-shop.test', reason: 'COMPLAINT' });

    expect(await isSuppressed('anyone@blocked-shop.test')).toBe(true);
    expect(await isSuppressed('someone@other-shop.test')).toBe(false);
  });

  it('is idempotent', async () => {
    const ctx = await freshDb(env());
    await suppress({ email: 'dupe@example.com', reason: 'HARD_BOUNCE' });
    await suppress({ email: 'dupe@example.com', reason: 'HARD_BOUNCE' });
    await suppress({ email: 'dupe@example.com', reason: 'COMPLAINT' });

    const rows = await ctx.db.query('SELECT id FROM suppression_list WHERE email = $1', ['dupe@example.com']);
    expect(rows.rowCount).toBe(1);
    expect(await isSuppressed('dupe@example.com')).toBe(true);
  });

  it('mirrors suppression onto the prospect row', async () => {
    const ctx = await freshDb(env());
    const opportunityId = await seedOpportunity(ctx.db);
    const prospectId = await insertProspect(ctx.db, opportunityId, { domain: 'mirror-shop.test' });

    await suppress({ email: 'hello@mirror-shop.test', reason: 'UNSUBSCRIBE' });

    const row = await ctx.db.query<{ status: string; suppressed_at: string | null }>(
      'SELECT status, suppressed_at FROM prospects WHERE id = $1',
      [prospectId],
    );
    expect(row.rows[0]?.status).toBe('SUPPRESSED');
    expect(row.rows[0]?.suppressed_at).not.toBeNull();
  });

  it('bulk-filters by address and by domain', async () => {
    await freshDb(env());
    await suppress({ email: 'a@one-shop.test', reason: 'UNSUBSCRIBE' });
    await suppress({ domain: 'two-shop.test', reason: 'COMPLAINT' });

    const blocked = await filterSuppressed(['a@one-shop.test', 'b@one-shop.test', 'c@two-shop.test']);
    expect([...blocked].sort()).toEqual(['a@one-shop.test', 'c@two-shop.test']);
  });

  it('normalizes the way every caller expects', () => {
    expect(normalizeEmail('  Foo@Bar.COM ')).toBe('foo@bar.com');
    expect(normalizeDomain('https://WWW.Example.com/path')).toBe('example.com');
    expect(domainOfEmail('a@b-shop.test')).toBe('b-shop.test');
    expect(domainOfEmail('not-an-address')).toBeNull();
    expect(companyKeyFor({ domain: 'WWW.Shop.com' })).toBe('shop.com');
    expect(companyKeyFor({ email: 'x@shop.com' })).toBe('shop.com');
    expect(isCountryAllowed('us', ['US'])).toBe(true);
    expect(isCountryAllowed('DE', ['US'])).toBe(false);
    expect(isCountryAllowed(null, ['US'])).toBe(false);
  });
});

describe('the send path re-checks suppression', () => {
  it('never emails a suppressed address or a suppressed domain, even with a draft ready', async () => {
    const ctx = await freshDb(env());
    const opportunityId = await seedOpportunity(ctx.db);
    // Distinct REGISTRABLE domains on purpose. Three subdomains of one parent
    // would be one company under the canonical normalizer — correctly, since
    // shop.acme.com and www.acme.com are the same business — so a fixture
    // using *.example.com for three unrelated businesses would be asserting
    // something that is not true of real prospects.
    await insertProspect(ctx.db, opportunityId, { domain: 'allowed-shop.test' });
    await insertProspect(ctx.db, opportunityId, { domain: 'blocked-address-shop.test' });
    await insertProspect(ctx.db, opportunityId, { domain: 'blocked-domain-shop.test' });

    const prepared = await prepareCampaigns(1);
    expect(prepared[0]?.drafted).toBe(3);

    // Suppression happens AFTER the drafts exist.
    await suppress({ email: 'hello@blocked-address-shop.test', reason: 'UNSUBSCRIBE' });
    await suppress({ domain: 'blocked-domain-shop.test', reason: 'COMPLAINT' });

    const results = await sendDueMessages();
    expect(results[0]?.sent).toBe(1);

    const recipients = ctx.email.sent.map((e) => e.to);
    expect(recipients).toEqual(['hello@allowed-shop.test']);
    expect(recipients).not.toContain('hello@blocked-address-shop.test');
    expect(recipients).not.toContain('hello@blocked-domain-shop.test');

    const skipped = await ctx.db.query<{ status: string; error: string }>(
      `SELECT status, error FROM messages WHERE status = 'FAILED'`,
    );
    expect(skipped.rowCount).toBe(2);
    for (const row of skipped.rows) {
      expect(row.error).toMatch(/^SKIPPED:(SUPPRESSED|PROSPECT_SUPPRESSED)$/);
    }
    expect(await isSuppressed('hello@blocked-address-shop.test')).toBe(true);
    expect(await isSuppressed('hello@blocked-domain-shop.test')).toBe(true);
  });

  it('refuses a suppression-table entry even when the prospect row looks fine', async () => {
    const ctx = await freshDb(env());
    const opportunityId = await seedOpportunity(ctx.db);
    await insertProspect(ctx.db, opportunityId, { domain: 'stale-shop.test' });
    await prepareCampaigns(1);

    // Straight into the table, with no mirroring onto the prospect row: the
    // send path must still consult the list itself.
    await ctx.db.query(
      `INSERT INTO suppression_list (id, email, reason) VALUES ($1,$2,'COMPLAINT')`,
      [newId('sup'), 'hello@stale-shop.test'],
    );

    const results = await sendDueMessages();
    expect(results[0]?.sent).toBe(0);
    expect(ctx.email.sent).toHaveLength(0);
    const row = await ctx.db.query<{ error: string }>(`SELECT error FROM messages WHERE status = 'FAILED'`);
    expect(row.rows[0]?.error).toBe('SKIPPED:SUPPRESSED');
  });

  it('suppresses and refuses prospects outside ALLOWED_OUTREACH_COUNTRIES', async () => {
    const ctx = await freshDb(env({ ALLOWED_OUTREACH_COUNTRIES: 'US,CA' }));
    const opportunityId = await seedOpportunity(ctx.db);
    await insertProspect(ctx.db, opportunityId, { domain: 'us-store.test', country: 'US' });
    await insertProspect(ctx.db, opportunityId, { domain: 'ca-store.test', country: 'CA' });
    await prepareCampaigns(1);

    // The allow-list narrows after the drafts were written.
    process.env.ALLOWED_OUTREACH_COUNTRIES = 'US';
    resetConfigCache();

    const results = await sendDueMessages();
    expect(results[0]?.sent).toBe(1);
    expect(ctx.email.sent.map((e) => e.to)).toEqual(['hello@us-store.test']);
    expect(await isSuppressed('hello@ca-store.test')).toBe(true);

    const reason = await ctx.db.query<{ reason: string }>(
      'SELECT reason FROM suppression_list WHERE email = $1',
      ['hello@ca-store.test'],
    );
    expect(reason.rows[0]?.reason).toBe('COUNTRY_NOT_ALLOWED');
  });

  it('puts a working one-click opt-out on every draft', async () => {
    const ctx = await freshDb(env({ INITIAL_EMAIL_BATCH: '1' }));
    const opportunityId = await seedOpportunity(ctx.db);
    await insertProspect(ctx.db, opportunityId, { domain: 'optout-shop.test' });
    await prepareCampaigns(1);
    await sendDueMessages();

    const sent = ctx.email.sent[0];
    expect(sent).toBeDefined();
    expect(sent?.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(sent?.headers?.['List-Unsubscribe']).toMatch(/^<https:\/\/validator\.example\/api\/unsubscribe\?t=.+>$/);

    const token = extractUnsubscribeToken(sent?.text ?? '');
    expect(token).not.toBeNull();
    const outcome = await processUnsubscribe(token ?? '');
    expect(outcome).toEqual({ ok: true, email: 'hello@optout-shop.test' });
    expect(await isSuppressed('hello@optout-shop.test')).toBe(true);
  });
});

describe('unsubscribe tokens', () => {
  it('round-trips a genuine token', async () => {
    await freshDb(env());
    const token = buildUnsubscribeToken('Person@Example.com');
    expect(verifyUnsubscribeToken(token)).toBe('person@example.com');
    expect(buildUnsubscribeUrl('person@example.com')).toBe(
      `https://validator.example/api/unsubscribe?t=${token}`,
    );
  });

  it('rejects a tampered address, a tampered signature, and junk', async () => {
    await freshDb(env());
    const token = buildUnsubscribeToken('victim@example.com');
    const [payload, signature] = token.split('.');

    const swappedPayload = `${Buffer.from('attacker@example.com', 'utf8').toString('base64url')}.${signature ?? ''}`;
    expect(verifyUnsubscribeToken(swappedPayload)).toBeNull();

    const flipped = `${payload ?? ''}.${(signature ?? '').replace(/^./, (c) => (c === 'a' ? 'b' : 'a'))}`;
    expect(verifyUnsubscribeToken(flipped)).toBeNull();

    expect(verifyUnsubscribeToken('')).toBeNull();
    expect(verifyUnsubscribeToken('not-a-token')).toBeNull();
    expect(verifyUnsubscribeToken(`${payload ?? ''}.`)).toBeNull();
  });

  it('refuses a token minted with a different secret', async () => {
    await freshDb(env({ UNSUBSCRIBE_SECRET: 'secret-one' }));
    const token = buildUnsubscribeToken('person@example.com');

    process.env.UNSUBSCRIBE_SECRET = 'secret-two';
    resetConfigCache();
    expect(verifyUnsubscribeToken(token)).toBeNull();

    const result = await processUnsubscribe(token);
    expect(result).toEqual({ ok: false, email: null });
    expect(await isSuppressed('person@example.com')).toBe(false);
  });

  it('suppresses on a verified one-click unsubscribe', async () => {
    await freshDb(env());
    const result = await processUnsubscribe(buildUnsubscribeToken('leaver@example.com'));
    expect(result.ok).toBe(true);
    expect(await isSuppressed('leaver@example.com')).toBe(true);
  });
});
