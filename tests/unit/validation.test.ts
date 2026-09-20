/**
 * Campaign evaluation, campaign health, metric snapshots — and the two
 * structural tests that keep the absolute principle true:
 *
 *   1. no model call exists anywhere under src/pipeline/validation/
 *   2. __mintGateToken is imported in exactly one file in the whole of src/
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import {
  evaluateCampaigns,
  checkCampaignHealth,
  snapshotCampaignMetrics,
} from '../../src/pipeline/validation/evaluate';
import { getCampaignCounts } from '../../src/pipeline/validation/counts';
import { getCustomerDerivedRequirements } from '../../src/pipeline/validation/evidence';

afterEach(async () => {
  await teardown();
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const SCALED = {
  MIN_QUALIFIED_PROSPECTS_FOR_GATE: '5',
  MIN_DELIVERED_BEFORE_STANDARD_EVALUATION: '6',
  MIN_UNIQUE_STRONG_COMMITMENTS: '3',
  MIN_UNIQUE_PRICE_ACCEPTANCES: '2',
  MIN_UNIQUE_ACTION_COMMITMENTS: '2',
  MIN_POSITIVE_INTENT_RATE: '0.3',
  INITIAL_EMAIL_BATCH: '5',
  MAX_EMAILS_PER_CAMPAIGN: '150',
  OWNER_NOTIFICATION_EMAIL: 'owner@example.com',
};

const WEDGE = {
  productName: 'Wholesale Minimums',
  statement: 'For Shopify B2B merchants, enforce per-customer order minimums without a developer.',
  coreWorkflow: 'Merchant sets a minimum per customer group; checkout blocks orders below it.',
  v1Features: ['Per-group minimums', 'Checkout enforcement', 'CSV import', 'Audit log'],
  excludedFromV1: ['Multi-currency minimums'],
  proposedPriceMonthly: 19,
  estimatedBuildDays: 5,
  whoItIsFor: 'Shopify B2B merchants with wholesale customers',
  oneSentenceOutcome: 'Wholesale orders below a merchant-set minimum stop reaching fulfilment.',
};

interface SeedOptions {
  prospects?: number;
  delivered?: number;
  commitments?: Record<string, string[]>;
  campaignState?: string;
  opportunityState?: string;
  customerRequirement?: boolean;
}

const PASSING_COMMITMENTS: Record<string, string[]> = {
  'alpha.example.com': ['EXPLICIT_PRICE_ACCEPTANCE', 'INSTALL_REQUEST'],
  'beta.example.com': ['PILOT_SIGNUP', 'ONBOARDING_DETAILS'],
  'gamma.example.com': ['EXPLICIT_PRICE_ACCEPTANCE', 'TRIAL_REQUEST'],
};

async function seed(
  db: Db,
  opts: SeedOptions = {},
): Promise<{ opportunityId: string; campaignId: string; prospectIds: string[] }> {
  const opportunityId = await insertOpportunity(db, {
    state: opts.opportunityState ?? 'VALIDATING',
    evidence_confidence: 'HIGH',
    estimated_build_days: 5,
    proposed_price_monthly: 19,
  });
  await db.query('UPDATE opportunities SET wedge_json = $2 WHERE id = $1', [
    opportunityId,
    JSON.stringify(WEDGE),
  ]);
  const campaignId = await insertCampaign(db, opportunityId, {
    price: 19,
    state: opts.campaignState ?? 'BATCH_1',
  });

  const prospects = opts.prospects ?? 6;
  const delivered = opts.delivered ?? 6;
  const prospectIds: string[] = [];
  for (let i = 0; i < Math.max(prospects, delivered); i += 1) {
    prospectIds.push(await insertProspect(db, opportunityId, { domain: `p${i}.example.com` }));
  }
  for (let i = 0; i < delivered; i += 1) {
    const prospectId = prospectIds[i];
    if (prospectId) await insertDeliveredMessage(db, campaignId, prospectId);
  }

  for (const [companyKey, types] of Object.entries(opts.commitments ?? PASSING_COMMITMENTS)) {
    for (const type of types) {
      await insertCommitment(db, campaignId, companyKey, type, {
        evidence: `${companyKey} committed: ${type}`,
      });
    }
  }

  if (opts.customerRequirement !== false) {
    await insertInbound(db, campaignId, prospectIds[0] ?? null, {
      classification: 'INTERESTED_STRONG',
      body: 'We would use this. We need CSV import for our wholesale accounts.',
      requestedFeature: 'CSV import of wholesale accounts',
    });
  }

  return { opportunityId, campaignId, prospectIds };
}

async function insertInbound(
  db: Db,
  campaignId: string,
  prospectId: string | null,
  opts: { classification: string; body: string; requestedFeature?: string | null; priceReaction?: string },
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

async function insertOutbound(
  db: Db,
  campaignId: string,
  prospectId: string,
  opts: { delivered?: boolean; hardBounce?: boolean; complaint?: boolean },
): Promise<void> {
  const id = newId('msg');
  await db.query(
    `INSERT INTO messages
       (id, campaign_id, prospect_id, direction, sequence_step, subject, body, sent_at,
        delivered_at, bounced_at, bounce_type, complained_at, status, idempotency_key)
     VALUES ($1,$2,$3,'OUTBOUND',0,'s','b', now(), $4, $5, $6, $7, $8, $9)`,
    [
      id,
      campaignId,
      prospectId,
      opts.delivered ? new Date().toISOString() : null,
      opts.hardBounce ? new Date().toISOString() : null,
      opts.hardBounce ? 'HARD' : null,
      opts.complaint ? new Date().toISOString() : null,
      opts.hardBounce ? 'BOUNCED' : opts.complaint ? 'COMPLAINED' : 'SENT',
      `${campaignId}:${id}`,
    ],
  );
}

async function stateOf(db: Db, opportunityId: string): Promise<string> {
  const res = await db.query<{ state: string }>('SELECT state FROM opportunities WHERE id = $1', [
    opportunityId,
  ]);
  return res.rows[0]?.state ?? 'MISSING';
}

async function rejectionOf(db: Db, opportunityId: string): Promise<string | null> {
  const res = await db.query<{ rejection_reason: string | null }>(
    'SELECT rejection_reason FROM opportunities WHERE id = $1',
    [opportunityId],
  );
  return res.rows[0]?.rejection_reason ?? null;
}

// --- structural guarantees ---------------------------------------------------

async function listTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listTsFiles(full)));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** Removes comments so a promise in prose cannot be mistaken for a call. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
}

describe('structural: no model call may exist under src/pipeline/validation/', () => {
  const forbidden: Array<{ label: string; pattern: RegExp }> = [
    { label: 'llm', pattern: /llm/i },
    { label: 'anthropic', pattern: /anthropic/i },
    { label: 'openai', pattern: /openai/i },
    { label: 'claude', pattern: /claude/i },
    { label: 'gpt', pattern: /\bgpt/i },
    { label: 'prompt', pattern: /prompt/i },
    { label: 'completion call', pattern: /\bcomplete\s*\(/i },
    { label: 'search provider', pattern: /lib\/search/i },
    { label: 'outbound fetch', pattern: /lib\/fetch|\bfetch\s*\(/i },
  ];

  it('greps its own source tree and finds nothing', async () => {
    const dir = path.join(REPO_ROOT, 'src/pipeline/validation');
    const files = await listTsFiles(dir);

    expect(files.length).toBeGreaterThanOrEqual(5);

    const offences: string[] = [];
    for (const file of files) {
      const code = stripComments(await readFile(file, 'utf8'));
      for (const rule of forbidden) {
        if (rule.pattern.test(code)) {
          offences.push(`${path.relative(REPO_ROOT, file)} contains "${rule.label}"`);
        }
      }
    }

    expect(offences).toEqual([]);
  });

  it('imports __mintGateToken in exactly one file in src/', async () => {
    const files = await listTsFiles(path.join(REPO_ROOT, 'src'));
    const definition = path.join(REPO_ROOT, 'src/lib/state-machine.ts');

    const importers: string[] = [];
    for (const file of files) {
      if (file === definition) continue;
      const code = await readFile(file, 'utf8');
      if (code.includes('__mintGateToken')) importers.push(path.relative(REPO_ROOT, file));
    }

    expect(importers).toEqual(['src/pipeline/validation/gate.ts']);
  });

  it('never writes opportunities.state with raw SQL', async () => {
    const files = await listTsFiles(path.join(REPO_ROOT, 'src/pipeline'));
    const offences: string[] = [];
    for (const file of files) {
      const code = stripComments(await readFile(file, 'utf8'));
      if (/UPDATE\s+opportunities\s+SET[^;]*\bstate\s*=/is.test(code)) {
        offences.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(offences).toEqual([]);
  });
});

// --- counting ----------------------------------------------------------------

describe('campaign counts', () => {
  it('counts only delivered OUTBOUND messages as delivered', async () => {
    const { db } = await freshDb(SCALED);
    const { campaignId, prospectIds } = await seed(db, { delivered: 3, prospects: 6 });
    const extra = prospectIds[4];
    if (extra) await insertOutbound(db, campaignId, extra, { delivered: false });

    const counts = await getCampaignCounts(campaignId);
    expect(counts.delivered).toBe(3);
  });

  it('counts replies, positive replies and negative replies separately', async () => {
    const { db } = await freshDb(SCALED);
    const { campaignId, prospectIds } = await seed(db);
    await insertInbound(db, campaignId, prospectIds[1] ?? null, {
      classification: 'NOT_INTERESTED',
      body: 'No thanks.',
    });
    await insertInbound(db, campaignId, prospectIds[2] ?? null, {
      classification: 'PRICE_ACCEPTED',
      body: 'That price works for us.',
    });

    const counts = await getCampaignCounts(campaignId);
    expect(counts.replied).toBe(3);
    expect(counts.positiveReplies).toBe(2);
    expect(counts.negativeReplies).toBe(1);
  });

  it('extracts customer-derived requirements from real reply rows only', async () => {
    const { db } = await freshDb(SCALED);
    const { campaignId, prospectIds } = await seed(db);
    await insertInbound(db, campaignId, prospectIds[1] ?? null, {
      classification: 'FEATURE_REQUIREMENT',
      body: 'We would need per-warehouse minimums. Otherwise it will not work for us.',
      requestedFeature: null,
    });

    const requirements = await getCustomerDerivedRequirements(campaignId);
    expect(requirements.length).toBe(2);
    const texts = requirements.map((r) => r.requirement);
    expect(texts).toContain('CSV import of wholesale accounts');
    expect(texts).toContain('We would need per-warehouse minimums.');
    for (const requirement of requirements) {
      expect(requirement.sourceRowIds.length).toBeGreaterThan(0);
    }
  });
});

// --- health ------------------------------------------------------------------

describe('campaign health', () => {
  it('is healthy when nothing has been sent', async () => {
    const { db } = await freshDb(SCALED);
    const { campaignId } = await seed(db, { delivered: 0, prospects: 6 });

    const health = await checkCampaignHealth(campaignId);
    expect(health.healthy).toBe(true);
    expect(health.hardBounceRate).toBe(0);
    expect(health.reason).toBeNull();
  });

  it('fails on a hard bounce rate over the configured ceiling', async () => {
    const { db } = await freshDb(SCALED);
    const { campaignId, prospectIds } = await seed(db, { delivered: 4, prospects: 6 });
    for (const prospectId of prospectIds.slice(4, 6)) {
      await insertOutbound(db, campaignId, prospectId, { hardBounce: true });
    }

    const health = await checkCampaignHealth(campaignId);
    expect(health.healthy).toBe(false);
    expect(health.hardBounceRate).toBeCloseTo(2 / 6, 5);
    expect(health.reason).toContain('hard bounce rate');
  });

  it('fails on a single complaint, because the configured ceiling is zero', async () => {
    const { db } = await freshDb(SCALED);
    const { campaignId, prospectIds } = await seed(db, { delivered: 5, prospects: 6 });
    const prospectId = prospectIds[5];
    if (prospectId) await insertOutbound(db, campaignId, prospectId, { complaint: true });

    const health = await checkCampaignHealth(campaignId);
    expect(health.healthy).toBe(false);
    expect(health.reason).toContain('complaint rate');
  });
});

// --- metrics -----------------------------------------------------------------

describe('campaign metrics snapshot', () => {
  it('records unique committed companies, not commitment rows', async () => {
    const { db } = await freshDb(SCALED);
    const { campaignId } = await seed(db, {
      commitments: {
        'one.example.com': ['EXPLICIT_PRICE_ACCEPTANCE', 'PILOT_SIGNUP', 'INSTALL_REQUEST'],
      },
    });

    await snapshotCampaignMetrics(campaignId);

    const res = await db.query<{ strong_commitments: number; unique_companies_committed: number }>(
      'SELECT strong_commitments, unique_companies_committed FROM campaign_metrics WHERE campaign_id = $1',
      [campaignId],
    );
    expect(Number(res.rows[0]?.strong_commitments)).toBe(3);
    expect(Number(res.rows[0]?.unique_companies_committed)).toBe(1);
  });
});

// --- evaluateCampaigns -------------------------------------------------------

describe('evaluateCampaigns', () => {
  it('advances a passing campaign VALIDATING -> VALIDATION_STRONG -> READY_TO_BUILD', async () => {
    const { db } = await freshDb(SCALED);
    const { opportunityId } = await seed(db);

    const evaluations = await evaluateCampaigns();

    expect(evaluations).toHaveLength(1);
    expect(evaluations[0]?.passed).toBe(true);
    expect(await stateOf(db, opportunityId)).toBe('READY_TO_BUILD');

    const transitions = await db.query<{ from_state: string; to_state: string }>(
      `SELECT from_state, to_state FROM audit_events
        WHERE entity_id = $1 AND event_type = 'STATE_TRANSITION'
        ORDER BY created_at ASC, id ASC`,
      [opportunityId],
    );
    expect(transitions.rows.map((r) => `${r.from_state}->${r.to_state}`)).toEqual([
      'VALIDATING->VALIDATION_STRONG',
      'VALIDATION_STRONG->READY_TO_BUILD',
    ]);
  });

  it('records a GATE_EVALUATION audit event carrying the whole check list', async () => {
    const { db } = await freshDb(SCALED);
    const { opportunityId } = await seed(db);

    await evaluateCampaigns();

    const res = await db.query<{ detail_json: unknown; reason: string }>(
      `SELECT detail_json, reason FROM audit_events
        WHERE entity_id = $1 AND event_type = 'GATE_EVALUATION'`,
      [opportunityId],
    );
    expect(res.rows).toHaveLength(1);
    const raw = res.rows[0]?.detail_json;
    const detail = (typeof raw === 'string' ? JSON.parse(raw) : raw) as {
      passed: boolean;
      checks: Array<{ id: string; detail: string }>;
    };
    expect(detail.passed).toBe(true);
    expect(detail.checks).toHaveLength(10);
    expect(detail.checks.every((c) => typeof c.detail === 'string' && c.detail.length > 0)).toBe(true);
  });

  it('is idempotent: a second run changes nothing', async () => {
    const { db } = await freshDb(SCALED);
    const { opportunityId } = await seed(db);

    const first = await evaluateCampaigns();
    const second = await evaluateCampaigns();

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(await stateOf(db, opportunityId)).toBe('READY_TO_BUILD');

    const transitions = await db.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM audit_events WHERE entity_id = $1 AND event_type = 'STATE_TRANSITION'`,
      [opportunityId],
    );
    expect(Number(transitions.rows[0]?.n)).toBe(2);
  });

  it('completes the campaign when that edge is legal', async () => {
    const { db } = await freshDb(SCALED);
    const { campaignId } = await seed(db, { campaignState: 'SCALING' });

    await evaluateCampaigns();

    const res = await db.query<{ state: string }>('SELECT state FROM campaigns WHERE id = $1', [
      campaignId,
    ]);
    expect(res.rows[0]?.state).toBe('COMPLETE');
  });

  it('moves CAMPAIGN_READY to VALIDATING once outreach has actually been delivered', async () => {
    const { db } = await freshDb(SCALED);
    const { opportunityId } = await seed(db, {
      opportunityState: 'CAMPAIGN_READY',
      delivered: 2,
      commitments: {},
      customerRequirement: false,
    });

    await evaluateCampaigns();

    expect(await stateOf(db, opportunityId)).toBe('VALIDATING');
  });

  it('leaves a mediocre campaign alone: not validated, not killed', async () => {
    const { db } = await freshDb(SCALED);
    const { opportunityId } = await seed(db, {
      commitments: { 'alpha.example.com': ['EXPLICIT_PRICE_ACCEPTANCE', 'INSTALL_REQUEST'] },
    });

    const evaluations = await evaluateCampaigns();

    expect(evaluations[0]?.passed).toBe(false);
    expect(await stateOf(db, opportunityId)).toBe('VALIDATING');
    const notifications = await db.query<{ n: string }>('SELECT COUNT(*) AS n FROM owner_notifications');
    expect(Number(notifications.rows[0]?.n)).toBe(0);
  });

  it('does not judge a campaign that has not yet delivered enough email', async () => {
    const { db } = await freshDb(SCALED);
    const { opportunityId } = await seed(db, {
      delivered: 2,
      commitments: {},
      customerRequirement: false,
    });

    await evaluateCampaigns();

    expect(await stateOf(db, opportunityId)).toBe('VALIDATING');
    expect(await rejectionOf(db, opportunityId)).toBeNull();
  });
});

describe('evaluateCampaigns — VALIDATION_FAILED records an exact reason', () => {
  it('NO_MEANINGFUL_RESPONSE when enough was delivered and nobody engaged', async () => {
    const { db } = await freshDb(SCALED);
    const { opportunityId, campaignId } = await seed(db, {
      delivered: 6,
      commitments: {},
      customerRequirement: false,
    });

    await evaluateCampaigns();

    expect(await stateOf(db, opportunityId)).toBe('VALIDATION_FAILED');
    expect(await rejectionOf(db, opportunityId)).toBe('NO_MEANINGFUL_RESPONSE');

    const campaign = await db.query<{ state: string }>('SELECT state FROM campaigns WHERE id = $1', [
      campaignId,
    ]);
    expect(campaign.rows[0]?.state).toBe('FAILED');

    const rejection = await db.query<{ reason: string; detail_json: unknown }>(
      `SELECT reason, detail_json FROM audit_events WHERE entity_id = $1 AND event_type = 'REJECTION'`,
      [opportunityId],
    );
    expect(rejection.rows[0]?.reason).toBe('NO_MEANINGFUL_RESPONSE');
  });

  it('NEGATIVE_SENTIMENT_DOMINANT when most replies are negative and nobody committed', async () => {
    const { db } = await freshDb(SCALED);
    const { opportunityId, campaignId, prospectIds } = await seed(db, {
      delivered: 6,
      commitments: {},
      customerRequirement: false,
    });
    for (let i = 0; i < 4; i += 1) {
      await insertInbound(db, campaignId, prospectIds[i] ?? null, {
        classification: 'NOT_INTERESTED',
        body: 'Not for us.',
      });
    }
    await insertInbound(db, campaignId, prospectIds[4] ?? null, {
      classification: 'ASKING_QUESTION',
      body: 'What is this?',
    });

    await evaluateCampaigns();

    expect(await stateOf(db, opportunityId)).toBe('VALIDATION_FAILED');
    expect(await rejectionOf(db, opportunityId)).toBe('NEGATIVE_SENTIMENT_DOMINANT');
  });

  it('PRICE_REJECTION_DOMINANT when most replies call the price too high', async () => {
    const { db } = await freshDb(SCALED);
    const { opportunityId, campaignId, prospectIds } = await seed(db, {
      delivered: 6,
      commitments: {},
      customerRequirement: false,
    });
    for (let i = 0; i < 4; i += 1) {
      await insertInbound(db, campaignId, prospectIds[i] ?? null, {
        classification: 'ASKING_QUESTION',
        body: 'Way too expensive for what it does.',
        priceReaction: 'TOO_HIGH',
      });
    }
    await insertInbound(db, campaignId, prospectIds[4] ?? null, {
      classification: 'INTERESTED_WEAK',
      body: 'Maybe later.',
    });

    await evaluateCampaigns();

    expect(await rejectionOf(db, opportunityId)).toBe('PRICE_REJECTION_DOMINANT');
  });

  it('ICP_DISCOVERY_FAILED when the list bounces, even before the standard volume', async () => {
    const { db } = await freshDb(SCALED);
    const { opportunityId, campaignId, prospectIds } = await seed(db, {
      delivered: 2,
      prospects: 6,
      commitments: {},
      customerRequirement: false,
    });
    for (const prospectId of prospectIds.slice(2, 6)) {
      await insertOutbound(db, campaignId, prospectId, { hardBounce: true });
    }

    await evaluateCampaigns();

    expect(await stateOf(db, opportunityId)).toBe('VALIDATION_FAILED');
    expect(await rejectionOf(db, opportunityId)).toBe('ICP_DISCOVERY_FAILED');
  });

  it('CAMPAIGN_HEALTH_FAILURE on a complaint, however early it arrives', async () => {
    const { db } = await freshDb(SCALED);
    const { opportunityId, campaignId, prospectIds } = await seed(db, {
      delivered: 2,
      prospects: 6,
      commitments: {},
      customerRequirement: false,
    });
    const prospectId = prospectIds[3];
    if (prospectId) await insertOutbound(db, campaignId, prospectId, { complaint: true });

    await evaluateCampaigns();

    expect(await stateOf(db, opportunityId)).toBe('VALIDATION_FAILED');
    expect(await rejectionOf(db, opportunityId)).toBe('CAMPAIGN_HEALTH_FAILURE');
  });

  it('kills a campaign that spent its whole allowance without clearing the gate', async () => {
    const { db } = await freshDb({ ...SCALED, MAX_EMAILS_PER_CAMPAIGN: '6' });
    const { opportunityId, campaignId, prospectIds } = await seed(db, {
      delivered: 6,
      commitments: { 'alpha.example.com': ['EXPLICIT_PRICE_ACCEPTANCE', 'INSTALL_REQUEST'] },
    });
    await insertInbound(db, campaignId, prospectIds[1] ?? null, {
      classification: 'INTERESTED_WEAK',
      body: 'Interesting, send more info.',
    });

    await evaluateCampaigns();

    expect(await stateOf(db, opportunityId)).toBe('VALIDATION_FAILED');
    expect(await rejectionOf(db, opportunityId)).toBe('NO_MEANINGFUL_RESPONSE');
    const rejection = await db.query<{ detail_json: unknown }>(
      `SELECT detail_json FROM audit_events WHERE entity_id = $1 AND event_type = 'REJECTION'`,
      [opportunityId],
    );
    const raw = rejection.rows[0]?.detail_json;
    const detail = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { detail: string };
    expect(detail.detail).toContain('exhausted');
  });
});
