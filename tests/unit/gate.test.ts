/**
 * THE GATE. If one test file in this repository must be right, it is this one.
 *
 * Thresholds are deliberately scaled down through environment variables in most
 * cases below. That is not a shortcut: it proves the gate reads config.gate
 * rather than hard-coded numbers, and it lets each of the ten checks be pushed
 * exactly one short of its own requirement in isolation. The production
 * defaults are exercised end to end in tests/integration/ready-to-build.test.ts.
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
} from '../helpers';
import type { Db } from '../../src/lib/db';
import { newId } from '../../src/lib/hash';
import { evaluateGate, decideGate, collectGateInputs } from '../../src/pipeline/validation/gate';
import { getCampaignCounts } from '../../src/pipeline/validation/counts';
import { recordFeasibilityBlocker } from '../../src/pipeline/validation/blockers';
import { CHECK_IDS, REQUIRED_CHECK_IDS } from '../../src/pipeline/validation/types';

afterEach(async () => {
  await teardown();
});

/** Scaled-down thresholds. Every value here is read back out of config.gate. */
const SCALED = {
  MIN_QUALIFIED_PROSPECTS_FOR_GATE: '5',
  MIN_DELIVERED_BEFORE_STANDARD_EVALUATION: '6',
  MIN_UNIQUE_STRONG_COMMITMENTS: '3',
  MIN_UNIQUE_PRICE_ACCEPTANCES: '2',
  MIN_UNIQUE_ACTION_COMMITMENTS: '2',
  MIN_POSITIVE_INTENT_RATE: '0.3',
  MAX_MVP_BUILD_DAYS: '7',
  REQUIRED_CATEGORY_EVIDENCE_CONFIDENCE: 'HIGH',
  EXTREME_VALIDATION: 'false',
};

const WEDGE = {
  productName: 'Wholesale Minimums',
  statement: 'For Shopify B2B merchants, enforce per-customer order minimums without a developer.',
  targetCustomer: 'Shopify merchants running wholesale price lists',
  coreWorkflow: 'Merchant sets a minimum per customer group; checkout blocks orders below it.',
  v1Features: [
    'Per-customer-group minimum order value',
    'Checkout-time enforcement with a clear message',
    'CSV import of customer groups',
    'Audit log of blocked checkouts',
  ],
  excludedFromV1: ['Multi-currency minimums', 'Custom theme editor'],
  proposedPriceMonthly: 19,
  estimatedBuildDays: 5,
  primaryCompetitor: 'BigMinimums',
  reasonSomeoneWouldSwitch: 'The incumbent cannot express per-group minimums.',
  oneSentenceOutcome: 'Wholesale orders below a merchant-set minimum stop reaching fulfilment.',
  capabilities: ['minimums', 'enforcement', 'import'],
  whoItIsFor: 'Shopify B2B merchants with wholesale customers',
};

interface Options {
  prospects?: number;
  delivered?: number;
  /** company key -> commitment types */
  commitments?: Record<string, string[]>;
  evidenceConfidence?: string | null;
  buildDays?: number | null;
  v1Features?: string[];
  customerRequirement?: boolean;
  blocker?: string | null;
}

const DEFAULT_COMMITMENTS: Record<string, string[]> = {
  'alpha.example.com': ['EXPLICIT_PRICE_ACCEPTANCE', 'INSTALL_REQUEST'],
  'beta.example.com': ['PILOT_SIGNUP', 'ONBOARDING_DETAILS'],
  'gamma.example.com': ['EXPLICIT_PRICE_ACCEPTANCE', 'TRIAL_REQUEST'],
};

