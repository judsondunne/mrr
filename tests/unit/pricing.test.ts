/**
 * Price experiments.
 *
 * Two things must be true or the whole exercise is worthless:
 *   - a prospect sees ONE price, permanently;
 *   - the winner is chosen on MONEY, not on conversion rate.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { freshDb, teardown, insertOpportunity, insertCampaign, insertProspect } from '../helpers';
import { resetConfigCache } from '../../src/lib/config';
import type { Db } from '../../src/lib/db';
import {
  assignPrice,
  bestPrice,
  ensurePriceExperiments,
  expectedMrrPer100,
  getAssignedPrice,
  priceArms,
} from '../../src/autonomy/pricing';
import { loadOfferForProspect } from '../../src/pipeline/outreach/offer';

const ORIGINAL_ENV = { ...process.env };

const BASE_ENV: Record<string, string> = {
  AUTONOMY_ENABLED: 'true',
  OUTREACH_ENABLED: 'true',
  PUBLIC_BASE_URL: 'https://validator.example',
  UNSUBSCRIBE_SECRET: 'unsubscribe-secret-used-only-by-tests',
  SENDER_COMPANY: 'Example Labs LLC',
  SENDER_EMAIL: 'founder@validator.example',
  SENDER_POSTAL_ADDRESS: '55 Test Street, Boston MA 02118',
  MIN_DELIVERED_FOR_VARIANT_COMPARISON: '40',
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

async function seedCampaign(db: Db, price = 19): Promise<{ opportunityId: string; campaignId: string }> {
  const opportunityId = await insertOpportunity(db, { state: 'VALIDATING' });
  const campaignId = await insertCampaign(db, opportunityId, { state: 'BATCH_1', price });
  return { opportunityId, campaignId };
}

/**
 * One arm's worth of real rows: `count` prospects assigned to `price`, each
 * with a delivered message, and `commitments` of them having committed.
 * Bulk-inserted with generate_series so the sample can be realistic.
 */
async function seedArm(
  db: Db,
  params: {
    opportunityId: string;
    campaignId: string;
    tag: string;
    price: number;
    count: number;
    commitments: number;
  },
): Promise<void> {
  const { opportunityId, campaignId, tag, price, count, commitments } = params;
  await db.query(
    `INSERT INTO prospects
       (id, opportunity_id, company_name, domain, ecosystem, status, contact_email,
        email_is_public, country, qualification_reason)
     SELECT 'pr_' || $2 || '_' || i, $1, 'Company ' || i,
            $2 || i || '.example.com', 'shopify', 'CONTACTED',
            'hello@' || $2 || i || '.example.com', true, 'US', 'test fixture'
       FROM generate_series(1, $3::int) AS i`,
    [opportunityId, tag, count],
  );
  await db.query(
    `INSERT INTO price_assignments (id, campaign_id, prospect_id, price_monthly)
     SELECT 'pa_' || $2 || '_' || i, $1, 'pr_' || $2 || '_' || i, $4
       FROM generate_series(1, $3::int) AS i`,
    [campaignId, tag, count, price],
  );
  await db.query(
    `INSERT INTO messages
       (id, campaign_id, prospect_id, direction, sequence_step, subject, body,
        sent_at, delivered_at, status, idempotency_key)
     SELECT 'msg_' || $2 || '_' || i, $1, 'pr_' || $2 || '_' || i, 'OUTBOUND', 0, 's', 'b',
            now(), now(), 'DELIVERED', $1 || ':pr_' || $2 || '_' || i || ':0'
       FROM generate_series(1, $3::int) AS i`,
    [campaignId, tag, count],
  );
  if (commitments > 0) {
    await db.query(
      `INSERT INTO commitments
         (id, campaign_id, prospect_id, company_key, type, price_monthly, source,
          evidence_text, verified, dedupe_key)
       SELECT 'cmt_' || $2 || '_' || i, $1, 'pr_' || $2 || '_' || i,
              $2 || i || '.example.com', 'PILOT_SIGNUP', $4, 'LANDING_FORM',
              'reserved a pilot spot', true,
              $1 || ':' || $2 || i || '.example.com:PILOT_SIGNUP'
         FROM generate_series(1, $3::int) AS i`,
      [campaignId, tag, commitments, price],
    );
  }
}

// ---------------------------------------------------------------------------

