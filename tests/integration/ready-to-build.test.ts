/**
 * The STRONG fixture, end to end, at PRODUCTION thresholds.
 *
 * Walks the exact state progression a real opportunity must walk, asserts every
 * edge, lets the deterministic gate do the only two transitions it is allowed
 * to do, then checks the one email the owner receives and the validated/<slug>/
 * directory that a fresh Claude Code session would be handed.
 *
 * Nothing here is mocked except the network: real migrations, real SQL, real
 * state machine, real gate.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { freshDb, teardown, insertOpportunity, insertCampaign, insertCommitment } from '../helpers.js';
import type { Db } from '../../src/lib/db.js';
import { newId } from '../../src/lib/hash.js';
import { transitionOpportunity } from '../../src/lib/audit.js';
import { evaluateCampaigns } from '../../src/pipeline/validation/evaluate.js';
import { evaluateGate } from '../../src/pipeline/validation/gate.js';
import { getCampaignCounts } from '../../src/pipeline/validation/counts.js';
import { notifyValidatedOpportunities } from '../../src/pipeline/notify/index.js';
import { findClaimLanguage } from '../../src/pipeline/notify/claims.js';
import { generateBuildSpec, MVP_SECTIONS, SPEC_FILES } from '../../src/pipeline/buildspec/index.js';

let outputDir: string | null = null;

afterEach(async () => {
  await teardown();
  if (outputDir) {
    await rm(outputDir, { recursive: true, force: true });
    outputDir = null;
  }
  delete process.env.VALIDATED_OUTPUT_DIR;
});

/**
 * PRODUCTION defaults, stated explicitly. Other test files scale these down to
 * keep their fixtures small; this file must run against the real numbers.
 */
const PRODUCTION_GATE = {
  MIN_QUALIFIED_PROSPECTS_FOR_GATE: '100',
  MIN_DELIVERED_BEFORE_STANDARD_EVALUATION: '75',
  MIN_UNIQUE_STRONG_COMMITMENTS: '5',
  MIN_UNIQUE_PRICE_ACCEPTANCES: '3',
  MIN_UNIQUE_ACTION_COMMITMENTS: '2',
  MIN_POSITIVE_INTENT_RATE: '0.04',
  MAX_MVP_BUILD_DAYS: '7',
  REQUIRED_CATEGORY_EVIDENCE_CONFIDENCE: 'HIGH',
  EXTREME_VALIDATION: 'false',
  INITIAL_EMAIL_BATCH: '25',
  MAX_EMAILS_PER_CAMPAIGN: '150',
  OWNER_NOTIFICATION_EMAIL: 'owner@example.com',
  PUBLIC_BASE_URL: 'https://mrr.example.com',
};

const WEDGE = {
  statement:
    'For Shopify merchants selling wholesale, enforce per-customer-group order minimums at checkout without a developer.',
  productName: 'Wholesale Minimums',
  targetCustomer: 'Shopify merchants running a wholesale channel with customer groups',
  coreWorkflow:
    'Merchant sets a minimum order value per customer group; the app blocks checkout below it and explains why.',
  v1Features: [
    'Per-customer-group minimum order value',
    'Checkout-time enforcement with a clear merchant-authored message',
    'CSV import of customer groups and their minimums',
    'Audit log of blocked checkouts',
  ],
  excludedFromV1: [
    'Multi-currency minimums',
    'Theme editor integration',
    'Anything touching fulfilment or shipping rates',
  ],
  proposedPriceMonthly: 19,
  estimatedBuildDays: 5,
  primaryCompetitor: 'BigMinimums',
  reasonSomeoneWouldSwitch: 'The incumbent cannot express minimums per customer group, only store-wide.',
  oneSentenceOutcome: 'Wholesale orders below a merchant-set minimum never reach fulfilment.',
  capabilities: ['per-group minimums', 'checkout enforcement', 'CSV import'],
  whoItIsFor: 'Shopify B2B merchants with wholesale customer groups',
};

