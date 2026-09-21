/**
 * Deliverability: the per-campaign ramp and the per-domain warm-up.
 *
 * These tests exist to fail loudly if volume ever stops being EARNED — if a
 * campaign can jump a ramp step on an unhealthy batch, if a brand-new sending
 * domain can send more than its warm-up day allows, or if a paused domain can
 * be un-paused by anything other than the cooldown elapsing AND the metrics
 * recovering.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { freshDb, teardown, insertOpportunity, insertCampaign, insertProspect } from '../helpers';
import { resetConfigCache } from '../../src/lib/config';
import { newId } from '../../src/lib/hash';
import type { Db } from '../../src/lib/db';
import {
  campaignRampCap,
  domainDailyCap,
  evaluateDeliverability,
  getSendAllowance,
  isSendingPaused,
  maybeAdvanceRamp,
  measureDeliverability,
  pauseSending,
  recordFirstSend,
  resumeSendingIfRecovered,
  warmupCapFor,
  warmupDayFor,
} from '../../src/autonomy/deliverability';
import { sendDueMessages } from '../../src/pipeline/outreach/send';
import { prepareCampaigns } from '../../src/pipeline/outreach/campaign';

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
  MAX_EMAILS_PER_CAMPAIGN: '150',
  INITIAL_EMAIL_BATCH: '25',
  SECOND_EMAIL_BATCH: '50',
  MAX_HARD_BOUNCE_RATE: '0.05',
  MAX_COMPLAINT_RATE: '0',
  MAX_UNSUBSCRIBE_RATE: '0.05',
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

/** N outbound messages that the provider accepted and delivered. */
async function seedAttempted(
  db: Db,
  campaignId: string,
  prospectId: string,
  count: number,
  overrides: { complained?: number; hardBounced?: number } = {},
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const id = newId('msg');
    const complained = i < (overrides.complained ?? 0);
    const bounced = !complained && i < (overrides.complained ?? 0) + (overrides.hardBounced ?? 0);
    await db.query(
      `INSERT INTO messages
         (id, campaign_id, prospect_id, direction, sequence_step, subject, body,
          sent_at, delivered_at, status, bounce_type, complained_at, idempotency_key)
       VALUES ($1,$2,$3,'OUTBOUND',0,'s','b', now(), now(), $4, $5, $6, $7)`,
      [
        id,
        campaignId,
        prospectId,
        complained ? 'COMPLAINED' : bounced ? 'BOUNCED' : 'DELIVERED',
        bounced ? 'HARD' : null,
        complained ? new Date().toISOString() : null,
        `seed:${id}`,
      ],
    );
  }
}

async function seedCampaign(db: Db, state = 'BATCH_1'): Promise<{ campaignId: string; prospectId: string }> {
  const opportunityId = await insertOpportunity(db, { state: 'VALIDATING' });
  const campaignId = await insertCampaign(db, opportunityId, { state });
  const prospectId = await insertProspect(db, opportunityId);
  return { campaignId, prospectId };
}

// ---------------------------------------------------------------------------