describe('expectedMrrPer100', () => {
  it('is (commitments / delivered) * 100 * price', () => {
    expect(expectedMrrPer100({ delivered: 100, commitments: 12, priceMonthly: 9 })).toBe(108);
    expect(expectedMrrPer100({ delivered: 100, commitments: 7, priceMonthly: 29 })).toBe(203);
    expect(expectedMrrPer100({ delivered: 50, commitments: 5, priceMonthly: 19 })).toBe(190);
  });

  it('never divides by zero', () => {
    expect(expectedMrrPer100({ delivered: 0, commitments: 0, priceMonthly: 19 })).toBe(0);
    expect(expectedMrrPer100({ delivered: 0, commitments: 2, priceMonthly: 10 })).toBe(200);
  });
});

describe('price assignment is permanent', () => {
  it('returns the same price on every call', async () => {
    const ctx = await freshDb(env());
    const { opportunityId, campaignId } = await seedCampaign(ctx.db);
    const prospectId = await insertProspect(ctx.db, opportunityId);
    await ensurePriceExperiments(campaignId, [9, 29]);

    const first = await assignPrice({ campaignId, prospectId });
    for (let i = 0; i < 5; i += 1) {
      expect(await assignPrice({ campaignId, prospectId })).toBe(first);
    }
    expect(await getAssignedPrice({ campaignId, prospectId })).toBe(first);

    const rows = await ctx.db.query('SELECT id FROM price_assignments WHERE prospect_id = $1', [prospectId]);
    expect(rows.rowCount).toBe(1);
  });

  it('survives a reply: the offer the reply path loads quotes the SAME price', async () => {
    const ctx = await freshDb(env());
    const { opportunityId, campaignId } = await seedCampaign(ctx.db, 19);
    await ctx.db.query(`UPDATE campaigns SET landing_copy_json = $2 WHERE id = $1`, [
      campaignId,
      JSON.stringify(LANDING_COPY),
    ]);
    const prospectId = await insertProspect(ctx.db, opportunityId);

    // A single-arm experiment at a price that is NOT the campaign default.
    await ensurePriceExperiments(campaignId, [29]);
    expect(await assignPrice({ campaignId, prospectId })).toBe(29);

    const offer = await loadOfferForProspect(campaignId, prospectId);
    expect(offer?.priceMonthly).toBe(29);
    // Every price-bearing sentence moved with it — no $19 left anywhere.
    expect(offer?.copy.cta).toBe('Join the pilot at $29/month');
    expect(offer?.copy.validationDisclosure).toContain('$29/month');
    expect(JSON.stringify(offer?.copy)).not.toContain('$19');
  });

  it('balances arms deterministically', async () => {
    const ctx = await freshDb(env());
    const { opportunityId, campaignId } = await seedCampaign(ctx.db);
    await ensurePriceExperiments(campaignId, [9, 29]);

    const assigned: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const prospectId = await insertProspect(ctx.db, opportunityId, { domain: `store-${i}.example.com` });
      assigned.push(await assignPrice({ campaignId, prospectId }));
    }
    expect(assigned.filter((p) => p === 9)).toHaveLength(2);
    expect(assigned.filter((p) => p === 29)).toHaveLength(2);
  });

  it('falls back to the campaign price when no experiment is running', async () => {
    const ctx = await freshDb(env());
    const { opportunityId, campaignId } = await seedCampaign(ctx.db, 19);
    const prospectId = await insertProspect(ctx.db, opportunityId);
    expect(await getAssignedPrice({ campaignId, prospectId })).toBeNull();
    expect(await assignPrice({ campaignId, prospectId })).toBe(19);
    expect(await getAssignedPrice({ campaignId, prospectId })).toBe(19);
  });
});