async function seed(db: Db, opts: Options = {}): Promise<{ opportunityId: string; campaignId: string }> {
  const wedge: Record<string, unknown> = { ...WEDGE, v1Features: opts.v1Features ?? WEDGE.v1Features };
  // "No estimate recorded" means no estimate anywhere, column or wedge.
  if (opts.buildDays === null) delete wedge.estimatedBuildDays;
  if (opts.buildDays !== undefined && opts.buildDays !== null) wedge.estimatedBuildDays = opts.buildDays;
  const opportunityId = await insertOpportunity(db, {
    state: 'VALIDATING',
    evidence_confidence: opts.evidenceConfidence === undefined ? 'HIGH' : (opts.evidenceConfidence ?? undefined),
    estimated_build_days: opts.buildDays === undefined ? 5 : (opts.buildDays ?? undefined),
    proposed_price_monthly: 19,
  });
  await db.query('UPDATE opportunities SET wedge_json = $2 WHERE id = $1', [
    opportunityId,
    JSON.stringify(wedge),
  ]);
  if (opts.evidenceConfidence === null) {
    await db.query('UPDATE opportunities SET evidence_confidence = NULL WHERE id = $1', [opportunityId]);
  }
  if (opts.buildDays === null) {
    await db.query('UPDATE opportunities SET estimated_build_days = NULL WHERE id = $1', [opportunityId]);
  }

  const campaignId = await insertCampaign(db, opportunityId, { price: 19 });

  const prospectCount = opts.prospects ?? 5;
  const deliveredCount = opts.delivered ?? 6;
  const total = Math.max(prospectCount, deliveredCount);
  const prospectIds: string[] = [];
  for (let i = 0; i < total; i += 1) {
    prospectIds.push(
      await insertProspect(db, opportunityId, {
        domain: `p${i}.example.com`,
        status: i < prospectCount ? 'QUALIFIED' : 'DISCOVERED',
      }),
    );
  }
  for (let i = 0; i < deliveredCount; i += 1) {
    const prospectId = prospectIds[i];
    if (prospectId) await insertDeliveredMessage(db, campaignId, prospectId);
  }

  const commitments = opts.commitments ?? DEFAULT_COMMITMENTS;
  for (const [companyKey, types] of Object.entries(commitments)) {
    for (const type of types) {
      await insertCommitment(db, campaignId, companyKey, type, {
        evidence: `${companyKey} said yes to ${type}`,
      });
    }
  }

  if (opts.customerRequirement !== false) {
    await insertInboundReply(db, campaignId, prospectIds[0] ?? null, {
      classification: 'INTERESTED_STRONG',
      body: 'Yes, we would use this. We need a CSV import for our 400 wholesale accounts.',
      requestedFeature: 'CSV import of wholesale accounts',
    });
  }

  if (opts.blocker) await recordFeasibilityBlocker(opportunityId, opts.blocker, 'test');

  return { opportunityId, campaignId };
}

async function insertInboundReply(
  db: Db,
  campaignId: string,
  prospectId: string | null,
  opts: {
    classification: string;
    body: string;
    requestedFeature?: string | null;
    priceReaction?: string;
  },
): Promise<string> {
  const id = newId('msg');
  await db.query(
    `INSERT INTO messages
       (id, campaign_id, prospect_id, direction, sequence_step, subject, body,
        received_at, status, classification, extraction_json)
     VALUES ($1,$2,$3,'INBOUND',-1,'re: hello',$4, now(), 'RECEIVED', $5, $6)`,
    [
      id,
      campaignId,
      prospectId,
      opts.body,
      opts.classification,
      JSON.stringify({
        requestedFeature: opts.requestedFeature ?? null,
        priceReaction: opts.priceReaction ?? 'NOT_MENTIONED',
      }),
    ],
  );
  return id;
}

function ids(checks: { id: string }[]): string[] {
  return checks.map((c) => c.id);
}

describe('gate — a fully validated opportunity', () => {
  it('passes every required check', async () => {
    const { db } = await freshDb(SCALED);
    const { opportunityId, campaignId } = await seed(db);

    const evaluation = await evaluateGate(opportunityId);

    expect(evaluation.unmetChecks).toEqual([]);
    expect(evaluation.passed).toBe(true);
    expect(evaluation.campaignId).toBe(campaignId);
    expect(ids(evaluation.checks)).toEqual([...REQUIRED_CHECK_IDS]);
    expect(evaluation.checks.every((c) => c.detail.length > 0)).toBe(true);
  });

  it('never transitions the opportunity: it is safe to call from a dashboard', async () => {
    const { db } = await freshDb(SCALED);
    const { opportunityId } = await seed(db);

    await evaluateGate(opportunityId);
    await evaluateGate(opportunityId);

    const res = await db.query<{ state: string }>('SELECT state FROM opportunities WHERE id = $1', [
      opportunityId,
    ]);
    expect(res.rows[0]?.state).toBe('VALIDATING');
    const audits = await db.query<{ n: string }>('SELECT COUNT(*) AS n FROM audit_events');
    expect(Number(audits.rows[0]?.n)).toBe(0);
  });
});

