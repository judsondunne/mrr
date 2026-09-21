/**
 * Cost intelligence: sub-budgets, borrowing, the global cap, and the
 * information-per-dollar preference that decides where the next dollar goes.
 *
 * Everything here runs against a real PGlite database with the real
 * migrations. Nothing is mocked and nothing touches the network.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { freshDb, teardown, insertOpportunity, insertProspect, insertCampaign, insertCommitment } from '../helpers';
import { getDb, toNumber } from '../../src/lib/db';
import { recordCost } from '../../src/lib/cost';
import { resetConfigCache } from '../../src/lib/config';
import {
  availableForPhase,
  canSpend,
  expectedInformationValue,
  getBudgetReport,
  opportunitySpend,
  recordPhaseSpend,
  SPEND_PHASES,
} from '../../src/autonomy/budget';
import type { SpendPhase } from '../../src/autonomy/types';

/** Env this file sets directly; helpers.freshDb() does not know about these. */
const OWNED_ENV = [
  'BUDGET_DISCOVERY_PCT',
  'BUDGET_RESEARCH_PCT',
  'BUDGET_PROSPECTING_PCT',
  'BUDGET_REPLY_PCT',
  'BUDGET_FINAL_ANALYSIS_PCT',
  'MAX_RESEARCH_OPPORTUNITIES',
];

afterEach(async () => {
  for (const key of OWNED_ENV) delete process.env[key];
  resetConfigCache();
  await teardown();
});

/** Books LLM spend the way the metered call sites do. */
async function spend(usd: number, phase: SpendPhase | null, opportunityId: string | null = null): Promise<void> {
  await recordCost({
    provider: 'anthropic',
    resourceType: 'LLM_INPUT_TOKENS',
    quantity: 1000,
    estimatedCost: usd,
    phase: phase ?? undefined,
    opportunityId,
  });
}

function phase(report: Awaited<ReturnType<typeof getBudgetReport>>, name: SpendPhase) {
  const found = report.phases.find((p) => p.phase === name);
  if (!found) throw new Error(`no phase ${name} in report`);
  return found;
}

describe('sub-budget allocation', () => {
  it('splits the global budget by the configured percentages', async () => {
    await freshDb({ MONTHLY_LLM_BUDGET_USD: '20' });
    const report = await getBudgetReport();

    expect(report.globalBudgetUsd).toBe(20);
    expect(phase(report, 'DISCOVERY').allocatedUsd).toBeCloseTo(3, 6); // 15%
    expect(phase(report, 'RESEARCH').allocatedUsd).toBeCloseTo(6, 6); // 30%
    expect(phase(report, 'PROSPECTING').allocatedUsd).toBeCloseTo(5, 6); // 25%
    expect(phase(report, 'REPLY').allocatedUsd).toBeCloseTo(4, 6); // 20%
    expect(phase(report, 'FINAL_ANALYSIS').allocatedUsd).toBeCloseTo(2, 6); // 10%

    const allocated = report.phases.reduce((n, p) => n + p.allocatedUsd, 0);
    expect(allocated).toBeLessThanOrEqual(report.globalBudgetUsd);
  });

  it('scales a mis-configured over-100% split down instead of honouring it', async () => {
    process.env.BUDGET_DISCOVERY_PCT = '0.9';
    process.env.BUDGET_RESEARCH_PCT = '0.9';
    process.env.BUDGET_PROSPECTING_PCT = '0.9';
    process.env.BUDGET_REPLY_PCT = '0.9';
    process.env.BUDGET_FINAL_ANALYSIS_PCT = '0.9';
    await freshDb({ MONTHLY_LLM_BUDGET_USD: '20' });

    const report = await getBudgetReport();
    const allocated = report.phases.reduce((n, p) => n + p.allocatedUsd, 0);
    // 4.5x over-subscribed in config; still never more than the hard cap.
    expect(allocated).toBeLessThanOrEqual(20 + 1e-6);
    for (const p of report.phases) expect(p.allocatedUsd).toBeCloseTo(4, 5);
  });

  it('reads actual spend from cost_ledger, grouped by phase', async () => {
    await freshDb({ MONTHLY_LLM_BUDGET_USD: '20' });
    await spend(1.25, 'RESEARCH');
    await spend(0.5, 'DISCOVERY');
    await spend(0.25, null); // unattributed: global only

    const report = await getBudgetReport();
    expect(phase(report, 'RESEARCH').spentUsd).toBeCloseTo(1.25, 6);
    expect(phase(report, 'RESEARCH').remainingUsd).toBeCloseTo(4.75, 6);
    expect(phase(report, 'DISCOVERY').spentUsd).toBeCloseTo(0.5, 6);
    expect(phase(report, 'PROSPECTING').spentUsd).toBe(0);
    expect(report.globalSpentUsd).toBeCloseTo(2.0, 6);
    expect(report.globalRemainingUsd).toBeCloseTo(18.0, 6);
    expect(report.exhausted).toBe(false);
  });
});