describe('bestPrice', () => {
  it('returns null until EVERY arm has a sufficient sample', async () => {
    const ctx = await freshDb(env({ MIN_DELIVERED_FOR_VARIANT_COMPARISON: '40' }));
    const { opportunityId, campaignId } = await seedCampaign(ctx.db);
    await ensurePriceExperiments(campaignId, [9, 29]);

    // Declared but untouched: no data at all.
    expect(await bestPrice(campaignId)).toBeNull();

    // One arm well sampled, the other barely. Still no verdict, because a
    // comparison against 5 data points is not a comparison.
    await seedArm(ctx.db, { opportunityId, campaignId, tag: 'a', price: 9, count: 100, commitments: 12 });
    await seedArm(ctx.db, { opportunityId, campaignId, tag: 'b', price: 29, count: 5, commitments: 1 });

    const arms = await priceArms(campaignId);
    expect(arms.find((a) => a.priceMonthly === 9)?.hasSufficientSample).toBe(true);
    expect(arms.find((a) => a.priceMonthly === 29)?.hasSufficientSample).toBe(false);
    expect(await bestPrice(campaignId)).toBeNull();
  });

  it('prefers $29 x 7 over $9 x 12 — expected MRR, not conversion rate', async () => {
    const ctx = await freshDb(env({ MIN_DELIVERED_FOR_VARIANT_COMPARISON: '40' }));
    const { opportunityId, campaignId } = await seedCampaign(ctx.db);
    await ensurePriceExperiments(campaignId, [9, 29]);

    // $9  -> 12 of 100 committed = 12% conversion, $108 per 100 delivered.
    // $29 ->  7 of 100 committed =  7% conversion, $203 per 100 delivered.
    await seedArm(ctx.db, { opportunityId, campaignId, tag: 'cheap', price: 9, count: 100, commitments: 12 });
    await seedArm(ctx.db, { opportunityId, campaignId, tag: 'dear', price: 29, count: 100, commitments: 7 });

    const arms = await priceArms(campaignId);
    const cheap = arms.find((a) => a.priceMonthly === 9)!;
    const dear = arms.find((a) => a.priceMonthly === 29)!;

    expect(cheap.delivered).toBe(100);
    expect(cheap.commitments).toBe(12);
    expect(cheap.expectedMrrPer100).toBe(108);
    expect(dear.delivered).toBe(100);
    expect(dear.commitments).toBe(7);
    expect(dear.expectedMrrPer100).toBe(203);

    // The cheaper price converts better. It is still the wrong price.
    expect(cheap.commitments / cheap.delivered).toBeGreaterThan(dear.commitments / dear.delivered);

    const winner = await bestPrice(campaignId);
    expect(winner?.priceMonthly).toBe(29);
    expect(winner?.expectedMrrPer100).toBe(203);
  });

  it('persists the decision metric onto the experiment rows', async () => {
    const ctx = await freshDb(env({ MIN_DELIVERED_FOR_VARIANT_COMPARISON: '40' }));
    const { opportunityId, campaignId } = await seedCampaign(ctx.db);
    await ensurePriceExperiments(campaignId, [9, 29]);
    await seedArm(ctx.db, { opportunityId, campaignId, tag: 'cheap', price: 9, count: 100, commitments: 12 });
    await seedArm(ctx.db, { opportunityId, campaignId, tag: 'dear', price: 29, count: 100, commitments: 7 });
    await priceArms(campaignId);

    const rows = await ctx.db.query<{ price_monthly: string; expected_mrr_per_100: string }>(
      'SELECT price_monthly, expected_mrr_per_100 FROM pricing_experiments WHERE campaign_id = $1 ORDER BY price_monthly',
      [campaignId],
    );
    expect(rows.rows.map((r) => Number(r.expected_mrr_per_100))).toEqual([108, 203]);
  });
});

describe('ensurePriceExperiments', () => {
  it('is idempotent and rejects nonsense prices', async () => {
    const ctx = await freshDb(env());
    const { campaignId } = await seedCampaign(ctx.db);
    await ensurePriceExperiments(campaignId, [9, 29, 29, 0, -5, Number.NaN]);
    await ensurePriceExperiments(campaignId, [9, 29]);
    const rows = await ctx.db.query<{ price_monthly: string }>(
      'SELECT price_monthly FROM pricing_experiments WHERE campaign_id = $1 ORDER BY price_monthly',
      [campaignId],
    );
    expect(rows.rows.map((r) => Number(r.price_monthly))).toEqual([9, 29]);
  });

  it('does nothing for an unknown campaign', async () => {
    await freshDb(env());
    expect(await ensurePriceExperiments('cmp_nope', [9])).toEqual([]);
  });
});

const LANDING_COPY = {
  productName: 'Minimum Order Rules',
  outcome: 'keep wholesale orders under your minimum out of checkout',
  capabilities: ['per-customer minimum order values', 'collection-level minimums', 'clear cart messaging'],
  priceMonthly: 19,
  whoItIsFor: 'Shopify stores with a wholesale channel',
  workflow: 'enforcing minimum order quantities at checkout',
  incumbentComplexity: 'the full B2B rebuild the incumbent requires',
  earlyAccess: 'Early access: the first pilot installs go to stores that join now, at $19/month.',
  buildStatus: 'BEING_VALIDATED_NOT_BUILT',
  validationDisclosure:
    'This Shopify app does not exist yet. It is being validated before it is built: ' +
    'if enough stores want it at $19/month I build it and pilot stores get the first install. ' +
    'Nothing is charged today.',
  cta: 'Join the pilot at $19/month',
  ecosystem: 'Shopify',
};