describe('per-campaign ramp', () => {
  it('is the configured cumulative 10 -> 25 -> 50 -> 75', async () => {
    await freshDb(env());
    expect(campaignRampCap(0)).toBe(10);
    expect(campaignRampCap(1)).toBe(25);
    expect(campaignRampCap(2)).toBe(50);
    expect(campaignRampCap(3)).toBe(75);
    // Past the end of the schedule the ceiling stops rising. 75 is the top,
    // not 150 — a campaign never "jumps" to the campaign maximum.
    expect(campaignRampCap(4)).toBe(75);
    expect(campaignRampCap(-1)).toBe(10);
  });

  it('honours a reconfigured ramp and never exceeds MAX_EMAILS_PER_CAMPAIGN', async () => {
    await freshDb(env({ CAMPAIGN_RAMP_STEPS: '5,40,900', MAX_EMAILS_PER_CAMPAIGN: '60' }));
    expect(campaignRampCap(0)).toBe(5);
    expect(campaignRampCap(1)).toBe(40);
    expect(campaignRampCap(2)).toBe(60);
  });

  it('advances exactly one step per healthy completed batch', async () => {
    const ctx = await freshDb(env());
    const { campaignId, prospectId } = await seedCampaign(ctx.db);

    // Nothing sent: there is no previous batch to have been healthy.
    expect(await maybeAdvanceRamp(campaignId)).toEqual({
      advanced: false,
      rampStep: 0,
      reason: 'NO_BATCH_YET',
    });

    // Batch under way but not finished: still not earned.
    await seedAttempted(ctx.db, campaignId, prospectId, 4);
    expect((await maybeAdvanceRamp(campaignId)).reason).toBe('BATCH_IN_PROGRESS');

    // Step 0's cumulative ceiling of 10 reached, cleanly.
    await seedAttempted(ctx.db, campaignId, prospectId, 6);
    expect(await maybeAdvanceRamp(campaignId)).toEqual({
      advanced: true,
      rampStep: 1,
      reason: 'HEALTHY_BATCH',
    });
    expect(campaignRampCap(1)).toBe(25);

    // One step per call, never two.
    expect((await maybeAdvanceRamp(campaignId)).advanced).toBe(false);

    await seedAttempted(ctx.db, campaignId, prospectId, 15);
    expect(await maybeAdvanceRamp(campaignId)).toMatchObject({ advanced: true, rampStep: 2 });
  });

  it('does NOT advance on an unhealthy batch', async () => {
    const ctx = await freshDb(env());
    const { campaignId, prospectId } = await seedCampaign(ctx.db);

    // 10 attempted, one of them a spam complaint. MAX_COMPLAINT_RATE is 0.
    await seedAttempted(ctx.db, campaignId, prospectId, 10, { complained: 1 });

    const result = await maybeAdvanceRamp(campaignId);
    expect(result.advanced).toBe(false);
    expect(result.rampStep).toBe(0);
    expect(result.reason).toMatch(/^UNHEALTHY:/);
    expect(result.reason).toMatch(/complaint rate/i);

    const row = await ctx.db.query<{ ramp_step: number }>('SELECT ramp_step FROM campaigns WHERE id = $1', [
      campaignId,
    ]);
    expect(Number(row.rows[0]?.ramp_step)).toBe(0);
  });
});

describe('per-domain warm-up', () => {
  it('caps a brand-new sending domain at 10/day', async () => {
    await freshDb(env());
    // No first send recorded at all: day 1.
    expect(await domainDailyCap()).toEqual({ cap: 10, warmupDay: 1 });

    await recordFirstSend();
    expect(await domainDailyCap()).toEqual({ cap: 10, warmupDay: 1 });
  });

  it('follows the configured schedule and then falls back to the daily cap', async () => {
    await freshDb(env());
    expect(warmupDayFor(null)).toBe(1);
    // Default schedule: <=day2 10/day, <=day4 20/day, <=day7 35/day.
    expect(warmupCapFor(1)).toBe(10);
    expect(warmupCapFor(2)).toBe(10);
    expect(warmupCapFor(3)).toBe(20);
    expect(warmupCapFor(5)).toBe(35);
    expect(warmupCapFor(8)).toBe(75);
  });

  it('advances the warm-up day from first_send_at', async () => {
    const ctx = await freshDb(env());
    await recordFirstSend();
    await ctx.db.query(`UPDATE sending_reputation SET first_send_at = now() - interval '5 days' WHERE id = 1`);
    const cap = await domainDailyCap();
    expect(cap.warmupDay).toBe(6);
    expect(cap.cap).toBe(75); // past the end of the schedule
  });
});