describe('gate — each check fails independently when its input is one short', () => {
  const cases: Array<{ name: string; checkId: string; options: Options }> = [
    {
      name: '1. category payment evidence is one confidence rank short',
      checkId: CHECK_IDS.categoryPaymentEvidence,
      options: { evidenceConfidence: 'MEDIUM' },
    },
    {
      name: '2. one qualified prospect short',
      checkId: CHECK_IDS.qualifiedProspects,
      options: { prospects: 4 },
    },
    {
      name: '3. one delivered email short, with demand only level with the thresholds',
      checkId: CHECK_IDS.outreachVolume,
      options: { delivered: 5 },
    },
    {
      name: '4. one unique strong-commitment company short',
      checkId: CHECK_IDS.uniqueStrongCommitments,
      options: {
        commitments: {
          'alpha.example.com': ['EXPLICIT_PRICE_ACCEPTANCE', 'INSTALL_REQUEST'],
          'beta.example.com': ['PILOT_SIGNUP', 'ONBOARDING_DETAILS'],
        },
      },
    },
    {
      name: '5. one unique price-acceptance company short',
      checkId: CHECK_IDS.uniquePriceAcceptances,
      options: {
        commitments: {
          'alpha.example.com': ['EXPLICIT_PRICE_ACCEPTANCE', 'INSTALL_REQUEST'],
          'beta.example.com': ['ONBOARDING_DETAILS'],
          'gamma.example.com': ['TRIAL_REQUEST'],
        },
      },
    },
    {
      name: '6. one unique action-commitment company short',
      checkId: CHECK_IDS.uniqueActionCommitments,
      options: {
        commitments: {
          'alpha.example.com': ['EXPLICIT_PRICE_ACCEPTANCE', 'INSTALL_REQUEST'],
          'beta.example.com': ['PILOT_SIGNUP'],
          'gamma.example.com': ['EXPLICIT_PRICE_ACCEPTANCE'],
        },
      },
    },
    {
      name: '7. positive-intent rate just under the floor',
      checkId: CHECK_IDS.positiveIntentRate,
      options: { prospects: 11, delivered: 11 },
    },
    {
      name: '8. a feasibility blocker was recorded',
      checkId: CHECK_IDS.noFeasibilityBlocker,
      options: { blocker: 'platform API cannot block checkout' },
    },
    {
      name: '9. estimated build is one day over the cap',
      checkId: CHECK_IDS.mvpBuildDays,
      options: { buildDays: 8 },
    },
    {
      name: '10. no customer-derived requirement exists',
      checkId: CHECK_IDS.explainableV1Requirements,
      options: { customerRequirement: false },
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, async () => {
      const { db } = await freshDb(SCALED);
      const { opportunityId } = await seed(db, testCase.options);

      const evaluation = await evaluateGate(opportunityId);

      expect(evaluation.passed).toBe(false);
      expect(ids(evaluation.unmetChecks)).toEqual([testCase.checkId]);
      const failed = evaluation.unmetChecks[0];
      expect(failed?.detail).toMatch(/need|no /i);
      expect(String(failed?.detail).length).toBeGreaterThan(10);
    });
  }

  it('also fails the V1 explainability check when the wedge lists fewer than three features', async () => {
    const { db } = await freshDb(SCALED);
    const { opportunityId } = await seed(db, { v1Features: ['One feature', 'Two features'] });

    const evaluation = await evaluateGate(opportunityId);

    expect(ids(evaluation.unmetChecks)).toEqual([CHECK_IDS.explainableV1Requirements]);
    expect(evaluation.unmetChecks[0]?.detail).toContain('need at least 3');
  });

  it('reports a missing build estimate rather than assuming it is small', async () => {
    const { db } = await freshDb(SCALED);
    const { opportunityId } = await seed(db, { buildDays: null });

    const evaluation = await evaluateGate(opportunityId);

    expect(ids(evaluation.unmetChecks)).toEqual([CHECK_IDS.mvpBuildDays]);
    expect(evaluation.unmetChecks[0]?.detail).toContain('no MVP build estimate recorded');
  });

  it('reports missing category evidence explicitly', async () => {
    const { db } = await freshDb(SCALED);
    const { opportunityId } = await seed(db, { evidenceConfidence: null });

    const evaluation = await evaluateGate(opportunityId);

    expect(ids(evaluation.unmetChecks)).toEqual([CHECK_IDS.categoryPaymentEvidence]);
    expect(evaluation.unmetChecks[0]?.detail).toContain('no category payment evidence recorded');
  });
});