describe('borrowing between sub-budgets', () => {
  it('lets a spent-out phase borrow another phase unused allocation', async () => {
    await freshDb({ MONTHLY_LLM_BUDGET_USD: '20' });
    await spend(3, 'DISCOVERY'); // exactly its 15% allocation

    const report = await getBudgetReport();
    expect(phase(report, 'DISCOVERY').remainingUsd).toBe(0);

    // Its own allocation is gone, but the other four are untouched.
    expect(await canSpend('DISCOVERY', 1)).toBe(true);
    expect(availableForPhase(report, 'DISCOVERY')).toBeCloseTo(17, 6);
  });

  it('never lets borrowing push the total past the global cap', async () => {
    await freshDb({ MONTHLY_LLM_BUDGET_USD: '20' });
    await spend(3, 'DISCOVERY');
    await spend(6, 'RESEARCH');
    await spend(5, 'PROSPECTING');
    await spend(4, 'REPLY');
    await spend(1, 'FINAL_ANALYSIS');

    const report = await getBudgetReport();
    expect(report.globalRemainingUsd).toBeCloseTo(1, 6);
    // Only FINAL_ANALYSIS has anything left, and it is $1.
    expect(availableForPhase(report, 'DISCOVERY')).toBeCloseTo(1, 6);
    expect(await canSpend('DISCOVERY', 1)).toBe(true);
    expect(await canSpend('DISCOVERY', 1.5)).toBe(false);
  });

  it('refuses when the global cap is exhausted even though the phase has room', async () => {
    await freshDb({ MONTHLY_LLM_BUDGET_USD: '20' });
    // Unattributed spend: every phase allocation is untouched.
    await spend(20, null);

    const report = await getBudgetReport();
    expect(phase(report, 'RESEARCH').remainingUsd).toBeCloseTo(6, 6);
    expect(report.globalRemainingUsd).toBe(0);
    expect(report.exhausted).toBe(true);

    for (const p of SPEND_PHASES) {
      expect(await canSpend(p, 0.01), `${p} must be refused when the global cap is gone`).toBe(false);
    }
  });

  it('refuses a nonsense projection rather than guessing', async () => {
    await freshDb({ MONTHLY_LLM_BUDGET_USD: '20' });
    expect(await canSpend('RESEARCH', Number.NaN)).toBe(false);
    expect(await canSpend('RESEARCH', -1)).toBe(false);
  });
});

describe('per-opportunity spend', () => {
  it('rolls booked phase spend into the opportunity columns', async () => {
    const { db } = await freshDb();
    const opportunityId = await insertOpportunity(db);

    await recordPhaseSpend({ phase: 'RESEARCH', opportunityId, usd: 0.2 });
    await recordPhaseSpend({ phase: 'PROSPECTING', opportunityId, usd: 0.05 });
    await recordPhaseSpend({ phase: 'REPLY', opportunityId, usd: 0.01 });

    const spent = await opportunitySpend(opportunityId);
    expect(spent.research).toBeCloseTo(0.2, 6);
    expect(spent.prospecting).toBeCloseTo(0.05, 6);
    expect(spent.validation).toBeCloseTo(0.01, 6);
    expect(spent.total).toBeCloseTo(0.26, 6);

    const row = await db.query<{ research_spend_usd: string; prospecting_spend_usd: string }>(
      'SELECT research_spend_usd, prospecting_spend_usd FROM opportunities WHERE id = $1',
      [opportunityId],
    );
    expect(toNumber(row.rows[0]?.research_spend_usd)).toBeCloseTo(0.2, 6);
    expect(toNumber(row.rows[0]?.prospecting_spend_usd)).toBeCloseTo(0.05, 6);
  });

  it('counts metered cost attributed to the opportunity', async () => {
    const { db } = await freshDb();
    const opportunityId = await insertOpportunity(db);
    await spend(0.4, 'RESEARCH', opportunityId);

    const spent = await opportunitySpend(opportunityId);
    expect(spent.research).toBeCloseTo(0.4, 6);
    expect(spent.total).toBeCloseTo(0.4, 6);
  });

  it('ignores a zero or negative booking', async () => {
    const { db } = await freshDb();
    const opportunityId = await insertOpportunity(db);
    await recordPhaseSpend({ phase: 'RESEARCH', opportunityId, usd: 0 });
    await recordPhaseSpend({ phase: 'RESEARCH', opportunityId, usd: -5 });
    expect((await opportunitySpend(opportunityId)).total).toBe(0);
  });
});

