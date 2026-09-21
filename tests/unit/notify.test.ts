/**
 * The owner notification layer.
 *
 * Two properties matter more than everything else in this file:
 *   - the email never contains a promise ("Guaranteed MRR" is unsendable)
 *   - every quotation in it traces back to a row in the database
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  freshDb,
  teardown,
  insertOpportunity,
  insertCampaign,
  insertProspect,
  insertDeliveredMessage,
  insertCommitment,
  treatEmailAsDelivered,
} from '../helpers';
import type { Db } from '../../src/lib/db';
import { newId } from '../../src/lib/hash';
import { SafetyError } from '../../src/lib/errors';
import { evaluateCampaigns } from '../../src/pipeline/validation/evaluate';
import * as notify from '../../src/pipeline/notify/index';
import {
  notifyValidatedOpportunities,
  notifyOwner,
  renderReadyToBuildEmail,
  assertNoGuaranteeLanguage,
} from '../../src/pipeline/notify/index';
import { revenueMathLines, formatMoney } from '../../src/pipeline/notify/render';
import type { MockEmailProvider } from '../../src/lib/email/index';

afterEach(async () => {
  await teardown();
});

const SCALED = {
  MIN_QUALIFIED_PROSPECTS_FOR_GATE: '5',
  MIN_DELIVERED_BEFORE_STANDARD_EVALUATION: '6',
  MIN_UNIQUE_STRONG_COMMITMENTS: '3',
  MIN_UNIQUE_PRICE_ACCEPTANCES: '2',
  MIN_UNIQUE_ACTION_COMMITMENTS: '2',
  MIN_POSITIVE_INTENT_RATE: '0.3',
  INITIAL_EMAIL_BATCH: '5',
  OWNER_NOTIFICATION_EMAIL: 'owner@example.com',
  PUBLIC_BASE_URL: 'https://mrr.example.com',
};

const WEDGE = {
  productName: 'Wholesale Minimums',
  statement: 'For Shopify B2B merchants, enforce per-customer order minimums without a developer.',
  coreWorkflow: 'Merchant sets a minimum per customer group; checkout blocks orders below it.',
  v1Features: [
    'Per-customer-group minimum order value',
    'Checkout-time enforcement with a clear message',
    'CSV import of customer groups',
    'Audit log of blocked checkouts',
  ],
  excludedFromV1: ['Multi-currency minimums', 'Theme editor integration'],
  proposedPriceMonthly: 19,
  estimatedBuildDays: 5,
  primaryCompetitor: 'BigMinimums',
  reasonSomeoneWouldSwitch: 'The incumbent cannot express per-group minimums.',
  oneSentenceOutcome: 'Wholesale orders below a merchant-set minimum stop reaching fulfilment.',
  whoItIsFor: 'Shopify B2B merchants with wholesale customers',
};

const COMMITMENT_EVIDENCE: Record<string, Record<string, string>> = {
  'alpha.example.com': {
    EXPLICIT_PRICE_ACCEPTANCE: 'Nineteen a month is fine, we lose more than that on one bad order.',
    INSTALL_REQUEST: 'Send us the install link and we will put it on the wholesale store today.',
  },
  'beta.example.com': {
    PILOT_SIGNUP: 'Put us in the pilot at the listed price, we run four wholesale tiers.',
    ONBOARDING_DETAILS: 'Our store is beta-wholesale.myshopify.com and the minimum is 250 dollars.',
  },
  'gamma.example.com': {
    EXPLICIT_PRICE_ACCEPTANCE: 'Happy at that price if it blocks under-minimum orders at checkout.',
    TRIAL_REQUEST: 'We want a trial before the spring wholesale season.',
  },
};

interface SeedOptions {
  guaranteeEvidence?: boolean;
  competitors?: boolean;
}

async function seedValidated(db: Db, opts: SeedOptions = {}): Promise<{ opportunityId: string; campaignId: string }> {
  const opportunityId = await insertOpportunity(db, {
    name: 'Shopify wholesale minimums',
    state: 'VALIDATING',
    evidence_confidence: 'HIGH',
    estimated_build_days: 5,
    proposed_price_monthly: 19,
    target_customer: 'Shopify B2B merchants',
  });
  await db.query('UPDATE opportunities SET wedge_json = $2, source_url = $3 WHERE id = $1', [
    opportunityId,
    JSON.stringify(WEDGE),
    'https://apps.shopify.com/category/wholesale',
  ]);

  const campaignId = await insertCampaign(db, opportunityId, { price: 19, slug: 'wholesale-minimums' });

  const prospectIds: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    prospectIds.push(await insertProspect(db, opportunityId, { domain: `p${i}.example.com` }));
  }
  for (const prospectId of prospectIds) await insertDeliveredMessage(db, campaignId, prospectId);

  const companies = Object.keys(COMMITMENT_EVIDENCE);
  for (const [index, companyKey] of companies.entries()) {
    const byType = COMMITMENT_EVIDENCE[companyKey] ?? {};
    for (const [type, evidence] of Object.entries(byType)) {
      const useGuarantee =
        opts.guaranteeEvidence === true && companyKey === 'alpha.example.com' && type === 'EXPLICIT_PRICE_ACCEPTANCE';
      await insertCommitment(db, campaignId, companyKey, type, {
        prospectId: prospectIds[index],
        evidence: useGuarantee
          ? 'We would need a guarantee that under-minimum orders never reach fulfilment.'
          : evidence,
        source: type === 'PILOT_SIGNUP' ? 'LANDING_FORM' : 'EMAIL_REPLY',
      });
    }
  }

  await db.query(
    `INSERT INTO messages
       (id, campaign_id, prospect_id, direction, sequence_step, subject, body,
        received_at, status, classification, extraction_json)
     VALUES ($1,$2,$3,'INBOUND',-1,'re: minimums',$4, now(), 'RECEIVED','FEATURE_REQUIREMENT',$5)`,
    [
      newId('msg'),
      campaignId,
      prospectIds[0],
      'We would use this if it imports our customer groups from CSV.',
      JSON.stringify({ requestedFeature: 'CSV import of customer groups', priceReaction: 'ACCEPTED' }),
    ],
  );

  if (opts.competitors !== false) {
    await db.query(
      `INSERT INTO competitors
         (id, opportunity_id, name, url, current_pricing, has_permanent_free_tier, review_count, payment_evidence_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        newId('cmp'),
        opportunityId,
        'BigMinimums',
        'https://apps.shopify.com/bigminimums',
        '$29/month, no free plan',
        false,
        412,
        JSON.stringify([
          {
            type: 'CUSTOMER_REFERENCES_PAID_PLAN',
            sourceUrl: 'https://apps.shopify.com/bigminimums/reviews?page=2',
            quote: 'We have paid for the plus plan for two years and it still cannot do per-group minimums.',
            confidence: 'HIGH',
            date: '2026-04-02',
          },
        ]),
      ],
    );
  }

  const evaluations = await evaluateCampaigns();
  expect(evaluations[0]?.passed).toBe(true);
  return { opportunityId, campaignId };
}

/** Every distinct piece of text a quotation is permitted to come from. */
async function quotableCorpus(db: Db): Promise<string[]> {
  const commitments = await db.query<{ evidence_text: string }>('SELECT evidence_text FROM commitments');
  const messages = await db.query<{ body: string }>('SELECT body FROM messages');
  const competitors = await db.query<{ payment_evidence_json: unknown }>(
    'SELECT payment_evidence_json FROM competitors',
  );
  const corpus: string[] = [];
  for (const row of commitments.rows) corpus.push(row.evidence_text);
  for (const row of messages.rows) corpus.push(row.body);
  for (const row of competitors.rows) {
    const raw = row.payment_evidence_json;
    const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Array<{ quote?: string }>;
    for (const entry of parsed ?? []) if (entry.quote) corpus.push(entry.quote);
  }
  return corpus.map((text) => text.replace(/\s+/g, ' ').trim());
}