describe('gate — unique company counting', () => {
  it('counts five commitments from the SAME company as one company', async () => {
    const { db } = await freshDb(SCALED);
    const { opportunityId, campaignId } = await seed(db, {
      commitments: {
        'oneloudcompany.example.com': [
          'EXPLICIT_PRICE_ACCEPTANCE',
          'PILOT_SIGNUP',
          'INSTALL_REQUEST',
          'TRIAL_REQUEST',
          'ONBOARDING_DETAILS',
        ],
      },
    });

    const rows = await db.query<{ n: string }>('SELECT COUNT(*) AS n FROM commitments WHERE campaign_id = $1', [
      campaignId,
    ]);
    expect(Number(rows.rows[0]?.n)).toBe(5);

    const counts = await getCampaignCounts(campaignId);
    expect(counts.uniqueStrongCommitmentCompanies).toBe(1);
    expect(counts.uniquePriceAcceptanceCompanies).toBe(1);
    expect(counts.uniqueActionCommitmentCompanies).toBe(1);
    expect(counts.uniqueMonetaryCommitmentCompanies).toBe(0);

    const evaluation = await evaluateGate(opportunityId);
    expect(evaluation.passed).toBe(false);
    expect(ids(evaluation.unmetChecks)).toContain(CHECK_IDS.uniqueStrongCommitments);
    expect(evaluation.unmetChecks[0]?.detail).toContain('1 unique company');
  });

  it('counts three separate companies as three, however few rows each has', async () => {
    const { db } = await freshDb(SCALED);
    const { campaignId } = await seed(db, {
      commitments: {
        'a.example.com': ['EXPLICIT_PRICE_ACCEPTANCE'],
        'b.example.com': ['PILOT_SIGNUP'],
        'c.example.com': ['INSTALL_REQUEST'],
      },
    });

    const counts = await getCampaignCounts(campaignId);
    expect(counts.uniqueStrongCommitmentCompanies).toBe(3);
    expect(counts.uniquePriceAcceptanceCompanies).toBe(2);
    expect(counts.uniqueActionCommitmentCompanies).toBe(1);
  });
});

describe('gate — weak signals can never move the needle', () => {
  it('ignores opens and clicks entirely', async () => {
    const { db } = await freshDb(SCALED);
    const { opportunityId, campaignId } = await seed(db);

    const before = await getCampaignCounts(campaignId);
    const beforeEvaluation = await evaluateGate(opportunityId);

    // Every message opened and clicked, twice over. Nothing may change.
    await db.query(
      `UPDATE messages SET opened_at = now(), clicked_at = now() WHERE campaign_id = $1`,
      [campaignId],
    );
    // Plus a pile of opened-but-never-delivered messages.
    for (let i = 0; i < 40; i += 1) {
      const prospectId = await insertProspect(db, opportunityId, { domain: `opener${i}.example.com` });
      await db.query(
        `INSERT INTO messages (id, campaign_id, prospect_id, direction, sequence_step, subject, body,
                               sent_at, opened_at, clicked_at, status, idempotency_key)
         VALUES ($1,$2,$3,'OUTBOUND',0,'s','b', now(), now(), now(), 'SENT', $4)`,
        [newId('msg'), campaignId, prospectId, `opened:${i}`],
      );
    }

    const after = await getCampaignCounts(campaignId);
    const afterEvaluation = await evaluateGate(opportunityId);

    expect(after.delivered).toBe(before.delivered);
    expect(after.uniqueStrongCommitmentCompanies).toBe(before.uniqueStrongCommitmentCompanies);
    expect(after.positiveIntentRate).toBe(before.positiveIntentRate);
    expect(afterEvaluation.passed).toBe(beforeEvaluation.passed);
    expect(ids(afterEvaluation.checks)).toEqual(ids(beforeEvaluation.checks));
  });

  it('never divides by zero when nothing was delivered', async () => {
    const { db } = await freshDb(SCALED);
    const { opportunityId, campaignId } = await seed(db, { delivered: 0, prospects: 5 });

    const counts = await getCampaignCounts(campaignId);
    expect(counts.delivered).toBe(0);
    expect(counts.positiveIntentRate).toBe(0);
    expect(Number.isFinite(counts.positiveIntentRate)).toBe(true);

    const evaluation = await evaluateGate(opportunityId);
    const rate = evaluation.checks.find((c) => c.id === CHECK_IDS.positiveIntentRate);
    expect(rate?.passed).toBe(false);
    expect(rate?.detail).toContain('no outreach delivered yet');
  });
});