describe('expected information value', () => {
  /** A category with real prospects, close to a decision, barely any spend. */
  async function strongCheapOpportunity(db: Awaited<ReturnType<typeof freshDb>>['db']): Promise<string> {
    const id = await insertOpportunity(db, {
      state: 'CAMPAIGN_READY',
      evidence_confidence: 'HIGH',
      category: 'wholesale-pricing',
    });
    await db.query('UPDATE opportunities SET research_stage = 4 WHERE id = $1', [id]);
    for (let i = 0; i < 12; i += 1) {
      await insertProspect(db, id, { domain: `strong-${i}.example.com` });
    }
    await spend(0.02, 'PROSPECTING', id);
    return id;
  }

  /** A weak category with nothing to show for a lot more spend. */
  async function weakExpensiveOpportunity(db: Awaited<ReturnType<typeof freshDb>>['db']): Promise<string> {
    const id = await insertOpportunity(db, {
      state: 'CATEGORY_VERIFYING',
      evidence_confidence: 'LOW',
      category: 'weak-category',
    });
    await spend(0.4, 'RESEARCH', id);
    return id;
  }

  it('prefers the cheaper, more informative opportunity', async () => {
    const { db } = await freshDb();
    const strong = await strongCheapOpportunity(db);
    const weak = await weakExpensiveOpportunity(db);

    const strongValue = await expectedInformationValue(strong);
    const weakValue = await expectedInformationValue(weak);

    expect(strongValue).toBeGreaterThan(weakValue);
    expect(strongValue).toBeGreaterThan(0);
    expect(weakValue).toBeGreaterThanOrEqual(0);
  });

  it('is information per dollar: identical evidence, more spent, lower value', async () => {
    const { db } = await freshDb();
    const cheap = await insertOpportunity(db, { state: 'PROSPECTING', evidence_confidence: 'HIGH', category: 'a' });
    const costly = await insertOpportunity(db, { state: 'PROSPECTING', evidence_confidence: 'HIGH', category: 'b' });
    await spend(0.02, 'RESEARCH', cheap);
    await spend(0.6, 'RESEARCH', costly);

    expect(await expectedInformationValue(cheap)).toBeGreaterThan(await expectedInformationValue(costly));
  });

  it('rewards observed commitments, not opinions', async () => {
    const { db } = await freshDb();
    const withCommitments = await insertOpportunity(db, {
      state: 'VALIDATING',
      evidence_confidence: 'HIGH',
      category: 'committed',
    });
    const without = await insertOpportunity(db, {
      state: 'VALIDATING',
      evidence_confidence: 'HIGH',
      category: 'quiet',
    });
    const campaign = await insertCampaign(db, withCommitments);
    for (const company of ['one.example.com', 'two.example.com', 'three.example.com']) {
      await insertCommitment(db, campaign, company, 'EXPLICIT_PRICE_ACCEPTANCE');
    }

    expect(await expectedInformationValue(withCommitments)).toBeGreaterThan(
      await expectedInformationValue(without),
    );
  });

  it('is worth nothing once an opportunity is dead, and says so in the column', async () => {
    const { db } = await freshDb();
    const id = await insertOpportunity(db, { state: 'VALIDATION_FAILED' });
    expect(await expectedInformationValue(id)).toBe(0);

    const row = await db.query<{ expected_information_value: string }>(
      'SELECT expected_information_value FROM opportunities WHERE id = $1',
      [id],
    );
    expect(toNumber(row.rows[0]?.expected_information_value)).toBe(0);
  });

  it('persists the score and is deterministic across calls', async () => {
    const { db } = await freshDb();
    const id = await insertOpportunity(db, { state: 'PROSPECTING', evidence_confidence: 'MEDIUM' });
    await insertProspect(db, id);

    const first = await expectedInformationValue(id);
    const second = await expectedInformationValue(id);
    expect(second).toBe(first);

    const stored = await (await getDb()).query<{ expected_information_value: string }>(
      'SELECT expected_information_value FROM opportunities WHERE id = $1',
      [id],
    );
    expect(toNumber(stored.rows[0]?.expected_information_value)).toBeCloseTo(first, 5);
  });

  it('returns zero for an opportunity that does not exist', async () => {
    await freshDb();
    expect(await expectedInformationValue('opp_missing')).toBe(0);
  });
});