/** company -> commitment type -> the exact words that company used. */
const COMMITMENTS: Record<string, Record<string, string>> = {
  'northgate-supply.example.com': {
    EXPLICIT_PRICE_ACCEPTANCE: 'Nineteen a month is nothing next to one under-minimum wholesale order.',
    INSTALL_REQUEST: 'Send the install link, we will put it on the wholesale store this week.',
  },
  'harbor-goods.example.com': {
    PILOT_SIGNUP: 'Put us in the pilot at the listed price. We run four wholesale tiers.',
    ONBOARDING_DETAILS: 'Store is harbor-goods.myshopify.com, our floor is 250 dollars per group.',
  },
  'kettle-and-co.example.com': {
    EXPLICIT_PRICE_ACCEPTANCE: 'Happy at that price if it blocks under-minimum orders at checkout.',
  },
  'pine-street-wholesale.example.com': {
    TRIAL_REQUEST: 'We want a trial before the spring wholesale season starts.',
  },
  'delta-provisions.example.com': {
    OTHER_STRONG_INTENT: 'We have wanted exactly this for two years, tell us when it is live.',
  },
  'sable-trading.example.com': {
    PILOT_SIGNUP: 'Sign us up for the pilot at nineteen a month.',
    TRIAL_REQUEST: 'A trial on our staging store first would work.',
  },
};

/**
 * `commitments.company_key` is the prospect's normalized domain, so the
 * committed companies below are real prospect rows with those exact domains.
 */
async function bulkProspects(
  db: Db,
  opportunityId: string,
  count: number,
  leadingDomains: string[] = [],
): Promise<string[]> {
  const ids: string[] = [];
  const rows: string[] = [];
  const params: unknown[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = newId('pr');
    const domain = leadingDomains[i] ?? `prospect${i}.example.com`;
    const name = domain
      .replace(/\.example\.com$/, '')
      .split('-')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
    ids.push(id);
    const base = params.length;
    rows.push(
      `($${base + 1},$${base + 2},$${base + 3},$${base + 4},'shopify','QUALIFIED',$${base + 5},true,'US',$${base + 6},$${base + 7},'publishes a public wholesale price list')`,
    );
    params.push(
      id,
      opportunityId,
      name,
      domain,
      `hello@${domain}`,
      `https://${domain}/wholesale`,
      `https://${domain}/contact`,
    );
  }
  await db.query(
    `INSERT INTO prospects
       (id, opportunity_id, company_name, domain, ecosystem, status, contact_email,
        email_is_public, country, public_evidence_url, contact_source_url, qualification_reason)
     VALUES ${rows.join(',')}`,
    params,
  );
  return ids;
}

async function bulkDelivered(db: Db, campaignId: string, prospectIds: string[]): Promise<void> {
  const rows: string[] = [];
  const params: unknown[] = [];
  for (const prospectId of prospectIds) {
    const base = params.length;
    rows.push(
      `($${base + 1},$${base + 2},$${base + 3},'OUTBOUND',0,'A question about your wholesale minimums','body', now(), now(),'DELIVERED',$${base + 4})`,
    );
    params.push(newId('msg'), campaignId, prospectId, `${campaignId}:${prospectId}:0`);
  }
  await db.query(
    `INSERT INTO messages
       (id, campaign_id, prospect_id, direction, sequence_step, subject, body,
        sent_at, delivered_at, status, idempotency_key)
     VALUES ${rows.join(',')}`,
    params,
  );
}

async function insertInbound(
  db: Db,
  campaignId: string,
  prospectId: string,
  opts: { classification: string; body: string; requestedFeature?: string | null },
): Promise<void> {
  await db.query(
    `INSERT INTO messages
       (id, campaign_id, prospect_id, direction, sequence_step, subject, body,
        received_at, status, classification, extraction_json)
     VALUES ($1,$2,$3,'INBOUND',-1,'re: wholesale minimums',$4, now(),'RECEIVED',$5,$6)`,
    [
      newId('msg'),
      campaignId,
      prospectId,
      opts.body,
      opts.classification,
      JSON.stringify({
        requestedFeature: opts.requestedFeature ?? null,
        priceReaction: 'ACCEPTED',
        explicitlyAcceptedPrice: true,
      }),
    ],
  );
}

async function stateOf(db: Db, opportunityId: string): Promise<string> {
  const res = await db.query<{ state: string }>('SELECT state FROM opportunities WHERE id = $1', [
    opportunityId,
  ]);
  return res.rows[0]?.state ?? 'MISSING';
}