describe('gate — the early-exit for inbound demand', () => {
  it('waives the outreach-volume requirement only when every threshold is exceeded', async () => {
    const { db } = await freshDb(SCALED);
    const { opportunityId } = await seed(db, {
      prospects: 5,
      delivered: 1,
      commitments: {
        'a.example.com': ['EXPLICIT_PRICE_ACCEPTANCE', 'INSTALL_REQUEST'],
        'b.example.com': ['PILOT_SIGNUP', 'ONBOARDING_DETAILS'],
        'c.example.com': ['EXPLICIT_PRICE_ACCEPTANCE', 'TRIAL_REQUEST'],
        'd.example.com': ['PILOT_SIGNUP', 'INSTALL_REQUEST'],
      },
    });

    const evaluation = await evaluateGate(opportunityId);
    const volume = evaluation.checks.find((c) => c.id === CHECK_IDS.outreachVolume);

    expect(volume?.passed).toBe(true);
    expect(volume?.detail).toContain('inbound demand already exceeded every commitment threshold');
    expect(evaluation.passed).toBe(true);
  });
});

describe('gate — EXTREME_VALIDATION', () => {
  it('blocks a campaign that would otherwise pass', async () => {
    const { db } = await freshDb({ ...SCALED, EXTREME_VALIDATION: 'true' });
    const { opportunityId } = await seed(db);

    const evaluation = await evaluateGate(opportunityId);

    expect(evaluation.passed).toBe(false);
    expect(ids(evaluation.unmetChecks)).toEqual([CHECK_IDS.extremeValidationMonetary]);
    expect(evaluation.unmetChecks[0]?.detail).toContain('EXTREME_VALIDATION requires one of');
  });

  it('accepts a refundable deposit as the monetary commitment', async () => {
    const { db } = await freshDb({ ...SCALED, EXTREME_VALIDATION: 'true' });
    const { opportunityId } = await seed(db, {
      commitments: {
        'alpha.example.com': ['EXPLICIT_PRICE_ACCEPTANCE', 'INSTALL_REQUEST', 'DEPOSIT'],
        'beta.example.com': ['PILOT_SIGNUP', 'ONBOARDING_DETAILS'],
        'gamma.example.com': ['EXPLICIT_PRICE_ACCEPTANCE', 'TRIAL_REQUEST'],
      },
    });

    const evaluation = await evaluateGate(opportunityId);

    expect(evaluation.unmetChecks).toEqual([]);
    expect(evaluation.passed).toBe(true);
  });

  it('is off unless it is explicitly switched on', async () => {
    const { db } = await freshDb(SCALED);
    const { opportunityId } = await seed(db);

    const evaluation = await evaluateGate(opportunityId);

    expect(ids(evaluation.checks)).not.toContain(CHECK_IDS.extremeValidationMonetary);
  });
});

describe('gate — the decision is a pure function of its inputs', () => {
  it('produces the same answer twice for the same inputs', async () => {
    const { db } = await freshDb(SCALED);
    const { opportunityId } = await seed(db);

    const inputs = await collectGateInputs(opportunityId);
    const first = decideGate(inputs);
    const second = decideGate(inputs);

    expect(ids(first.checks)).toEqual(ids(second.checks));
    expect(first.passed).toBe(second.passed);
    expect(first.checks.map((c) => c.detail)).toEqual(second.checks.map((c) => c.detail));
  });
});
