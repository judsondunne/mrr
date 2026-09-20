/**
 * Webhook integration tests, against a real (PGlite) Postgres.
 *
 * These cover the two ways an outside party can talk to this system, and the
 * three things that must always be true of both:
 *   - an unverified payload is never processed;
 *   - a replayed event changes nothing;
 *   - an open is recorded and never counted as intent.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { freshDb, teardown, insertProspect, type TestContext } from '../helpers';
import { resetConfigCache } from '../../src/lib/config';
import { newId } from '../../src/lib/hash';
import type { Db } from '../../src/lib/db';
import {
  handleDeliveryWebhook,
  handleInboundWebhook,
  signWebhookPayload,
  verifyWebhookSignature,
  classifyBounce,
} from '../../src/pipeline/outreach/webhooks';
import { isSuppressed } from '../../src/pipeline/outreach/suppression';
import { buildLandingCopy } from '../../src/pipeline/outreach/offer';
import type { Wedge } from '../../src/lib/contracts';

const WEBHOOK_SECRET = `whsec_${Buffer.from('test-webhook-signing-key-0123456789').toString('base64')}`;
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
  MONTHLY_LLM_BUDGET_USD: '20',
  RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET,
  RESEND_INBOUND_WEBHOOK_SECRET: WEBHOOK_SECRET,
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

function signedHeaders(
  body: string,
  opts: { id?: string; secret?: string; at?: Date } = {},
): Record<string, string> {
  const id = opts.id ?? newId('evt');
  const secret = opts.secret ?? WEBHOOK_SECRET;
  const timestamp = Math.floor((opts.at ?? new Date()).getTime() / 1000).toString();
  return {
    'svix-id': id,
    'svix-timestamp': timestamp,
    'svix-signature': `v1,${signWebhookPayload(secret, id, timestamp, body)}`,
  };
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

interface Fixture {
  opportunityId: string;
  campaignId: string;
  prospectId: string;
  messageId: string;
  providerMessageId: string;
  email: string;
  domain: string;
}

async function seed(db: Db, overrides: { domain?: string } = {}): Promise<Fixture> {
  const domain = overrides.domain ?? 'northside.example.com';
  const opportunityId = newId('opp');
  await db.query(
    `INSERT INTO opportunities
       (id, name, ecosystem, category, state, evidence_confidence, estimated_build_days,
        proposed_price_monthly, wedge_json, dedupe_key)
     VALUES ($1,'Minimum order rules','shopify','minimum-order-rules','VALIDATING','HIGH',5,19,$2,$3)`,
    [opportunityId, JSON.stringify(WEDGE), `shopify:minimum-order-rules:${opportunityId}`],
  );

  const campaignId = newId('cmp');
  await db.query(
    `INSERT INTO campaigns
       (id, opportunity_id, state, offer_name, price_monthly, landing_slug, landing_copy_json, started_at, target_count)
     VALUES ($1,$2,'BATCH_1','Minimum Order Rules',19,$3,$4, now(), 150)`,
    [
      campaignId,
      opportunityId,
      `minimum-order-rules-${campaignId}`,
      JSON.stringify(buildLandingCopy({ wedge: WEDGE, ecosystem: 'shopify', priceMonthly: 19 })),
    ],
  );

  const prospectId = await insertProspect(db, opportunityId, { domain, status: 'CONTACTED' });
  const messageId = newId('msg');
  const providerMessageId = `prov_${newId('p')}`;
  await db.query(
    `INSERT INTO messages
       (id, campaign_id, prospect_id, direction, sequence_step, provider_message_id, thread_id,
        subject, body, sent_at, status, idempotency_key)
     VALUES ($1,$2,$3,'OUTBOUND',0,$4,$1,'Question about your wholesale minimums','body', now(), 'SENT', $5)`,
    [messageId, campaignId, prospectId, providerMessageId, `${campaignId}:${prospectId}:0`],
  );

  return { opportunityId, campaignId, prospectId, messageId, providerMessageId, email: `hello@${domain}`, domain };
}

function deliveryBody(type: string, emailId: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type,
    created_at: new Date().toISOString(),
    data: { email_id: emailId, to: ['someone@example.com'], ...extra },
  });
}

async function messageRow(ctx: TestContext, id: string) {
  const res = await ctx.db.query<{
    status: string;
    delivered_at: string | null;
    opened_at: string | null;
    clicked_at: string | null;
    bounced_at: string | null;
    bounce_type: string | null;
    complained_at: string | null;
  }>(
    `SELECT status, delivered_at, opened_at, clicked_at, bounced_at, bounce_type, complained_at
       FROM messages WHERE id = $1`,
    [id],
  );
  return res.rows[0];
}

// ---------------------------------------------------------------------------

describe('webhook signature verification', () => {
  it('rejects a bad signature and never processes the payload', async () => {
    const ctx = await freshDb(env());
    const fixture = await seed(ctx.db);
    const body = deliveryBody('email.delivered', fixture.providerMessageId);

    const headers = signedHeaders(body, { secret: 'whsec_' + Buffer.from('a-different-secret').toString('base64') });
    const result = await handleDeliveryWebhook(body, headers);

    expect(result.accepted).toBe(false);
    expect(result.detail).toBe('SIGNATURE_MISMATCH');
    expect((await messageRow(ctx, fixture.messageId))?.status).toBe('SENT');
    const events = await ctx.db.query('SELECT id FROM webhook_events');
    expect(events.rowCount).toBe(0);
  });

  it('rejects a tampered body even with otherwise valid headers', async () => {
    const ctx = await freshDb(env());
    const fixture = await seed(ctx.db);
    const body = deliveryBody('email.delivered', fixture.providerMessageId);
    const headers = signedHeaders(body);

    const tampered = deliveryBody('email.complained', fixture.providerMessageId);
    const result = await handleDeliveryWebhook(tampered, headers);
    expect(result.accepted).toBe(false);
    expect(await isSuppressed(fixture.email)).toBe(false);
  });

  it('rejects a replayed capture with a stale timestamp', async () => {
    await freshDb(env());
    const body = deliveryBody('email.delivered', 'prov_x');
    const old = new Date(Date.now() - 60 * 60 * 1000);
    const result = await handleDeliveryWebhook(body, signedHeaders(body, { at: old }));
    expect(result.accepted).toBe(false);
    expect(result.detail).toBe('STALE_TIMESTAMP');
  });

  it('rejects missing headers and an unconfigured secret', async () => {
    await freshDb(env({ RESEND_WEBHOOK_SECRET: '', RESEND_INBOUND_WEBHOOK_SECRET: '' }));
    const body = deliveryBody('email.delivered', 'prov_x');
    expect((await handleDeliveryWebhook(body, {})).detail).toBe('WEBHOOK_SECRET_NOT_CONFIGURED');

    expect(verifyWebhookSignature(body, {}, 'whsec_abc').reason).toBe('MISSING_SIGNATURE_HEADERS');
    expect(verifyWebhookSignature('', signedHeaders(''), WEBHOOK_SECRET).reason).toBe('EMPTY_BODY');
  });

  it('accepts the resend- and webhook- header aliases', async () => {
    const ctx = await freshDb(env());
    const fixture = await seed(ctx.db);
    const body = deliveryBody('email.delivered', fixture.providerMessageId);
    const svix = signedHeaders(body);
    const aliased = {
      'resend-id': svix['svix-id'] ?? '',
      'resend-timestamp': svix['svix-timestamp'] ?? '',
      'resend-signature': svix['svix-signature'] ?? '',
    };
    expect((await handleDeliveryWebhook(body, aliased)).accepted).toBe(true);
  });
});

describe('delivery events', () => {
  it('marks a message delivered, and a replay of the same event is a no-op', async () => {
    const ctx = await freshDb(env());
    const fixture = await seed(ctx.db);
    const body = deliveryBody('email.delivered', fixture.providerMessageId);
    const headers = signedHeaders(body);

    const first = await handleDeliveryWebhook(body, headers);
    expect(first).toMatchObject({ accepted: true, duplicate: false, eventType: 'email.delivered' });
    const afterFirst = await messageRow(ctx, fixture.messageId);
    expect(afterFirst?.status).toBe('DELIVERED');

    const second = await handleDeliveryWebhook(body, headers);
    expect(second).toMatchObject({ accepted: true, duplicate: true });

    const afterSecond = await messageRow(ctx, fixture.messageId);
    expect(afterSecond?.delivered_at).toEqual(afterFirst?.delivered_at);
    const events = await ctx.db.query('SELECT id FROM webhook_events');
    expect(events.rowCount).toBe(1);
  });

  it('hard bounce suppresses the address and marks the prospect BOUNCED', async () => {
    const ctx = await freshDb(env());
    const fixture = await seed(ctx.db);
    const body = deliveryBody('email.bounced', fixture.providerMessageId, {
      bounce: { type: 'Permanent', subType: 'General', message: 'No such user here' },
    });

    const result = await handleDeliveryWebhook(body, signedHeaders(body));
    expect(result.accepted).toBe(true);

    const row = await messageRow(ctx, fixture.messageId);
    expect(row?.status).toBe('BOUNCED');
    expect(row?.bounce_type).toBe('HARD');
    expect(await isSuppressed(fixture.email)).toBe(true);

    const prospect = await ctx.db.query<{ status: string }>('SELECT status FROM prospects WHERE id = $1', [
      fixture.prospectId,
    ]);
    expect(prospect.rows[0]?.status).toBe('BOUNCED');
  });

  it('a soft bounce is recorded but never suppresses', async () => {
    const ctx = await freshDb(env());
    const fixture = await seed(ctx.db);
    const body = deliveryBody('email.bounced', fixture.providerMessageId, {
      bounce: { type: 'Transient', subType: 'MailboxFull', message: 'mailbox is full' },
    });

    await handleDeliveryWebhook(body, signedHeaders(body));
    const row = await messageRow(ctx, fixture.messageId);
    expect(row?.bounce_type).toBe('SOFT');
    expect(await isSuppressed(fixture.email)).toBe(false);

    expect(classifyBounce({ type: 'Permanent' })).toBe('HARD');
    expect(classifyBounce({ message: 'user unknown' })).toBe('HARD');
    expect(classifyBounce({ type: 'Transient' })).toBe('SOFT');
    expect(classifyBounce(undefined)).toBe('SOFT');
  });

  it('a complaint suppresses immediately', async () => {
    const ctx = await freshDb(env());
    const fixture = await seed(ctx.db);
    const body = deliveryBody('email.complained', fixture.providerMessageId);

    await handleDeliveryWebhook(body, signedHeaders(body));

    expect(await isSuppressed(fixture.email)).toBe(true);
    expect((await messageRow(ctx, fixture.messageId))?.status).toBe('COMPLAINED');
    const prospect = await ctx.db.query<{ status: string }>('SELECT status FROM prospects WHERE id = $1', [
      fixture.prospectId,
    ]);
    expect(prospect.rows[0]?.status).toBe('SUPPRESSED');
  });

  it('records an open WITHOUT ever treating it as intent', async () => {
    const ctx = await freshDb(env());
    const fixture = await seed(ctx.db);
    const opened = deliveryBody('email.opened', fixture.providerMessageId);
    const clicked = deliveryBody('email.clicked', fixture.providerMessageId, { click: { link: 'https://x.example' } });

    await handleDeliveryWebhook(opened, signedHeaders(opened));
    await handleDeliveryWebhook(clicked, signedHeaders(clicked));

    const row = await messageRow(ctx, fixture.messageId);
    expect(row?.opened_at).not.toBeNull();
    expect(row?.clicked_at).not.toBeNull();
    // Status untouched, no commitment, prospect not advanced.
    expect(row?.status).toBe('SENT');
    const commitments = await ctx.db.query('SELECT id FROM commitments');
    expect(commitments.rowCount).toBe(0);
    const prospect = await ctx.db.query<{ status: string }>('SELECT status FROM prospects WHERE id = $1', [
      fixture.prospectId,
    ]);
    expect(prospect.rows[0]?.status).toBe('CONTACTED');
  });

  it('records a delivery delay without changing delivery state', async () => {
    const ctx = await freshDb(env());
    const fixture = await seed(ctx.db);
    const body = deliveryBody('email.delivery_delayed', fixture.providerMessageId);
    const result = await handleDeliveryWebhook(body, signedHeaders(body));
    expect(result.accepted).toBe(true);
    expect((await messageRow(ctx, fixture.messageId))?.status).toBe('SENT');
  });
});

describe('inbound replies', () => {
  function inboundBody(
    fixture: Fixture,
    text: string,
    overrides: { messageId?: string; html?: string } = {},
  ): string {
    return JSON.stringify({
      type: 'email.inbound',
      created_at: new Date().toISOString(),
      data: {
        message_id: overrides.messageId ?? `in_${newId('m')}`,
        from: `Dana <${fixture.email}>`,
        to: ['founder@validator.example'],
        subject: 'Re: Question about your wholesale minimums',
        text,
        html: overrides.html,
        in_reply_to: fixture.providerMessageId,
      },
    });
  }

  it('creates exactly one commitment per company, even on a repeat reply', async () => {
    const ctx = await freshDb(env());
    const fixture = await seed(ctx.db);
    ctx.llm.register('outreach.classify_reply', () => ({
      classification: 'PRICE_ACCEPTED',
      intent: 'accepts the price and wants the pilot',
      requestedFeature: null,
      competitorMentioned: null,
      priceReaction: 'ACCEPTED',
      timing: null,
      explicitlyWantsAccess: true,
      explicitlyAcceptedPrice: true,
      requiresHuman: false,
      intentScore: 0.95,
    }));

    const first = inboundBody(fixture, "Yes — $19/month is fine. Sign us up for the pilot.");
    const firstResult = await handleInboundWebhook(first, signedHeaders(first));
    expect(firstResult.accepted).toBe(true);
    expect(firstResult.classification).toBe('PRICE_ACCEPTED');
    expect(firstResult.commitmentsCreated).toBeGreaterThan(0);

    const second = inboundBody(fixture, "Following up — $19/month is fine, sign us up for the pilot.");
    const secondResult = await handleInboundWebhook(second, signedHeaders(second));
    expect(secondResult.duplicate).toBe(false);
    expect(secondResult.commitmentsCreated).toBe(0);

    const perType = await ctx.db.query<{ type: string; n: string | number }>(
      'SELECT type, COUNT(*) AS n FROM commitments GROUP BY type',
    );
    for (const row of perType.rows) expect(Number(row.n)).toBe(1);

    const companies = await ctx.db.query<{ company_key: string }>(
      'SELECT DISTINCT company_key FROM commitments',
    );
    expect(companies.rows.map((r) => r.company_key)).toEqual([fixture.domain]);

    const prospect = await ctx.db.query<{ status: string }>('SELECT status FROM prospects WHERE id = $1', [
      fixture.prospectId,
    ]);
    expect(prospect.rows[0]?.status).toBe('COMMITTED');
  });

  it('creates NO commitment for a weak reply with a high intent score', async () => {
    const ctx = await freshDb(env());
    const fixture = await seed(ctx.db);
    ctx.llm.register('outreach.classify_reply', () => ({
      classification: 'INTERESTED_WEAK',
      intent: 'vaguely positive',
      requestedFeature: null,
      competitorMentioned: null,
      priceReaction: 'ACCEPTED',
      timing: null,
      // Deliberately overconfident model output.
      explicitlyWantsAccess: true,
      explicitlyAcceptedPrice: true,
      requiresHuman: false,
      intentScore: 1,
    }));

    const body = inboundBody(fixture, 'Sounds interesting, cool idea. Keep me posted.');
    const result = await handleInboundWebhook(body, signedHeaders(body));

    expect(result.commitmentsCreated).toBe(0);
    const commitments = await ctx.db.query('SELECT id FROM commitments');
    expect(commitments.rowCount).toBe(0);

    const stored = await ctx.db.query<{ intent_score: string; classification: string }>(
      `SELECT intent_score, classification FROM messages WHERE direction = 'INBOUND'`,
    );
    // The score is stored as advisory metadata and gated nothing.
    expect(Number(stored.rows[0]?.intent_score)).toBe(1);
    expect(stored.rows[0]?.classification).toBe('INTERESTED_WEAK');
  });

  it('suppresses on an opt-out in the reply body, with no LLM call and no auto-reply', async () => {
    const ctx = await freshDb(env());
    const fixture = await seed(ctx.db);
    const body = inboundBody(fixture, 'Please remove me from this list.');

    const result = await handleInboundWebhook(body, signedHeaders(body));

    expect(result.classification).toBe('UNSUBSCRIBE');
    expect(result.suppressed).toBe(true);
    expect(result.autoReplied).toBe(false);
    expect(await isSuppressed(fixture.email)).toBe(true);
    expect(ctx.llm.calls).toHaveLength(0);
    expect(ctx.email.sent).toHaveLength(0);

    const prospect = await ctx.db.query<{ status: string }>('SELECT status FROM prospects WHERE id = $1', [
      fixture.prospectId,
    ]);
    expect(prospect.rows[0]?.status).toBe('SUPPRESSED');
  });

  it('stores the reply as sanitized data, threaded to the original', async () => {
    const ctx = await freshDb(env());
    const fixture = await seed(ctx.db);
    const body = inboundBody(fixture, '', {
      html: '<div>How does this handle per-customer minimums?<script>alert(1)</script></div>',
    });

    await handleInboundWebhook(body, signedHeaders(body));

    const inbound = await ctx.db.query<{ body: string; thread_id: string; status: string; direction: string }>(
      `SELECT body, thread_id, status, direction FROM messages WHERE direction = 'INBOUND'`,
    );
    expect(inbound.rowCount).toBe(1);
    expect(inbound.rows[0]?.body).toContain('per-customer minimums');
    expect(inbound.rows[0]?.body).not.toContain('<script>');
    expect(inbound.rows[0]?.body).not.toContain('alert(1)');
    expect(inbound.rows[0]?.thread_id).toBe(fixture.messageId);
    expect(inbound.rows[0]?.status).toBe('RECEIVED');
  });

  it('ignores a replayed inbound event', async () => {
    const ctx = await freshDb(env());
    const fixture = await seed(ctx.db);
    const body = inboundBody(fixture, 'How does this handle per-customer minimums?');
    const headers = signedHeaders(body);

    const first = await handleInboundWebhook(body, headers);
    expect(first.accepted).toBe(true);
    const second = await handleInboundWebhook(body, headers);
    expect(second).toMatchObject({ accepted: true, duplicate: true, commitmentsCreated: 0 });

    const inbound = await ctx.db.query(`SELECT id FROM messages WHERE direction = 'INBOUND'`);
    expect(inbound.rowCount).toBe(1);
  });

  it('sends a bounded auto-reply that asks for the commitment', async () => {
    const ctx = await freshDb(env());
    const fixture = await seed(ctx.db);
    ctx.llm.register('outreach.classify_reply', () => ({
      classification: 'ASKING_QUESTION',
      intent: 'asks a question about minimums',
      requestedFeature: null,
      competitorMentioned: null,
      priceReaction: 'NOT_MENTIONED',
      timing: null,
      explicitlyWantsAccess: false,
      explicitlyAcceptedPrice: false,
      requiresHuman: false,
      intentScore: 0.4,
    }));
    ctx.llm.register('outreach.auto_reply', () => ({
      canAnswerFromOffer: true,
      needsHuman: false,
      answer: 'It applies per-customer minimum order values and shows clear cart messaging.',
      clarifyingQuestion: null,
    }));

    const body = inboundBody(fixture, 'Does it do per-customer minimums?');
    const result = await handleInboundWebhook(body, signedHeaders(body));

    expect(result.autoReplied).toBe(true);
    expect(ctx.email.sent).toHaveLength(1);
    const sent = ctx.email.sent[0];
    expect(sent?.to).toBe(fixture.email);
    expect(sent?.text).toContain('reserve it here');
    expect(sent?.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(sent?.inReplyTo).toBe(fixture.providerMessageId);
  });

  it('refuses to auto-reply in shadow mode but keeps the draft', async () => {
    const ctx = await freshDb(env({ AUTONOMY_ENABLED: 'false', OUTREACH_ENABLED: 'false' }));
    const fixture = await seed(ctx.db);
    ctx.llm.register('outreach.classify_reply', () => ({
      classification: 'ASKING_QUESTION',
      intent: 'asks a question',
      requestedFeature: null,
      competitorMentioned: null,
      priceReaction: 'NOT_MENTIONED',
      timing: null,
      explicitlyWantsAccess: false,
      explicitlyAcceptedPrice: false,
      requiresHuman: false,
      intentScore: 0.4,
    }));
    ctx.llm.register('outreach.auto_reply', () => ({
      canAnswerFromOffer: true,
      needsHuman: false,
      answer: 'It applies per-customer minimum order values.',
      clarifyingQuestion: null,
    }));

    const body = inboundBody(fixture, 'Does it do per-customer minimums?');
    const result = await handleInboundWebhook(body, signedHeaders(body));

    expect(result.autoReplied).toBe(false);
    expect(ctx.email.sent).toHaveLength(0);
    const draft = await ctx.db.query<{ status: string; body: string }>(
      `SELECT status, body FROM messages WHERE sequence_step = -1 AND direction = 'OUTBOUND'`,
    );
    expect(draft.rowCount).toBe(1);
    expect(draft.rows[0]?.status).toBe('DRAFTED');
    expect(draft.rows[0]?.body).toContain('reserve it here');
  });
});