describe('STRONG fixture: DISCOVERED all the way to READY_TO_BUILD', () => {
  it('walks the exact state progression and produces the owner email and the build spec', async () => {
    outputDir = await mkdtemp(path.join(tmpdir(), 'mrr-validated-'));
    const { db, email } = await freshDb({ ...PRODUCTION_GATE, VALIDATED_OUTPUT_DIR: outputDir });

    // --- fixture ---------------------------------------------------------
    const opportunityId = await insertOpportunity(db, {
      name: 'Shopify wholesale order minimums',
      ecosystem: 'shopify',
      category: 'wholesale-minimums',
      state: 'DISCOVERED',
    });
    await db.query('UPDATE opportunities SET source_url = $2, description = $3 WHERE id = $1', [
      opportunityId,
      'https://apps.shopify.com/category/wholesale',
      'Merchants pay for apps that enforce wholesale order minimums.',
    ]);
    await db.query(
      `INSERT INTO competitors
         (id, opportunity_id, name, url, current_pricing, free_plan_details,
          has_permanent_free_tier, review_count, rating, launch_age, payment_evidence_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        newId('cmp'),
        opportunityId,
        'BigMinimums',
        'https://apps.shopify.com/bigminimums',
        '$29/month, no free plan',
        null,
        false,
        412,
        4.6,
        'launched 2019',
        JSON.stringify([
          {
            type: 'INCUMBENT_NO_FREE_TIER',
            sourceUrl: 'https://apps.shopify.com/bigminimums',
            quote: 'Plans start at 29 dollars per month with no free tier.',
            confidence: 'HIGH',
            date: '2026-08-01',
          },
          {
            type: 'CUSTOMER_REFERENCES_PAID_PLAN',
            sourceUrl: 'https://apps.shopify.com/bigminimums/reviews?page=2',
            quote: 'We have paid for this for two years and it still cannot do per-group minimums.',
            confidence: 'HIGH',
            date: '2026-04-02',
          },
        ]),
      ],
    );

    // --- the exact progression -------------------------------------------
    const walk: Array<{ to: Parameters<typeof transitionOpportunity>[0]['to']; set?: Record<string, unknown> }> = [
      { to: 'CATEGORY_VERIFYING' },
      { to: 'CATEGORY_VERIFIED', set: { evidence_confidence: 'HIGH' } },
      {
        to: 'WEDGE_GENERATED',
        set: {
          wedge_json: WEDGE,
          proposed_wedge: WEDGE.statement,
          target_customer: WEDGE.targetCustomer,
          proposed_price_monthly: 19,
          estimated_build_days: 5,
        },
      },
      { to: 'PROSPECTING' },
      { to: 'CAMPAIGN_READY' },
    ];

    for (const step of walk) {
      const moved = await transitionOpportunity({
        opportunityId,
        to: step.to,
        actor: 'integration-fixture',
        reason: `fixture advanced to ${step.to}`,
        set: step.set as never,
      });
      expect(moved.moved).toBe(true);
      expect(await stateOf(db, opportunityId)).toBe(step.to);
    }

    // 100 qualified prospects, 75 delivered emails — the production minimums.
    const committedDomains = Object.keys(COMMITMENTS);
    const prospectIds = await bulkProspects(db, opportunityId, 100, committedDomains);
    const campaignId = await insertCampaign(db, opportunityId, {
      price: 19,
      slug: 'wholesale-minimums',
      state: 'BATCH_2_REVIEW',
      target: 150,
    });
    await bulkDelivered(db, campaignId, prospectIds.slice(0, 75));

    // Six real companies committed. Several committed twice; each counts once.
    for (const [index, companyKey] of committedDomains.entries()) {
      for (const [type, evidence] of Object.entries(COMMITMENTS[companyKey] ?? {})) {
        await insertCommitment(db, campaignId, companyKey, type, {
          prospectId: prospectIds[index],
          evidence,
          source: type === 'PILOT_SIGNUP' ? 'LANDING_FORM' : 'EMAIL_REPLY',
          price: 19,
        });
      }
    }

    await insertInbound(db, campaignId, prospectIds[0] ?? '', {
      classification: 'PRICE_ACCEPTED',
      body: 'Nineteen a month is nothing next to one under-minimum wholesale order. We need CSV import for our customer groups.',
      requestedFeature: 'CSV import of customer groups',
    });
    await insertInbound(db, campaignId, prospectIds[1] ?? '', {
      classification: 'FEATURE_REQUIREMENT',
      body: 'We would need CSV import of customer groups. Typing four hundred accounts is not happening.',
      requestedFeature: 'CSV import of customer groups',
    });
    await insertInbound(db, campaignId, prospectIds[2] ?? '', {
      classification: 'WANTS_PILOT',
      body: 'Put us in the pilot. An audit log of blocked checkouts would settle arguments with our reps.',
      requestedFeature: 'Audit log of blocked checkouts',
    });

    // --- counts are unique companies, not rows ---------------------------
    const counts = await getCampaignCounts(campaignId);
    expect(counts.qualifiedProspects).toBe(100);
    expect(counts.delivered).toBe(75);
    expect(counts.uniqueStrongCommitmentCompanies).toBe(6);
    expect(counts.uniquePriceAcceptanceCompanies).toBe(4);
    expect(counts.uniqueActionCommitmentCompanies).toBe(4);
    expect(counts.positiveIntentRate).toBeCloseTo(6 / 75, 6);

    // --- the gate is the only thing that may advance it ------------------
    const evaluations = await evaluateCampaigns();
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0]?.unmetChecks).toEqual([]);
    expect(evaluations[0]?.passed).toBe(true);
    expect(await stateOf(db, opportunityId)).toBe('READY_TO_BUILD');

    const transitions = await db.query<{ from_state: string; to_state: string; actor: string }>(
      `SELECT from_state, to_state, actor FROM audit_events
        WHERE entity_id = $1 AND event_type = 'STATE_TRANSITION'
        ORDER BY created_at ASC, id ASC`,
      [opportunityId],
    );
    expect(transitions.rows.map((r) => r.to_state)).toEqual([
      'CATEGORY_VERIFYING',
      'CATEGORY_VERIFIED',
      'WEDGE_GENERATED',
      'PROSPECTING',
      'CAMPAIGN_READY',
      'VALIDATING',
      'VALIDATION_STRONG',
      'READY_TO_BUILD',
    ]);
    expect(transitions.rows.map((r) => r.from_state)).toEqual([
      'DISCOVERED',
      'CATEGORY_VERIFYING',
      'CATEGORY_VERIFIED',
      'WEDGE_GENERATED',
      'PROSPECTING',
      'CAMPAIGN_READY',
      'VALIDATING',
      'VALIDATION_STRONG',
    ]);
    // The last three edges were performed by the evaluator, not the fixture.
    expect(transitions.rows.slice(5).every((r) => r.actor === 'evaluate_campaigns')).toBe(true);

    const finalEvaluation = await evaluateGate(opportunityId);
    expect(finalEvaluation.checks).toHaveLength(10);
    expect(finalEvaluation.checks.every((c) => c.passed)).toBe(true);

    const campaign = await db.query<{ state: string }>('SELECT state FROM campaigns WHERE id = $1', [
      campaignId,
    ]);
    expect(campaign.rows[0]?.state).toBe('COMPLETE');

    // --- the one email the owner receives --------------------------------
    const notified = await notifyValidatedOpportunities();
    expect(notified.sent).toBe(1);
    expect(email.sent).toHaveLength(1);

    const sent = email.sent[0];
    expect(sent?.to).toBe('owner@example.com');
    expect(sent?.subject).toBe('🚨 VALIDATED MRR OPPORTUNITY: Wholesale Minimums');

    const body = sent?.text ?? '';
    expect(findClaimLanguage(body)).toEqual([]);
    expect(body).toMatch(/Delivered:\s+75/);
    expect(body).toMatch(/Strong positive:\s+6 unique companies/);
    expect(body).toContain(
      'VALIDATED — 6 real businesses explicitly indicated they are prepared to use this at $19/month.',
    );
    expect(body).toContain('This is arithmetic, not a forecast:');
    expect(body).toContain('6 waiting pilot customers x $19 = $114 MRR if all convert');
    expect(body).toContain('CSV import of customer groups');
    expect(body).toContain('https://apps.shopify.com/bigminimums');
    expect(body).toContain(`https://mrr.example.com/admin/opportunities/${opportunityId}`);

    // Every quotation traces to a row.
    const corpusRows = await db.query<{ text: string }>(
      `SELECT evidence_text AS text FROM commitments
       UNION ALL SELECT body AS text FROM messages`,
    );
    const corpus = corpusRows.rows.map((r) => r.text.replace(/\s+/g, ' ').trim());
    corpus.push('Plans start at 29 dollars per month with no free tier.');
    corpus.push('We have paid for this for two years and it still cannot do per-group minimums.');
    const quotes = [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? '');
    expect(quotes.length).toBeGreaterThan(2);
    for (const quote of quotes) {
      expect(corpus.some((text) => text.includes(quote)), `fabricated quote: ${quote}`).toBe(true);
    }

    // Re-running notifies nobody a second time.
    expect((await notifyValidatedOpportunities()).sent).toBe(0);
    expect(email.sent).toHaveLength(1);

    // --- the build spec ---------------------------------------------------
    const spec = await generateBuildSpec(opportunityId);
    expect(spec.slug).toBe('wholesale-minimums');
    expect(spec.directory).toBe(path.join(outputDir, 'wholesale-minimums'));
    expect(spec.files).toEqual([...SPEC_FILES]);

    const written = (await readdir(spec.directory)).sort();
    expect(written).toEqual([...SPEC_FILES].sort());

    const read = async (file: string): Promise<string> => readFile(path.join(spec.directory, file), 'utf8');

    const readme = await read('README.md');
    expect(readme).toContain('Build this. Do not expand scope.');
    expect(readme).toContain('6 unique companies produced a strong purchase-intent event');
    expect(readme).toContain('Wholesale Minimums');

    const mvp = await read('mvp.md');
    let cursor = -1;
    for (const section of MVP_SECTIONS) {
      const at = mvp.indexOf(`## ${section}`);
      expect(at, `mvp.md is missing ## ${section}`).toBeGreaterThan(cursor);
      cursor = at;
    }
    expect(mvp).toContain('$19/month');
    expect(mvp).toContain('Per-customer-group minimum order value');
    expect(mvp).toContain('Multi-currency minimums');

    const customers = await read('customers.md');
    expect(customers).toContain('northgate-supply.example.com');
    expect(customers).toContain('CSV import of customer groups');
    expect(customers).toContain('Send the install link, we will put it on the wholesale store this week.');

    const marketEvidence = await read('market-evidence.md');
    expect(marketEvidence).toContain('BigMinimums');
    expect(marketEvidence).toContain('https://apps.shopify.com/bigminimums/reviews?page=2');
    expect(marketEvidence).toContain('INCUMBENT_NO_FREE_TIER');

    const requirements = await read('requirements.md');
    expect(requirements).toContain('REQ-1');
    expect(requirements).toContain('CSV import of customer groups');

    const acceptance = await read('acceptance-tests.md');
    expect(acceptance).toContain('AT-1');
    expect(acceptance).toContain('**Given**');
    expect(acceptance).toContain('AT-SCOPE');

    const architecture = await read('architecture.md');
    expect(architecture).toContain('Budget: 5 days');

    const launch = await read('launch-plan.md');
    expect(launch).toContain('This is arithmetic, not a forecast:');
    expect(launch).toContain('northgate-supply.example.com');

    for (const file of SPEC_FILES) {
      const content = await read(file);
      expect(findClaimLanguage(content), `${file} contains claim language`).toEqual([]);
      expect(content.length).toBeGreaterThan(200);
    }

    // Writing is safe to re-run.
    const again = await generateBuildSpec(opportunityId);
    expect(again.directory).toBe(spec.directory);
    expect((await readdir(spec.directory)).sort()).toEqual([...SPEC_FILES].sort());
    expect(await read('mvp.md')).toContain('## ACCEPTANCE CRITERIA');

    // And it never escapes its output root.
    expect(spec.directory.startsWith(outputDir + path.sep)).toBe(true);
  });
});