describe('getSendAllowance is the MINIMUM of every limit', () => {
  it('lets the domain warm-up bind when it is the smallest', async () => {
    const ctx = await freshDb(env({ CAMPAIGN_RAMP_STEPS: '25,50' }));
    const { campaignId } = await seedCampaign(ctx.db);

    const allowance = await getSendAllowance(campaignId);
    expect(allowance.campaignCap).toBe(25);
    expect(allowance.domainCapToday).toBe(10);
    expect(allowance.warmupDay).toBe(1);
    // 10 (domain) < 25 (ramp) < 75 (daily) < 150 (campaign max).
    expect(allowance.allowed).toBe(10);
    expect(allowance.reason).toBe('DOMAIN_WARMUP');
  });

  it('lets the campaign ramp bind when it is the smallest', async () => {
    const ctx = await freshDb(env({ CAMPAIGN_RAMP_STEPS: '3,25' }));
    const { campaignId } = await seedCampaign(ctx.db);
    const allowance = await getSendAllowance(campaignId);
    expect(allowance.allowed).toBe(3);
    expect(allowance.reason).toBe('CAMPAIGN_RAMP');
  });

  it('lets the existing daily quota bind when it is the smallest', async () => {
    const ctx = await freshDb(env({ CAMPAIGN_RAMP_STEPS: '25,50', MAX_EMAILS_PER_DAY: '2' }));
    const { campaignId } = await seedCampaign(ctx.db);
    const allowance = await getSendAllowance(campaignId);
    expect(allowance.allowed).toBe(2);
  });

  it('counts what has already gone out today against the domain', async () => {
    const ctx = await freshDb(env({ CAMPAIGN_RAMP_STEPS: '25,50' }));
    const { campaignId, prospectId } = await seedCampaign(ctx.db);
    await seedAttempted(ctx.db, campaignId, prospectId, 8);
    const allowance = await getSendAllowance(campaignId);
    expect(allowance.allowed).toBe(2); // 10/day warm-up, 8 already sent
  });

  it('refuses an unknown campaign', async () => {
    await freshDb(env());
    const allowance = await getSendAllowance('cmp_does_not_exist');
    expect(allowance).toMatchObject({ allowed: 0, reason: 'CAMPAIGN_NOT_FOUND' });
  });

  it('stops the real send path at the warm-up ceiling', async () => {
    const ctx = await freshDb(env({ CAMPAIGN_RAMP_STEPS: '25,50', INITIAL_EMAIL_BATCH: '25' }));
    const opportunityId = await insertOpportunity(ctx.db, { state: 'CAMPAIGN_READY' });
    await ctx.db.query(
      `UPDATE opportunities SET wedge_json = $2, proposed_price_monthly = 19 WHERE id = $1`,
      [opportunityId, JSON.stringify(WEDGE)],
    );
    for (let i = 0; i < 14; i += 1) {
      await insertProspect(ctx.db, opportunityId, { domain: `store-${i}-${newId('d')}.example.com` });
    }

    await prepareCampaigns(1);
    const results = await sendDueMessages();

    // The batch target is 25 and 14 drafts exist, but a day-1 domain may only
    // send 10. The MINIMUM wins.
    expect(results[0]?.sent).toBe(10);
    expect(ctx.email.sent).toHaveLength(10);
  });
});

