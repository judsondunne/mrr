/**
 * Test helpers shared by every test file.
 *
 * `freshDb()` gives each test a pristine in-memory Postgres with the real
 * migrations applied — no mocking of the data layer anywhere in the suite.
 */
import { closeDb, getDb, setDbForTesting } from '../src/lib/db';
import { runMigrations } from '../src/lib/migrate';
import { resetConfigCache } from '../src/lib/config';
import { setLlmProvider, MockLlmProvider } from '../src/lib/llm/index';
import { setSearchProvider, MockSearchProvider } from '../src/lib/search/index';
import { setEmailProvider, getEmailProvider, MockEmailProvider } from '../src/lib/email/index';
import { newId } from '../src/lib/hash';
import type { Db } from '../src/lib/db';

/**
 * Env vars any test is allowed to override. Cleared before each freshDb() so
 * one test's override cannot silently change another test's meaning.
 */
const RESETTABLE_ENV = [
  'AUTONOMY_ENABLED', 'OUTREACH_ENABLED', 'KILL_SWITCH', 'EXTREME_VALIDATION',
  'ENABLE_PAYMENT_METHOD_VALIDATION',
  'MONTHLY_LLM_BUDGET_USD', 'MONTHLY_SEARCH_BUDGET_USD',
  'MAX_EMAILS_PER_DAY', 'MAX_NEW_CAMPAIGNS_PER_WEEK',
  'MIN_UNIQUE_STRONG_COMMITMENTS', 'MIN_UNIQUE_PRICE_ACCEPTANCES',
  'MIN_UNIQUE_ACTION_COMMITMENTS', 'MIN_DELIVERED_BEFORE_STANDARD_EVALUATION',
  'MIN_QUALIFIED_PROSPECTS_FOR_GATE', 'MIN_POSITIVE_INTENT_RATE',
  'MIN_QUALIFIED_PROSPECTS', 'MAX_MVP_BUILD_DAYS',
  'REQUIRED_CATEGORY_EVIDENCE_CONFIDENCE',
  'INITIAL_EMAIL_BATCH', 'SECOND_EMAIL_BATCH', 'MAX_EMAILS_PER_CAMPAIGN', 'MAX_FOLLOWUPS',
  'SENDING_WINDOW_START_HOUR', 'SENDING_WINDOW_END_HOUR', 'SENDING_WEEKDAYS_ONLY',
  'ALLOWED_OUTREACH_COUNTRIES', 'PUBLIC_BASE_URL', 'UNSUBSCRIBE_SECRET',
  'ADMIN_TOKEN', 'CRON_SECRET', 'SENDER_EMAIL', 'SENDER_COMPANY',
  'SENDER_POSTAL_ADDRESS', 'SENDING_DOMAIN', 'OWNER_NAME', 'OWNER_NOTIFICATION_EMAIL',
  'RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET', 'RESEND_INBOUND_WEBHOOK_SECRET',
] as const;

export interface TestContext {
  db: Db;
  llm: MockLlmProvider;
  search: MockSearchProvider;
  email: MockEmailProvider;
}

export async function freshDb(envOverrides: Record<string, string> = {}): Promise<TestContext> {
  await closeDb().catch(() => undefined);
  setDbForTesting(null);

  // Reset every switch a previous test may have flipped. Without this, an
  // override such as KILL_SWITCH=true leaks into later tests in the same file
  // and silently turns their assertions into no-ops.
  for (const key of RESETTABLE_ENV) delete process.env[key];

  process.env.DATABASE_MODE = 'pglite';
  process.env.PGLITE_DATA_DIR = ':memory:';
  process.env.LLM_PROVIDER = 'mock';
  process.env.SEARCH_PROVIDER = 'mock';
  process.env.EMAIL_PROVIDER = 'mock';
  for (const [k, v] of Object.entries(envOverrides)) process.env[k] = v;
  resetConfigCache();

  const db = await getDb();
  await runMigrations();

  const llm = new MockLlmProvider();
  const search = new MockSearchProvider();
  const email = new MockEmailProvider();
  setLlmProvider(llm);
  setSearchProvider(search);
  setEmailProvider(email);

  return { db, llm, search, email };
}

export async function teardown(): Promise<void> {
  setLlmProvider(null);
  setSearchProvider(null);
  setEmailProvider(null);
  await closeDb().catch(() => undefined);
  setDbForTesting(null);
}

