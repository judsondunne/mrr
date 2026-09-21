/**
 * Cross-campaign company fatigue.
 *
 * One real business is ONE row, and the rules about contacting it are absolute:
 * NEVER_CONTACT is terminal, a cooldown is off limits until it expires, and a
 * business engaged in one experiment is never pulled into an unrelated one.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { freshDb, teardown, insertOpportunity, insertCampaign, insertProspect } from '../helpers';
import { resetConfigCache } from '../../src/lib/config';
import { newId } from '../../src/lib/hash';
import {
  canContactCompany,
  canContactCompanyForCampaign,
  companyKeyOf,
  isCountableCompany,
  isCountableCompanyKey,
  markEngaged,
  markNeverContact,
  mergeCompanies,
  recordContact,
  resolveCompanyKey,
  startCooldown,
  upsertCompany,
} from '../../src/autonomy/company';
import { suppress } from '../../src/pipeline/outreach/suppression';
import { prepareCampaigns } from '../../src/pipeline/outreach/campaign';
import { sendDueMessages } from '../../src/pipeline/outreach/send';

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
  SENDING_DOMAIN: 'validator.example',
  OWNER_NAME: 'Alex Founder',
  ALLOWED_OUTREACH_COUNTRIES: 'US',
  SENDING_WINDOW_START_HOUR: '0',
  SENDING_WINDOW_END_HOUR: '24',
  SENDING_WEEKDAYS_ONLY: 'false',
  MAX_EMAILS_PER_DAY: '75',
  INITIAL_EMAIL_BATCH: '25',
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

const WEDGE = {
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

// ---------------------------------------------------------------------------

describe('company identity', () => {
  it('uses the single registrable-domain normalizer', async () => {
    await freshDb(env());
    expect(companyKeyOf('https://WWW.Northside.com/wholesale?x=1')).toBe('northside.com');
    expect(companyKeyOf('shop.northside.com')).toBe('northside.com');
    expect(companyKeyOf('acme.myshopify.com')).toBe('acme.myshopify.com');
    expect(companyKeyOf('')).toBe('unknown');
  });

  it('registers a business once, however many times it is seen', async () => {
    const ctx = await freshDb(env());
    const first = await upsertCompany({ companyKey: 'WWW.Northside.com', displayName: 'Northside' });
    const second = await upsertCompany({ companyKey: 'shop.northside.com' });
    expect(second.id).toBe(first.id);
    const rows = await ctx.db.query('SELECT id FROM company_registry');
    expect(rows.rowCount).toBe(1);
  });
});

describe('NEVER_CONTACT is terminal', () => {
  it('cannot be cleared by any other writer', async () => {
    await freshDb(env());
    await markNeverContact('northside.com', 'unsubscribed');

    const blocked = await canContactCompany('northside.com');
    expect(blocked.allowed).toBe(false);
    expect(blocked.state).toBe('NEVER_CONTACT');

    // Every other state writer is asked to overwrite it. None may.
    await startCooldown({ companyKey: 'northside.com', days: 1, reason: 'try to downgrade' });
    await markEngaged('northside.com', 'cmp_anything');
    await upsertCompany({ companyKey: 'northside.com', dataQuality: 'HIGH' });
    await recordContact({ companyKey: 'northside.com', campaignId: 'cmp_anything' });

    const after = await canContactCompany('northside.com');
    expect(after.allowed).toBe(false);
    expect(after.state).toBe('NEVER_CONTACT');
    // Not even the campaign-aware variant lets it through.
    expect((await canContactCompanyForCampaign('northside.com', 'cmp_anything')).allowed).toBe(false);
  });

  it('is set by an unsubscribe, for the whole business', async () => {
    await freshDb(env());
    await suppress({ email: 'hello@northside.com', reason: 'UNSUBSCRIBE' });

    const verdict = await canContactCompany('northside.com');
    expect(verdict.state).toBe('NEVER_CONTACT');
    // A different published address at the same business is equally off limits.
    expect((await canContactCompany('wholesale.northside.com')).allowed).toBe(false);
  });

  it('is set by a spam complaint', async () => {
    await freshDb(env());
    await suppress({ email: 'hello@complainer.com', reason: 'COMPLAINT' });
    expect((await canContactCompany('complainer.com')).state).toBe('NEVER_CONTACT');
  });
});

describe('cooldowns', () => {
  it('blocks until the cooldown expires, then allows again', async () => {
    const ctx = await freshDb(env());
    await startCooldown({ companyKey: 'northside.com', days: 90, reason: 'negative reply' });

    const blocked = await canContactCompany('northside.com');
    expect(blocked.allowed).toBe(false);
    expect(blocked.state).toBe('COOLDOWN');
    expect(blocked.cooldownUntil).toBeInstanceOf(Date);

    await ctx.db.query(`UPDATE company_registry SET cooldown_until = now() - interval '1 day'`);
    expect((await canContactCompany('northside.com')).allowed).toBe(true);
  });

  it('keeps an unrelated campaign away for COMPANY_COOLDOWN_DAYS', async () => {
    const ctx = await freshDb(env({ COMPANY_COOLDOWN_DAYS: '90' }));
    await recordContact({ companyKey: 'northside.com', campaignId: 'cmp_a' });

    // The campaign that is already talking to them may keep going.
    expect((await canContactCompanyForCampaign('northside.com', 'cmp_a')).allowed).toBe(true);
    // An unrelated experiment may not.
    const other = await canContactCompanyForCampaign('northside.com', 'cmp_b');
    expect(other.allowed).toBe(false);
    expect(other.reason).toMatch(/^CROSS_CAMPAIGN_COOLDOWN:90d/);

    await ctx.db.query(`UPDATE company_registry SET last_contacted_at = now() - interval '120 days'`);
    expect((await canContactCompanyForCampaign('northside.com', 'cmp_b')).allowed).toBe(true);
  });

  it('is skipped by the send path, with the reason recorded', async () => {
    const ctx = await freshDb(env({ INITIAL_EMAIL_BATCH: '5' }));
    const opportunityId = await insertOpportunity(ctx.db, { state: 'CAMPAIGN_READY' });
    await ctx.db.query(
      `UPDATE opportunities SET wedge_json = $2, proposed_price_monthly = 19 WHERE id = $1`,
      [opportunityId, JSON.stringify(WEDGE)],
    );
    await insertProspect(ctx.db, opportunityId, { domain: 'allowed-store.example.com' });
    await insertProspect(ctx.db, opportunityId, { domain: 'tired-store.example.com' });

    expect((await prepareCampaigns(1))[0]?.drafted).toBe(2);

    // The cooldown starts AFTER the drafts exist, so only the send path can
    // catch it — exactly the race the second check exists for.
    await startCooldown({ companyKey: 'tired-store.example.com', days: 90, reason: 'contacted last month' });

    const results = await sendDueMessages();
    expect(results[0]?.sent).toBe(1);
    expect(ctx.email.sent.map((e) => e.to)).toEqual(['hello@allowed-store.example.com']);

    const skipped = await ctx.db.query<{ error: string }>(
      `SELECT error FROM messages WHERE status = 'FAILED'`,
    );
    expect(skipped.rowCount).toBe(1);
    expect(skipped.rows[0]?.error).toMatch(/^SKIPPED:COMPANY_COOLDOWN:/);
  });
});

describe('an engaged company belongs to one experiment', () => {
  it('is not pulled into a second one', async () => {
    await freshDb(env());
    await markEngaged('northside.com', 'cmp_first');

    expect((await canContactCompanyForCampaign('northside.com', 'cmp_first')).allowed).toBe(true);

    const second = await canContactCompanyForCampaign('northside.com', 'cmp_second');
    expect(second.allowed).toBe(false);
    expect(second.state).toBe('ENGAGED');
    expect(second.reason).toBe('ENGAGED_IN_ANOTHER_EXPERIMENT:cmp_first');

    // The campaign-agnostic question is also "no": something is already
    // talking to this business.
    expect((await canContactCompany('northside.com')).allowed).toBe(false);
  });
});

describe('experiment hygiene: what counts as a company', () => {
  it('excludes autoresponders, vendors, free mail and internal/test domains', async () => {
    await freshDb(env());
    // A real business.
    expect(isCountableCompanyKey('northside-supply.com')).toBe(true);
    expect(isCountableCompanyKey('acme.myshopify.com')).toBe(true);

    // Machines and ticketing systems.
    expect(isCountableCompanyKey('zendesk.com')).toBe(false);
    expect(isCountableCompanyKey('amazonses.com')).toBe(false);
    expect(isCountableCompanyKey('sendgrid.net')).toBe(false);

    // Platform vendors and marketplaces — the prospecting layer's own list.
    expect(isCountableCompanyKey('shopify.com')).toBe(false);
    expect(isCountableCompanyKey('hubspot.com')).toBe(false);
    expect(isCountableCompanyKey('trustpilot.com')).toBe(false);

    // Consumer mailboxes: a person, but not a company. Counting these would
    // collapse thousands of unrelated businesses into one.
    expect(isCountableCompanyKey('gmail.com')).toBe(false);
    expect(isCountableCompanyKey('outlook.com')).toBe(false);

    // Internal, test and fixture domains.
    expect(isCountableCompanyKey('example.com')).toBe(false);
    expect(isCountableCompanyKey('store.test')).toBe(false);
    expect(isCountableCompanyKey('mailinator.com')).toBe(false);
    expect(isCountableCompanyKey('unknown')).toBe(false);
    // Our own sending domain.
    expect(isCountableCompanyKey('validator.example')).toBe(false);
  });

  it('flags a non-countable domain on the row when it is registered', async () => {
    const ctx = await freshDb(env());
    await upsertCompany({ companyKey: 'hello.gmail.com' });
    await upsertCompany({ companyKey: 'northside-supply.com' });

    expect(await isCountableCompany('gmail.com')).toBe(false);
    expect(await isCountableCompany('northside-supply.com')).toBe(true);

    const flagged = await ctx.db.query<{ company_key: string; is_internal_or_test: boolean }>(
      'SELECT company_key, is_internal_or_test FROM company_registry ORDER BY company_key',
    );
    const byKey = new Map(flagged.rows.map((r) => [r.company_key, r.is_internal_or_test]));
    expect(byKey.get('gmail.com')).toBe(true);
    expect(byKey.get('northside-supply.com')).toBe(false);
  });

  it('honours a manual internal/test flag even for a plausible domain', async () => {
    const ctx = await freshDb(env());
    await upsertCompany({ companyKey: 'northside-supply.com' });
    await ctx.db.query(`UPDATE company_registry SET is_internal_or_test = true`);
    expect(await isCountableCompany('northside-supply.com')).toBe(false);
  });
});

describe('mergeCompanies', () => {
  it('collapses two domains into one company and never loosens a restriction', async () => {
    const ctx = await freshDb(env());
    await upsertCompany({ companyKey: 'northside.com', displayName: 'Northside' });
    await upsertCompany({ companyKey: 'northsidesupply.com' });
    await markNeverContact('northsidesupply.com', 'they unsubscribed at the other domain');

    await mergeCompanies('northside.com', 'northsidesupply.com');

    // Both keys now answer as one company, and the strictest state survived.
    expect(await resolveCompanyKey('northsidesupply.com')).toBe('northside.com');
    expect((await canContactCompany('northsidesupply.com')).state).toBe('NEVER_CONTACT');
    expect((await canContactCompany('northside.com')).state).toBe('NEVER_CONTACT');

    const alts = await ctx.db.query<{ alt_domains_json: unknown }>(
      `SELECT alt_domains_json FROM company_registry WHERE company_key = 'northside.com'`,
    );
    const parsed = alts.rows[0]?.alt_domains_json;
    const list = typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
    expect(list).toContain('northsidesupply.com');
  });

  it('is a no-op for a self-merge or an unknown duplicate', async () => {
    await freshDb(env());
    await upsertCompany({ companyKey: 'northside.com' });
    await mergeCompanies('northside.com', 'northside.com');
    await mergeCompanies('northside.com', 'never-registered.com');
    expect((await canContactCompany('northside.com')).allowed).toBe(true);
  });

  it('repoints prospect rows at the surviving company', async () => {
    const ctx = await freshDb(env());
    const opportunityId = await insertOpportunity(ctx.db);
    const prospectId = await insertProspect(ctx.db, opportunityId, { domain: 'dupe.com' });
    const primary = await upsertCompany({ companyKey: 'primary.com' });
    const duplicate = await upsertCompany({ companyKey: 'dupe.com' });
    await ctx.db.query('UPDATE prospects SET company_id = $2 WHERE id = $1', [prospectId, duplicate.id]);

    await mergeCompanies('primary.com', 'dupe.com');

    const row = await ctx.db.query<{ company_id: string }>('SELECT company_id FROM prospects WHERE id = $1', [
      prospectId,
    ]);
    expect(row.rows[0]?.company_id).toBe(primary.id);
  });
});

describe('the send path registers and ages the company it emailed', () => {
  it('records the contact so an unrelated campaign is blocked afterwards', async () => {
    const ctx = await freshDb(env({ INITIAL_EMAIL_BATCH: '1' }));
    const opportunityId = await insertOpportunity(ctx.db, { state: 'CAMPAIGN_READY' });
    await ctx.db.query(
      `UPDATE opportunities SET wedge_json = $2, proposed_price_monthly = 19 WHERE id = $1`,
      [opportunityId, JSON.stringify(WEDGE)],
    );
    await insertProspect(ctx.db, opportunityId, { domain: 'fresh-store.example.com' });
    await prepareCampaigns(1);
    await sendDueMessages();

    expect(ctx.email.sent).toHaveLength(1);
    const row = await ctx.db.query<{ total_emails: number; last_campaign_id: string }>(
      `SELECT total_emails, last_campaign_id FROM company_registry WHERE company_key = 'fresh-store.example.com'`,
    );
    expect(Number(row.rows[0]?.total_emails)).toBe(1);

    const otherCampaign = await insertCampaign(ctx.db, opportunityId, { id: newId('cmp'), slug: 'other' });
    expect((await canContactCompanyForCampaign('fresh-store.example.com', otherCampaign)).allowed).toBe(false);
  });
});
