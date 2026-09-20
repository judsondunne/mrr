/**
 * Outreach: composition, compliance, campaign preparation, the send path, and
 * follow-up eligibility.
 *
 * The send tests are the important ones. They are written to fail loudly if
 * anyone ever makes it possible to send the same email twice, to exceed a cap,
 * to send outside the window, or to send at all in shadow mode.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { freshDb, teardown, insertProspect, type TestContext } from '../helpers.js';
import { resetConfigCache, getConfig } from '../../src/lib/config.js';
import { newId } from '../../src/lib/hash.js';
import type { Db } from '../../src/lib/db.js';
import { prepareCampaigns } from '../../src/pipeline/outreach/campaign.js';
import {
  sendDueMessages,
  cumulativeTargetForState,
  flushPendingAutoReplies,
} from '../../src/pipeline/outreach/send.js';
import { scheduleFollowups, MAX_SEQUENCE_FOLLOWUPS } from '../../src/pipeline/outreach/followups.js';
import { sendingWindowStatus } from '../../src/pipeline/outreach/window.js';
import {
  validateCompliance,
  sanitizeObservation,
  buildSubject,
  withHeaders,
  assembleInitialBody,
  buildFooter,
} from '../../src/pipeline/outreach/compose.js';
import { buildLandingCopy, landingUrlFor } from '../../src/pipeline/outreach/offer.js';
import type { Wedge } from '../../src/lib/contracts.js';

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
  INITIAL_EMAIL_BATCH: '25',
  SECOND_EMAIL_BATCH: '50',
  MAX_EMAILS_PER_CAMPAIGN: '150',
  MAX_NEW_CAMPAIGNS_PER_WEEK: '3',
  MAX_FOLLOWUPS: '2',
  FOLLOWUP_1_DELAY_DAYS: '4',
  FOLLOWUP_2_DELAY_DAYS: '8',
  MONTHLY_LLM_BUDGET_USD: '20',
  MAX_HARD_BOUNCE_RATE: '0.05',
  MAX_COMPLAINT_RATE: '0',
  MAX_UNSUBSCRIBE_RATE: '0.05',
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

function setEnv(overrides: Record<string, string>): void {
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
  resetConfigCache();
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

async function seedOpportunity(db: Db, state = 'CAMPAIGN_READY'): Promise<string> {
  const id = newId('opp');
  await db.query(
    `INSERT INTO opportunities
       (id, name, ecosystem, category, state, evidence_confidence, estimated_build_days,
        proposed_price_monthly, wedge_json, dedupe_key)
     VALUES ($1,'Minimum order rules','shopify','minimum-order-rules',$2,'HIGH',5,19,$3,$4)`,
    [id, state, JSON.stringify(WEDGE), `shopify:minimum-order-rules:${id}`],
  );
  return id;
}

async function seedProspects(db: Db, opportunityId: string, count: number, country = 'US'): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    ids.push(await insertProspect(db, opportunityId, { domain: `store-${i}-${newId('d')}.example.com`, country }));
  }
  return ids;
}

async function messageStatuses(db: Db): Promise<Record<string, number>> {
  const res = await db.query<{ status: string; n: string | number }>(
    `SELECT status, COUNT(*) AS n FROM messages WHERE direction = 'OUTBOUND' GROUP BY status`,
  );
  const out: Record<string, number> = {};
  for (const row of res.rows) out[row.status] = Number(row.n);
  return out;
}

async function prepared(ctx: TestContext, prospectCount: number, overrides: Record<string, string> = {}) {
  const opportunityId = await seedOpportunity(ctx.db);
  await seedProspects(ctx.db, opportunityId, prospectCount);
  if (Object.keys(overrides).length > 0) setEnv(overrides);
  const results = await prepareCampaigns(5);
  return { opportunityId, results };
}

// ---------------------------------------------------------------------------

describe('compliance validator', () => {
  it('accepts a fully formed message', async () => {
    await freshDb(env());
    const message = buildSample();
    expect(validateCompliance(message)).toEqual({ ok: true, violations: [] });
  });

  it('refuses a message with no postal address or footer', async () => {
    await freshDb(env());
    const message = { ...buildSample(), text: 'Hi — want to buy a thing?' };
    const report = validateCompliance(message);
    expect(report.ok).toBe(false);
    expect(report.violations).toContain('MISSING_POSTAL_ADDRESS');
    expect(report.violations).toContain('MISSING_UNSUBSCRIBE_LINK');
  });

  it('refuses a message whose unsubscribe link was signed for somebody else', async () => {
    await freshDb(env());
    const other = withHeaders('someone-else@example.com', 'Subject here', 'body');
    const message = buildSample();
    const tampered = { ...message, text: message.text.replace(/Unsubscribe in one click: \S+/, `Unsubscribe in one click: ${other.unsubscribeUrl}`) };
    expect(validateCompliance(tampered).violations).toContain('UNSUBSCRIBE_TOKEN_WRONG_RECIPIENT');
  });

  it('refuses a missing List-Unsubscribe-Post header', async () => {
    await freshDb(env());
    const message = buildSample();
    const stripped = { ...message, headers: { 'List-Unsubscribe': message.headers['List-Unsubscribe'] ?? '' } };
    expect(validateCompliance(stripped).violations).toContain('MISSING_LIST_UNSUBSCRIBE_POST_HEADER');
  });

  it('refuses misleading RE:/FWD: subjects and fake scarcity', async () => {
    await freshDb(env());
    const message = buildSample();
    expect(validateCompliance({ ...message, subject: 'RE: our conversation' }).violations).toContain(
      'MISLEADING_SUBJECT_PREFIX',
    );
    const scarcity = { ...message, text: `${message.text}\nOnly 3 spots left!` };
    expect(validateCompliance(scarcity).violations).toContain('DECEPTIVE_CONTENT:FAKE_SCARCITY');
  });

  it('rejects personalization that claims a relationship we do not have', () => {
    expect(sanitizeObservation("I've been following your brand for years")).toBeNull();
    expect(sanitizeObservation('your wholesale page lists a 6-unit minimum')).toBe(
      'your wholesale page lists a 6-unit minimum',
    );
  });

  function buildSample() {
    const cfg = getConfig();
    const offer = {
      campaignId: 'cmp_1',
      opportunityId: 'opp_1',
      landingSlug: 'minimum-order-rules',
      landingUrl: landingUrlFor('minimum-order-rules'),
      priceMonthly: 19,
      copy: buildLandingCopy({ wedge: WEDGE, ecosystem: 'shopify', priceMonthly: 19 }),
    };
    const prospect = {
      id: 'pr_1',
      companyName: 'Northside Supply',
      domain: 'northside.example.com',
      contactEmail: 'hello@northside.example.com',
      contactName: null,
      publicEvidenceUrl: 'https://northside.example.com/wholesale',
      qualificationReason: 'publishes a wholesale application page',
    };
    const text = assembleInitialBody({
      observation: 'your wholesale page lists a 6-unit minimum',
      offer,
      prospect,
      cfg,
    });
    return withHeaders(prospect.contactEmail, buildSubject(prospect, offer), text);
  }
});

describe('prepareCampaigns', () => {
  it('creates a READY campaign with honest landing copy and drafts batch 1', async () => {
    const ctx = await freshDb(env({ INITIAL_EMAIL_BATCH: '3' }));
    const { results } = await prepared(ctx, 5);

    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result?.campaignId).toBeTruthy();
    expect(result?.drafted).toBe(3);

    const campaign = await ctx.db.query<{ state: string; landing_copy_json: unknown; price_monthly: string }>(
      'SELECT state, landing_copy_json, price_monthly FROM campaigns',
    );
    expect(campaign.rows[0]?.state).toBe('READY');
    const copy = campaign.rows[0]?.landing_copy_json as Record<string, unknown>;
    expect(copy.buildStatus).toBe('BEING_VALIDATED_NOT_BUILT');
    expect(copy.cta).toBe('Join the pilot at $19/month');
    expect(String(copy.validationDisclosure)).toMatch(/does not exist yet/i);
    expect(Array.isArray(copy.capabilities)).toBe(true);

    // Drafted, never sent.
    expect(ctx.email.sent).toHaveLength(0);
    expect(await messageStatuses(ctx.db)).toEqual({ DRAFTED: 3 });
  });

  it('is idempotent — a second run drafts nothing new', async () => {
    const ctx = await freshDb(env({ INITIAL_EMAIL_BATCH: '2' }));
    await prepared(ctx, 2);
    const second = await prepareCampaigns(5);
    expect(second[0]?.drafted).toBe(0);
    const campaigns = await ctx.db.query('SELECT id FROM campaigns');
    expect(campaigns.rowCount).toBe(1);
  });

  it('respects MAX_NEW_CAMPAIGNS_PER_WEEK', async () => {
    const ctx = await freshDb(env({ MAX_NEW_CAMPAIGNS_PER_WEEK: '1', INITIAL_EMAIL_BATCH: '1' }));
    const first = await seedOpportunity(ctx.db);
    const second = await seedOpportunity(ctx.db);
    await seedProspects(ctx.db, first, 1);
    await seedProspects(ctx.db, second, 1);

    const results = await prepareCampaigns(5);
    expect(results.filter((r) => r.campaignId !== null)).toHaveLength(1);
    expect(results.some((r) => r.skipped === 'CAMPAIGNS_WEEKLY_BUDGET')).toBe(true);
  });
});

describe('sendDueMessages', () => {
  it('never sends the same message twice', async () => {
    const ctx = await freshDb(env({ INITIAL_EMAIL_BATCH: '3' }));
    await prepared(ctx, 3);

    const first = await sendDueMessages();
    expect(first[0]?.sent).toBe(3);
    expect(ctx.email.sent).toHaveLength(3);

    const second = await sendDueMessages();
    expect(second[0]?.sent).toBe(0);
    expect(ctx.email.sent).toHaveLength(3);

    const recipients = ctx.email.sent.map((e) => e.to);
    expect(new Set(recipients).size).toBe(3);
    expect(await messageStatuses(ctx.db)).toEqual({ SENT: 3 });
  });

  it('honours the batch size even when more drafts exist', async () => {
    const ctx = await freshDb(env({ INITIAL_EMAIL_BATCH: '5' }));
    await prepared(ctx, 5);
    setEnv({ INITIAL_EMAIL_BATCH: '2' });

    const results = await sendDueMessages();
    expect(results[0]?.sent).toBe(2);
    expect(ctx.email.sent).toHaveLength(2);
    expect(await messageStatuses(ctx.db)).toEqual({ SENT: 2, DRAFTED: 3 });
  });

  it('never exceeds MAX_EMAILS_PER_DAY', async () => {
    const ctx = await freshDb(env({ INITIAL_EMAIL_BATCH: '5' }));
    await prepared(ctx, 5);
    setEnv({ MAX_EMAILS_PER_DAY: '2' });

    const results = await sendDueMessages();
    expect(results[0]?.sent).toBe(2);
    expect(ctx.email.sent).toHaveLength(2);

    // A second run on the same day must not top up past the cap.
    const again = await sendDueMessages();
    expect(again[0]?.sent).toBe(0);
    expect(ctx.email.sent).toHaveLength(2);
  });

  it('refuses to send outside the sending window', async () => {
    const ctx = await freshDb(env({ INITIAL_EMAIL_BATCH: '2' }));
    await prepared(ctx, 2);
    setEnv({ SENDING_WINDOW_START_HOUR: '0', SENDING_WINDOW_END_HOUR: '0' });

    const results = await sendDueMessages();
    expect(results[0]?.haltedReason).toBe('OUTSIDE_SENDING_WINDOW');
    expect(results[0]?.sent).toBe(0);
    expect(ctx.email.sent).toHaveLength(0);
    expect(await messageStatuses(ctx.db)).toEqual({ DRAFTED: 2 });
  });

  it('refuses to send at the weekend when SENDING_WEEKDAYS_ONLY is set', async () => {
    const ctx = await freshDb(env({ INITIAL_EMAIL_BATCH: '2' }));
    await prepared(ctx, 2);
    setEnv({ SENDING_WEEKDAYS_ONLY: 'true' });

    // 2024-01-06T15:00Z is a Saturday morning in America/New_York.
    const saturday = sendingWindowStatus(new Date('2024-01-06T15:00:00Z'));
    expect(saturday.weekday).toBe('Sat');
    expect(saturday.ok).toBe(false);
    expect(saturday.reason).toBe('WEEKEND');

    // 2024-01-08T15:00Z is the Monday after, inside a 0-24 window.
    expect(sendingWindowStatus(new Date('2024-01-08T15:00:00Z')).ok).toBe(true);
  });

  it('fails closed on an unusable timezone', async () => {
    await freshDb(env({ SENDING_TIMEZONE: 'Not/AZone' }));
    const status = sendingWindowStatus(new Date());
    expect(status.ok).toBe(false);
    expect(status.reason).toBe('INVALID_SENDING_TIMEZONE');
  });

  it('SHADOW MODE: produces complete drafts and sends absolutely nothing', async () => {
    const ctx = await freshDb(env({ AUTONOMY_ENABLED: 'false', OUTREACH_ENABLED: 'false', INITIAL_EMAIL_BATCH: '3' }));
    const { results } = await prepared(ctx, 3);
    expect(results[0]?.drafted).toBe(3);

    const sends = await sendDueMessages();
    expect(sends[0]?.haltedReason).toBe('SHADOW_MODE');
    expect(sends[0]?.simulated).toBe(true);
    expect(sends[0]?.attempted).toBe(3);
    expect(sends[0]?.sent).toBe(0);
    expect(ctx.email.sent).toHaveLength(0);

    const drafts = await ctx.db.query<{ status: string; body: string; subject: string }>(
      'SELECT status, body, subject FROM messages',
    );
    expect(drafts.rowCount).toBe(3);
    for (const row of drafts.rows) {
      expect(row.status).toBe('DRAFTED');
      expect(row.subject.length).toBeGreaterThan(5);
      expect(row.body).toContain('55 Test Street, Boston MA 02118');
      expect(row.body).toContain('/api/unsubscribe?t=');
    }
  });

  it('moves the campaign through batch 1 -> review and the opportunity to VALIDATING', async () => {
    const ctx = await freshDb(env({ INITIAL_EMAIL_BATCH: '2' }));
    const { opportunityId } = await prepared(ctx, 2);
    await sendDueMessages();

    const campaign = await ctx.db.query<{ state: string }>('SELECT state FROM campaigns');
    expect(campaign.rows[0]?.state).toBe('BATCH_1_REVIEW');
    const opp = await ctx.db.query<{ state: string }>('SELECT state FROM opportunities WHERE id = $1', [opportunityId]);
    expect(opp.rows[0]?.state).toBe('VALIDATING');
  });

  it('computes cumulative batch targets from configuration', async () => {
    await freshDb(env());
    const cfg = getConfig();
    expect(cumulativeTargetForState('BATCH_1', cfg)).toBe(25);
    expect(cumulativeTargetForState('BATCH_2', cfg)).toBe(75);
    expect(cumulativeTargetForState('SCALING', cfg)).toBe(150);
  });
});

describe('scheduleFollowups', () => {
  async function seedDelivered(ctx: TestContext, daysAgo: number) {
    const opportunityId = await seedOpportunity(ctx.db);
    await seedProspects(ctx.db, opportunityId, 1);
    await prepareCampaigns(1);
    await sendDueMessages();
    await ctx.db.query(
      `UPDATE messages
          SET status = 'DELIVERED', delivered_at = now() - ($1::int * interval '1 day')
        WHERE sequence_step = 0`,
      [daysAgo],
    );
    const campaign = await ctx.db.query<{ id: string }>('SELECT id FROM campaigns');
    const prospect = await ctx.db.query<{ id: string }>('SELECT id FROM prospects');
    return { campaignId: campaign.rows[0]?.id ?? '', prospectId: prospect.rows[0]?.id ?? '' };
  }

  it('queues follow-up 1 only after the configured delay', async () => {
    const ctx = await freshDb(env({ INITIAL_EMAIL_BATCH: '1' }));
    await seedDelivered(ctx, 2);
    expect(await scheduleFollowups()).toEqual({ queued: 0 });

    await ctx.db.query(`UPDATE messages SET delivered_at = now() - interval '5 days' WHERE sequence_step = 0`);
    expect(await scheduleFollowups()).toEqual({ queued: 1 });

    // Idempotent.
    expect(await scheduleFollowups()).toEqual({ queued: 0 });
  });

  it('stops the sequence as soon as they reply', async () => {
    const ctx = await freshDb(env({ INITIAL_EMAIL_BATCH: '1' }));
    const { campaignId, prospectId } = await seedDelivered(ctx, 5);
    await ctx.db.query(
      `INSERT INTO messages (id, campaign_id, prospect_id, direction, sequence_step, status, received_at, idempotency_key)
       VALUES ($1,$2,$3,'INBOUND',-1,'RECEIVED', now(), $4)`,
      [newId('msg'), campaignId, prospectId, `inbound:${newId('x')}`],
    );
    expect(await scheduleFollowups()).toEqual({ queued: 0 });
  });

  it('stops after two follow-ups no matter what MAX_FOLLOWUPS says', async () => {
    const ctx = await freshDb(env({ INITIAL_EMAIL_BATCH: '1', MAX_FOLLOWUPS: '9' }));
    const { campaignId, prospectId } = await seedDelivered(ctx, 30);

    // Follow-up 1 was sent and delivered long ago.
    await scheduleFollowups();
    await ctx.db.query(
      `UPDATE messages SET status = 'DELIVERED', sent_at = now() - interval '20 days',
              delivered_at = now() - interval '20 days'
        WHERE campaign_id = $1 AND prospect_id = $2 AND sequence_step = 1`,
      [campaignId, prospectId],
    );

    await scheduleFollowups();
    await ctx.db.query(
      `UPDATE messages SET status = 'DELIVERED', sent_at = now() - interval '10 days',
              delivered_at = now() - interval '10 days'
        WHERE campaign_id = $1 AND prospect_id = $2 AND sequence_step = 2`,
      [campaignId, prospectId],
    );

    // Nothing further is ever queued.
    expect(await scheduleFollowups()).toEqual({ queued: 0 });
    const steps = await ctx.db.query<{ sequence_step: number }>(
      'SELECT sequence_step FROM messages WHERE direction = $1 ORDER BY sequence_step',
      ['OUTBOUND'],
    );
    expect(steps.rows.map((r) => Number(r.sequence_step))).toEqual([0, 1, 2]);
    expect(MAX_SEQUENCE_FOLLOWUPS).toBe(2);
  });

  it('never follows up a suppressed prospect', async () => {
    const ctx = await freshDb(env({ INITIAL_EMAIL_BATCH: '1' }));
    await seedDelivered(ctx, 10);
    await ctx.db.query(`UPDATE prospects SET status = 'SUPPRESSED', suppressed_at = now()`);
    expect(await scheduleFollowups()).toEqual({ queued: 0 });
  });
});

// --- auto-reply flush (added at integration) ---------------------------------

describe('pending auto-replies are eventually flushed', () => {
  /**
   * Builds the draft through the real footer builder rather than hand-writing
   * a body — a hand-written one is (correctly) refused by the compliance gate
   * for missing the sender identity and unsubscribe link.
   */
  async function draftAutoReply(db: Db, campaignId: string, prospectId: string, key: string) {
    const id = `msg_auto_${key}`;
    const row = await db.query<{ contact_email: string }>(
      'SELECT contact_email FROM prospects WHERE id = $1',
      [prospectId],
    );
    const to = row.rows[0]!.contact_email;
    const body =
      'Great — we are validating the first pilot at $19/month.\n' +
      'If you would like one of the first installs, reserve it here:\n' +
      'https://validator.example/v/slug\n' +
      buildFooter(to, getConfig(), null);
    await db.query(
      `INSERT INTO messages
         (id, campaign_id, prospect_id, direction, sequence_step, subject, body,
          status, idempotency_key, thread_id)
       VALUES ($1,$2,$3,'OUTBOUND',-1,'Minimum Order Rules',$4,'DRAFTED',$5,$6)`,
      [id, campaignId, prospectId, body, key, id],
    );
    return id;
  }

  /** A campaign whose batch quota is already used up, so only the auto-reply is eligible. */
  async function seedRepliedProspect(db: Db) {
    const oppId = await seedOpportunity(db, 'VALIDATING');
    const [prospectId] = await seedProspects(db, oppId, 1);
    const campaignId = newId('cmp');
    await db.query(
      `INSERT INTO campaigns (id, opportunity_id, state, offer_name, price_monthly,
                              landing_slug, target_count, started_at)
       VALUES ($1,$2,'COMPLETE','Minimum Order Rules',19,$3,150, now())`,
      [campaignId, oppId, `slug-${campaignId}`],
    );
    await db.query(`UPDATE prospects SET status = 'REPLIED' WHERE id = $1`, [prospectId]);
    return { campaignId, prospectId: prospectId as string };
  }

  it('sends an auto-reply that sendDueMessages deliberately ignores', async () => {
    const ctx = await freshDb(env());
    const { campaignId, prospectId } = await seedRepliedProspect(ctx.db);
    await draftAutoReply(ctx.db, campaignId, prospectId, 'k1');

    // Campaign is COMPLETE, and step < 0 is filtered out regardless.
    await sendDueMessages();
    expect(ctx.email.sent).toHaveLength(0);

    const res = await flushPendingAutoReplies();
    expect(res.sent).toBe(1);
    expect(ctx.email.sent).toHaveLength(1);
  });

  it('is idempotent — a flushed reply is never sent twice', async () => {
    const ctx = await freshDb(env());
    const { campaignId, prospectId } = await seedRepliedProspect(ctx.db);
    await draftAutoReply(ctx.db, campaignId, prospectId, 'k2');

    await flushPendingAutoReplies();
    await flushPendingAutoReplies();
    expect(ctx.email.sent).toHaveLength(1);
  });

  it('sends nothing in shadow mode', async () => {
    const ctx = await freshDb(env({ AUTONOMY_ENABLED: 'false', OUTREACH_ENABLED: 'false' }));
    const { campaignId, prospectId } = await seedRepliedProspect(ctx.db);
    await draftAutoReply(ctx.db, campaignId, prospectId, 'k3');

    const res = await flushPendingAutoReplies();
    expect(res.sent).toBe(0);
    expect(ctx.email.sent).toHaveLength(0);
  });

  it('respects the daily cap and leaves the rest for the next run', async () => {
    const ctx = await freshDb(env({ MAX_EMAILS_PER_DAY: '1' }));
    const { campaignId, prospectId } = await seedRepliedProspect(ctx.db);
    await draftAutoReply(ctx.db, campaignId, prospectId, 'k4');
    await draftAutoReply(ctx.db, campaignId, prospectId, 'k5');

    const res = await flushPendingAutoReplies();
    expect(res.sent).toBe(1);
    expect(ctx.email.sent).toHaveLength(1);

    const stillDrafted = await ctx.db.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM messages WHERE status = 'DRAFTED' AND sequence_step < 0`,
    );
    expect(Number(stillDrafted.rows[0]?.n)).toBe(1);
  });
});