describe('a reputation breach pauses sending, and nothing resumes it early', () => {
  it('pauses on the complaint ceiling and refuses every resume shortcut', async () => {
    const ctx = await freshDb(env());
    const { campaignId, prospectId } = await seedCampaign(ctx.db);
    await seedAttempted(ctx.db, campaignId, prospectId, 5, { complained: 1 });

    const metrics = await measureDeliverability();
    expect(metrics.complained).toBe(1);

    const verdict = await evaluateDeliverability();
    expect(verdict.healthy).toBe(false);
    expect(verdict.shouldPause).toBe(true);
    expect(verdict.reason).toMatch(/complaint rate/i);

    // The pause is persisted where the runtime can read it.
    const stored = await ctx.db.query<{ paused_until: string | null; pause_reason: string | null }>(
      'SELECT paused_until, pause_reason FROM sending_reputation WHERE id = 1',
    );
    expect(stored.rows[0]?.paused_until).toBeTruthy();
    expect(stored.rows[0]?.pause_reason).toMatch(/complaint/i);
    expect((await isSendingPaused()).paused).toBe(true);

    // Allowance collapses to zero for every campaign.
    const allowance = await getSendAllowance(campaignId);
    expect(allowance.allowed).toBe(0);
    expect(allowance.reason).toMatch(/^DELIVERABILITY_PAUSED:/);

    // 1. Cooldown still running => no resume, even though the caller asked.
    expect((await resumeSendingIfRecovered()).resumed).toBe(false);
    expect((await resumeSendingIfRecovered()).reason).toMatch(/^COOLDOWN_ACTIVE_UNTIL:/);

    // 2. Metrics repaired but the cooldown is still running => still no resume.
    await ctx.db.query(`UPDATE messages SET complained_at = NULL, status = 'DELIVERED'`);
    expect((await resumeSendingIfRecovered()).resumed).toBe(false);

    // 3. Cooldown elapsed but the metrics are bad again => still no resume.
    await ctx.db.query(`UPDATE sending_reputation SET paused_until = now() - interval '1 hour' WHERE id = 1`);
    await ctx.db.query(
      `UPDATE messages SET complained_at = now(), status = 'COMPLAINED'
        WHERE id = (SELECT id FROM messages ORDER BY id LIMIT 1)`,
    );
    const stillBad = await resumeSendingIfRecovered();
    expect(stillBad.resumed).toBe(false);
    expect(stillBad.reason).toMatch(/^STILL_UNHEALTHY:/);

    // 4. BOTH conditions met => and only then does it resume.
    await ctx.db.query(`UPDATE messages SET complained_at = NULL, status = 'DELIVERED'`);
    await ctx.db.query(`UPDATE sending_reputation SET paused_until = now() - interval '1 hour' WHERE id = 1`);
    expect(await resumeSendingIfRecovered()).toEqual({ resumed: true, reason: 'RECOVERED' });
    expect((await isSendingPaused()).paused).toBe(false);
  });

  it('sends absolutely nothing while paused', async () => {
    const ctx = await freshDb(env({ INITIAL_EMAIL_BATCH: '3' }));
    const opportunityId = await insertOpportunity(ctx.db, { state: 'CAMPAIGN_READY' });
    await ctx.db.query(
      `UPDATE opportunities SET wedge_json = $2, proposed_price_monthly = 19 WHERE id = $1`,
      [opportunityId, JSON.stringify(WEDGE)],
    );
    await insertProspect(ctx.db, opportunityId, { domain: 'paused-store.example.com' });
    await prepareCampaigns(1);

    await pauseSending('manual test pause');
    expect(await sendDueMessages()).toEqual([]);
    expect(ctx.email.sent).toHaveLength(0);
  });

  it('never shortens an existing pause', async () => {
    const ctx = await freshDb(env({ DELIVERABILITY_PAUSE_COOLDOWN_HOURS: '48' }));
    await pauseSending('first breach');
    const first = await ctx.db.query<{ paused_until: string }>(
      'SELECT paused_until FROM sending_reputation WHERE id = 1',
    );

    process.env.DELIVERABILITY_PAUSE_COOLDOWN_HOURS = '1';
    resetConfigCache();
    await pauseSending('second, milder breach');

    const second = await ctx.db.query<{ paused_until: string }>(
      'SELECT paused_until FROM sending_reputation WHERE id = 1',
    );
    expect(new Date(second.rows[0]!.paused_until).getTime()).toBeGreaterThanOrEqual(
      new Date(first.rows[0]!.paused_until).getTime(),
    );
  });

  it('exposes no AI-reachable override: the module has no unpause', async () => {
    const source = await readFile(join(process.cwd(), 'src', 'autonomy', 'deliverability.ts'), 'utf8');
    // The ONLY exported way back is resumeSendingIfRecovered, which requires
    // the cooldown AND healthy metrics. This is control plane: a model may not
    // ask for an exception, because there is no function to call.
    const exported = [...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]);
    expect(exported).toContain('resumeSendingIfRecovered');
    for (const name of exported) {
      expect(name).not.toMatch(/unpause|clearPause|forceResume|override|ignorePause/i);
    }
    // And no LLM anywhere near the control plane.
    expect(source).not.toMatch(/llmComplete|\/llm(\/|')/);
  });
});

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