describe('READY_TO_BUILD email', () => {
  it('has the required subject and every required section, in order', async () => {
    const { db } = await freshDb(SCALED);
    const { opportunityId } = await seedValidated(db);

    const { subject, body } = await renderReadyToBuildEmail(opportunityId);

    expect(subject).toBe('🚨 VALIDATED MRR OPPORTUNITY: Wholesale Minimums');

    const sections = [
      'THE PRODUCT',
      'WHO WANTS IT',
      'PROPOSED PRICE',
      'REAL VALIDATION RESULTS',
      'ACTUAL PROSPECT EVIDENCE',
      'WHY THIS CATEGORY IS ALREADY MONETIZED',
      'WHAT TO BUILD',
      'DO NOT BUILD',
      'CUSTOMER-DERIVED REQUIREMENTS',
      'PROSPECTS WAITING',
      'ENGINEERING PLAN',
      'FIRST REVENUE MATH',
      'EVIDENCE PACKAGE',
    ];
    let cursor = -1;
    for (const section of sections) {
      const at = body.indexOf(`\n${section}\n`);
      expect(at, `section ${section} missing`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('reports the real numbers as unique companies', async () => {
    const { db } = await freshDb(SCALED);
    const { opportunityId } = await seedValidated(db);

    const { body } = await renderReadyToBuildEmail(opportunityId);

    expect(body).toMatch(/Delivered:\s+6/);
    expect(body).toMatch(/Strong positive:\s+3 unique companies/);
    expect(body).toMatch(/Price accepted:\s+3 unique companies/);
    expect(body).toMatch(/Pilot reservations:\s+1 unique company/);
    expect(body).toMatch(/Install\/trial requests:\s+2 unique companies/);
    expect(body).toContain(
      'VALIDATED — 3 real businesses explicitly indicated they are prepared to use this at $19/month.',
    );
  });

  it('labels the revenue math as arithmetic and never as a forecast', async () => {
    const { db } = await freshDb(SCALED);
    const { opportunityId } = await seedValidated(db);

    const { body } = await renderReadyToBuildEmail(opportunityId);

    expect(body).toContain('This is arithmetic, not a forecast:');
    expect(body).toContain('3 waiting pilot customers x $19 = $57 MRR if all convert');
    expect(body).toContain('53 customers x $19 = $1,007 MRR');
    expect(body).not.toMatch(/forecast(ed)? (revenue|mrr)/i);
    expect(body).not.toMatch(/projected/i);
  });

  it('contains no guarantee language anywhere', async () => {
    const { db } = await freshDb(SCALED);
    const { opportunityId } = await seedValidated(db);

    const { body } = await renderReadyToBuildEmail(opportunityId);

    expect(notify.findClaimLanguage(body)).toEqual([]);
    expect(body.toLowerCase()).not.toContain('guarantee');
    expect(() => assertNoGuaranteeLanguage(body)).not.toThrow();
  });

  it('quotes nothing that is not in the database', async () => {
    const { db } = await freshDb(SCALED);
    const { opportunityId } = await seedValidated(db);

    const { body } = await renderReadyToBuildEmail(opportunityId);
    const corpus = await quotableCorpus(db);

    const quotes = [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? '');
    expect(quotes.length).toBeGreaterThan(0);
    for (const quote of quotes) {
      const found = corpus.some((text) => text.includes(quote));
      expect(found, `quote not found in any database row: ${quote}`).toBe(true);
    }
  });

  it('omits a real quote that contains claim language rather than rewriting it', async () => {
    const { db } = await freshDb(SCALED);
    const { opportunityId } = await seedValidated(db, { guaranteeEvidence: true });

    const { body } = await renderReadyToBuildEmail(opportunityId);

    expect(body.toLowerCase()).not.toContain('guarantee');
    expect(body).toContain('omitted: the text contained promotional claim language');
    expect(notify.findClaimLanguage(body)).toEqual([]);
  });

  it('names 3 to 5 MVP capabilities and the explicit exclusions', async () => {
    const { db } = await freshDb(SCALED);
    const { opportunityId } = await seedValidated(db);

    const { body } = await renderReadyToBuildEmail(opportunityId);
    const whatToBuild = body.slice(body.indexOf('\nWHAT TO BUILD\n'), body.indexOf('\nDO NOT BUILD\n'));
    const numbered = whatToBuild.split('\n').filter((line) => /^\s+\d+\./.test(line));

    expect(numbered.length).toBeGreaterThanOrEqual(3);
    expect(numbered.length).toBeLessThanOrEqual(5);
    expect(body).toContain('Multi-currency minimums');
  });

  it('links the internal evidence package', async () => {
    const { db } = await freshDb(SCALED);
    const { opportunityId } = await seedValidated(db);

    const { body } = await renderReadyToBuildEmail(opportunityId);

    expect(body).toContain(`https://mrr.example.com/admin/opportunities/${opportunityId}`);
    expect(body).toContain('/v/wholesale-minimums');
  });
});

describe('claim-language guard', () => {
  it('throws on the exact phrase this system exists to never write', () => {
    expect(() => assertNoGuaranteeLanguage('Guaranteed MRR: $475/month.')).toThrow(SafetyError);
  });

  it('throws on softer promises too', () => {
    for (const bad of [
      'You will earn $475 a month from this.',
      'This is risk-free income.',
      'Revenue is assured once you ship.',
      'Passive income while you sleep.',
      'These customers are certain to convert.',
    ]) {
      expect(() => assertNoGuaranteeLanguage(bad), bad).toThrow(SafetyError);
    }
  });

  it('permits the strongest claim the system is allowed to make', () => {
    const permitted =
      'VALIDATED — 6 real businesses explicitly indicated they are prepared to use this at $19/month.';
    expect(() => assertNoGuaranteeLanguage(permitted)).not.toThrow();
  });

  it('produces arithmetic lines that are plainly arithmetic', () => {
    const lines = revenueMathLines(5, 19);
    expect(lines[0]).toBe('This is arithmetic, not a forecast:');
    expect(lines).toContain('  5 waiting pilot customers x $19 = $95 MRR if all convert');
    expect(lines.join('\n')).toContain('53 customers x $19 = $1,007 MRR');
    expect(formatMoney(1007)).toBe('$1,007');
  });
});

describe('notifyValidatedOpportunities', () => {
  it('sends exactly one email for a validated opportunity', async () => {
    const { db, email } = await freshDb(SCALED);
    // The notifier will not consume a claim for a simulated send, by design.
    treatEmailAsDelivered();
    const { opportunityId } = await seedValidated(db);

    const result = await notifyValidatedOpportunities();

    expect(result.sent).toBe(1);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.to).toBe('owner@example.com');
    expect(email.sent[0]?.subject).toContain('🚨 VALIDATED MRR OPPORTUNITY');
    expect(email.sent[0]?.text).toContain('REAL VALIDATION RESULTS');

    const stored = await db.query<{ kind: string; dedupe_key: string; sent_at: string | null }>(
      'SELECT kind, dedupe_key, sent_at FROM owner_notifications',
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.kind).toBe('READY_TO_BUILD');
    expect(stored.rows[0]?.dedupe_key).toBe(`READY_TO_BUILD:${opportunityId}`);
    expect(stored.rows[0]?.sent_at).not.toBeNull();
  });

  it('never sends a second time for the same opportunity', async () => {
    const { db, email } = await freshDb(SCALED);
    treatEmailAsDelivered();
    await seedValidated(db);

    await notifyValidatedOpportunities();
    const second = await notifyValidatedOpportunities();
    const third = await notifyValidatedOpportunities();

    expect(second.sent).toBe(0);
    expect(third.sent).toBe(0);
    expect(email.sent).toHaveLength(1);
  });

  it('sends nothing for a mediocre campaign', async () => {
    const { db, email } = await freshDb(SCALED);
    const opportunityId = await insertOpportunity(db, {
      state: 'VALIDATING',
      evidence_confidence: 'HIGH',
      estimated_build_days: 5,
      proposed_price_monthly: 19,
    });
    await db.query('UPDATE opportunities SET wedge_json = $2 WHERE id = $1', [
      opportunityId,
      JSON.stringify(WEDGE),
    ]);
    const campaignId = await insertCampaign(db, opportunityId, { price: 19 });
    for (let i = 0; i < 6; i += 1) {
      const prospectId = await insertProspect(db, opportunityId, { domain: `p${i}.example.com` });
      await insertDeliveredMessage(db, campaignId, prospectId);
    }
    await insertCommitment(db, campaignId, 'lonely.example.com', 'EXPLICIT_PRICE_ACCEPTANCE', {
      evidence: 'Sounds interesting, maybe next quarter.',
    });

    await evaluateCampaigns();
    const result = await notifyValidatedOpportunities();

    expect(result.sent).toBe(0);
    expect(email.sent).toHaveLength(0);
  });
});

describe('notifyOwner — infrastructure alerts only', () => {
  it('sends one alert and dedupes every repeat of the same failure', async () => {
    const { db, email } = await freshDb(SCALED);
    treatEmailAsDelivered();

    const first = await notifyOwner({
      kind: 'CREDENTIAL_FAILURE',
      subject: 'Resend API key rejected',
      body: 'The sending credential was rejected at 09:14 UTC. Outreach is halted.',
      dedupeKey: 'CREDENTIAL_FAILURE:resend',
    });
    const repeats = await Promise.all(
      [1, 2, 3].map(() =>
        notifyOwner({
          kind: 'CREDENTIAL_FAILURE',
          subject: 'Resend API key rejected',
          body: 'The sending credential was rejected again. Outreach is halted.',
          dedupeKey: 'CREDENTIAL_FAILURE:resend',
        }),
      ),
    );

    expect(first).toEqual({ sent: true, deduped: false });
    expect(repeats.every((r) => r.sent === false && r.deduped === true)).toBe(true);
    expect(email.sent).toHaveLength(1);

    const stored = await db.query<{ n: string }>('SELECT COUNT(*) AS n FROM owner_notifications');
    expect(Number(stored.rows[0]?.n)).toBe(1);
  });

  it('keeps distinct failures distinct', async () => {
    const { email } = await freshDb(SCALED);
    const mock = email as MockEmailProvider;

    for (const kind of ['DOMAIN_FAILURE', 'COST_LIMIT', 'SECURITY_FAILURE', 'JOB_FAILURE'] as const) {
      await notifyOwner({
        kind,
        subject: `${kind} needs attention`,
        body: `${kind} tripped. The relevant job is halted until it is fixed.`,
        dedupeKey: `${kind}:2026-09`,
      });
    }

    expect(mock.sent).toHaveLength(4);
  });

  it('refuses to send an alert containing claim language', async () => {
    await freshDb(SCALED);
    await expect(
      notifyOwner({
        kind: 'JOB_FAILURE',
        subject: 'job failed',
        body: 'Restart the job and you will earn the missed revenue back.',
        dedupeKey: 'JOB_FAILURE:x',
      }),
    ).rejects.toThrow(SafetyError);
  });
});

describe('structural: the layer has no progress-report function', () => {
  it('exports exactly the permitted surface', () => {
    const exported = Object.keys(notify).sort();
    expect(exported).toEqual(
      [
        'FORBIDDEN_CLAIM_PATTERNS',
        'assertNoGuaranteeLanguage',
        'containsClaimLanguage',
        'findClaimLanguage',
        'listOwnerNotifications',
        'notifyOwner',
        'notifyValidatedOpportunities',
        'readyToBuildDedupeKey',
        'renderReadyToBuildEmail',
      ].sort(),
    );
  });

  it('has no function for research updates, campaign starts or reply counts', () => {
    const names = Object.keys(notify).join(' ').toLowerCase();
    for (const banned of ['progress', 'update', 'digest', 'summary', 'started', 'replied', 'idea']) {
      expect(names).not.toContain(banned);
    }
  });
});