/** Inserts a minimal opportunity row and returns its id. */
export async function insertOpportunity(
  db: Db,
  overrides: Partial<{
    id: string;
    name: string;
    ecosystem: string;
    category: string;
    state: string;
    evidence_confidence: string;
    estimated_build_days: number;
    proposed_price_monthly: number;
    proposed_wedge: string;
    target_customer: string;
  }> = {},
): Promise<string> {
  const id = overrides.id ?? newId('opp');
  await db.query(
    `INSERT INTO opportunities
       (id, name, ecosystem, category, state, evidence_confidence,
        estimated_build_days, proposed_price_monthly, proposed_wedge, target_customer, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      id,
      overrides.name ?? 'Test Opportunity',
      overrides.ecosystem ?? 'shopify',
      overrides.category ?? 'minimum-order-rules',
      overrides.state ?? 'DISCOVERED',
      overrides.evidence_confidence ?? null,
      overrides.estimated_build_days ?? null,
      overrides.proposed_price_monthly ?? null,
      overrides.proposed_wedge ?? null,
      overrides.target_customer ?? null,
      `${overrides.ecosystem ?? 'shopify'}:${overrides.category ?? 'minimum-order-rules'}:${id}`,
    ],
  );
  return id;
}

export async function insertCampaign(
  db: Db,
  opportunityId: string,
  overrides: Partial<{ id: string; state: string; price: number; slug: string; target: number }> = {},
): Promise<string> {
  const id = overrides.id ?? newId('cmp');
  await db.query(
    `INSERT INTO campaigns (id, opportunity_id, state, offer_name, price_monthly, landing_slug, target_count, started_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())`,
    [
      id,
      opportunityId,
      overrides.state ?? 'BATCH_1',
      'Test Offer',
      overrides.price ?? 19,
      overrides.slug ?? `slug-${id}`,
      overrides.target ?? 150,
    ],
  );
  return id;
}

export async function insertProspect(
  db: Db,
  opportunityId: string,
  overrides: Partial<{ id: string; domain: string; email: string; status: string; country: string }> = {},
): Promise<string> {
  const id = overrides.id ?? newId('pr');
  const domain = overrides.domain ?? `${id}.example.com`;
  await db.query(
    `INSERT INTO prospects
       (id, opportunity_id, company_name, domain, ecosystem, status, contact_email,
        email_is_public, country, public_evidence_url, contact_source_url, qualification_reason)
     VALUES ($1,$2,$3,$4,'shopify',$5,$6,true,$7,$8,$9,'test fixture')`,
    [
      id,
      opportunityId,
      `Company ${id}`,
      domain,
      overrides.status ?? 'QUALIFIED',
      overrides.email ?? `hello@${domain}`,
      overrides.country ?? 'US',
      `https://${domain}/wholesale`,
      `https://${domain}/contact`,
    ],
  );
  return id;
}

/** Inserts a DELIVERED outbound message, which is what the gate counts. */
export async function insertDeliveredMessage(
  db: Db,
  campaignId: string,
  prospectId: string,
): Promise<string> {
  const id = newId('msg');
  await db.query(
    `INSERT INTO messages
       (id, campaign_id, prospect_id, direction, sequence_step, subject, body,
        sent_at, delivered_at, status, idempotency_key)
     VALUES ($1,$2,$3,'OUTBOUND',0,'s','b', now(), now(), 'DELIVERED', $4)`,
    [id, campaignId, prospectId, `${campaignId}:${prospectId}:0`],
  );
  return id;
}

export async function insertCommitment(
  db: Db,
  campaignId: string,
  companyKey: string,
  type: string,
  overrides: Partial<{ prospectId: string; price: number; source: string; evidence: string }> = {},
): Promise<string> {
  const id = newId('cmt');
  await db.query(
    `INSERT INTO commitments
       (id, campaign_id, prospect_id, company_key, type, price_monthly, source, evidence_text, verified, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [
      id,
      campaignId,
      overrides.prospectId ?? null,
      companyKey,
      type,
      overrides.price ?? 19,
      overrides.source ?? 'LANDING_FORM',
      overrides.evidence ?? 'test evidence',
      `${campaignId}:${companyKey}:${type}`,
    ],
  );
  return id;
}

/**
 * Makes the installed mock email transport report its sends as REAL.
 *
 * The owner notifier refuses to consume a notification claim for a simulated
 * send — otherwise a validated opportunity would be marked "notified" while the
 * email went to a mock, and the owner would never be told, even after the
 * provider was configured. Tests that exercise notification DEDUPE therefore
 * need a transport that stands in for a working provider.
 */
export function treatEmailAsDelivered(): void {
  const provider = getEmailProvider();
  if (provider instanceof MockEmailProvider) provider.deliversAsReal = true;
}
