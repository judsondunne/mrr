/**
 * PUBLIC API — PRICE EXPERIMENTS. Owned by the outreach agent.
 *
 * A prospect sees exactly ONE price, permanently. Selection optimises expected
 * MRR per 100 qualified prospects — not conversion rate, because $9 x 12 can
 * lose to $29 x 7.
 *
 * Two invariants this file exists to keep:
 *
 *   1. PRICE STABILITY. `price_assignments` has a UNIQUE (campaign_id,
 *      prospect_id) index and is written once. Every quote — the initial
 *      email, both follow-ups and every auto-reply — reads it back. Nobody
 *      ever sees a different number halfway through a thread, which would be
 *      both dishonest and would destroy the experiment.
 *   2. THE DECISION METRIC IS MONEY. `bestPrice` ranks by expected MRR per 100
 *      delivered, and refuses to answer at all until every arm has a real
 *      sample. A cheaper price almost always converts better; that is not the
 *      same as being the right price.
 */
import { getConfig } from '../lib/config';
import { getDb, many, one, toNumber } from '../lib/db';
import { newId } from '../lib/hash';
import { createLogger } from '../lib/logger';
import { PRICE_ACCEPTANCE_TYPES } from '../lib/contracts';

const logger = createLogger('autonomy:pricing');

export interface PriceArm {
  priceMonthly: number;
  assigned: number;
  delivered: number;
  commitments: number;
  priceAcceptances: number;
  expectedMrrPer100: number;
  hasSufficientSample: boolean;
}

/** `(commitments / max(delivered,1)) * 100 * priceMonthly`. Money, not rate. */
export function expectedMrrPer100(arm: {
  delivered: number;
  commitments: number;
  priceMonthly: number;
}): number {
  const delivered = Math.max(Number(arm.delivered) || 0, 0);
  const commitments = Math.max(Number(arm.commitments) || 0, 0);
  const price = Number(arm.priceMonthly) || 0;

  // No deliveries means no evidence, so there is no rate to project. Clamping
  // the denominator to 1 instead would have made an arm with zero delivered
  // and one stray commitment score as if every prospect converted — the
  // highest score of any arm, from the least evidence.
  if (delivered === 0) return 0;

  // A commitment rate above 1 is impossible; if the counts ever disagree,
  // refuse to extrapolate past certainty.
  const rate = Math.min(commitments / delivered, 1);
  return round4(rate * 100 * price);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

export async function ensurePriceExperiments(
  campaignId: string,
  prices: number[],
): Promise<PriceArm[]> {
  const campaign = await one<{ opportunity_id: string }>(
    'SELECT opportunity_id FROM campaigns WHERE id = $1',
    [campaignId],
  );
  if (!campaign) return [];

  const unique = Array.from(
    new Set(prices.map((p) => round2(Number(p))).filter((p) => Number.isFinite(p) && p > 0)),
  ).sort((a, b) => a - b);
  if (unique.length === 0) return priceArms(campaignId);

  const db = await getDb();
  for (const price of unique) {
    await db.query(
      `INSERT INTO pricing_experiments (id, opportunity_id, campaign_id, price_monthly)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (campaign_id, price_monthly) DO NOTHING`,
      [newId('px'), campaign.opportunity_id, campaignId, price],
    );
  }
  logger.info('price experiment arms ensured', { campaignId, prices: unique });
  return priceArms(campaignId);
}

interface ExperimentRow {
  id: string;
  price_monthly: string | number;
  assigned: string | number;
  enabled: boolean;
}

async function enabledArms(campaignId: string): Promise<ExperimentRow[]> {
  return many<ExperimentRow>(
    `SELECT id, price_monthly, assigned, enabled
       FROM pricing_experiments
      WHERE campaign_id = $1 AND enabled = true
      ORDER BY price_monthly ASC`,
    [campaignId],
  );
}

/**
 * Stable and permanent: the same prospect always gets the same price.
 *
 * Allocation is deterministic least-assigned-first (ties broken by the lower
 * price), so arms stay balanced without a random number generator that would
 * make a run impossible to reproduce.
 */
export async function assignPrice(params: {
  campaignId: string;
  prospectId: string;
}): Promise<number> {
  const existing = await getAssignedPrice(params);
  if (existing !== null) return existing;

  const arms = await enabledArms(params.campaignId);
  const db = await getDb();

  let price: number;
  let experimentId: string | null = null;
  if (arms.length === 0) {
    // No experiment running: the campaign's own price is the assignment, and
    // it is still persisted so every later read has one authoritative answer.
    const campaign = await one<{ price_monthly: string | number }>(
      'SELECT price_monthly FROM campaigns WHERE id = $1',
      [params.campaignId],
    );
    price = round2(toNumber(campaign?.price_monthly));
  } else {
    let chosen = arms[0]!;
    for (const arm of arms) {
      if (toNumber(arm.assigned) < toNumber(chosen.assigned)) chosen = arm;
    }
    price = round2(toNumber(chosen.price_monthly));
    experimentId = chosen.id;
  }

  const res = await db.query<{ id: string }>(
    `INSERT INTO price_assignments (id, campaign_id, prospect_id, price_monthly, experiment_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (campaign_id, prospect_id) DO NOTHING
     RETURNING id`,
    [newId('pa'), params.campaignId, params.prospectId, price, experimentId],
  );

  if (res.rowCount === 1 && experimentId) {
    await db.query('UPDATE pricing_experiments SET assigned = assigned + 1 WHERE id = $1', [experimentId]);
  }

  // Re-read rather than trusting the local variable: if a concurrent run won
  // the insert, its price is the real one.
  const settled = await getAssignedPrice(params);
  return settled ?? price;
}

/** The authoritative price for this prospect. Null when none was assigned. */
export async function getAssignedPrice(params: {
  campaignId: string;
  prospectId: string;
}): Promise<number | null> {
  const row = await one<{ price_monthly: string | number }>(
    'SELECT price_monthly FROM price_assignments WHERE campaign_id = $1 AND prospect_id = $2',
    [params.campaignId, params.prospectId],
  );
  if (!row) return null;
  const price = toNumber(row.price_monthly);
  return Number.isFinite(price) && price > 0 ? round2(price) : null;
}

/**
 * Live arm statistics, measured from the real rows rather than from counters
 * that could drift. `delivered` and `commitments` are counted per PROSPECT, so
 * one company replying three times is still one data point.
 */
export async function priceArms(campaignId: string): Promise<PriceArm[]> {
  const cfg = getConfig();
  const acceptanceTypes = [...PRICE_ACCEPTANCE_TYPES];
  const typePlaceholders = acceptanceTypes.map((_, i) => `$${i + 2}`).join(',');

  const rows = await many<{
    price_monthly: string | number;
    assigned: string | number;
    delivered: string | number;
    commitments: string | number;
    price_acceptances: string | number;
  }>(
    `SELECT a.price_monthly,
            COUNT(DISTINCT a.prospect_id) AS assigned,
            COUNT(DISTINCT m.prospect_id) AS delivered,
            COUNT(DISTINCT c.prospect_id) AS commitments,
            COUNT(DISTINCT CASE WHEN c.type IN (${typePlaceholders}) THEN c.prospect_id END) AS price_acceptances
       FROM price_assignments a
       LEFT JOIN messages m
              ON m.prospect_id = a.prospect_id
             AND m.campaign_id = a.campaign_id
             AND m.direction = 'OUTBOUND'
             AND m.delivered_at IS NOT NULL
       LEFT JOIN commitments c
              ON c.prospect_id = a.prospect_id
             AND c.campaign_id = a.campaign_id
      WHERE a.campaign_id = $1
      GROUP BY a.price_monthly
      ORDER BY a.price_monthly ASC`,
    [campaignId, ...acceptanceTypes],
  );

  const measured = new Map<number, PriceArm>();
  for (const row of rows) {
    const priceMonthly = round2(toNumber(row.price_monthly));
    const delivered = toNumber(row.delivered);
    const commitments = toNumber(row.commitments);
    measured.set(priceMonthly, {
      priceMonthly,
      assigned: toNumber(row.assigned),
      delivered,
      commitments,
      priceAcceptances: toNumber(row.price_acceptances),
      expectedMrrPer100: expectedMrrPer100({ delivered, commitments, priceMonthly }),
      hasSufficientSample: delivered >= cfg.learning.minDeliveredForVariantComparison,
    });
  }

  // Declared arms that nobody has been assigned to yet still exist, and they
  // count as "insufficient sample" so a premature winner cannot be declared.
  const declared = await enabledArms(campaignId);
  for (const arm of declared) {
    const priceMonthly = round2(toNumber(arm.price_monthly));
    if (!measured.has(priceMonthly)) {
      measured.set(priceMonthly, {
        priceMonthly,
        assigned: 0,
        delivered: 0,
        commitments: 0,
        priceAcceptances: 0,
        expectedMrrPer100: 0,
        hasSufficientSample: false,
      });
    }
  }

  const arms = [...measured.values()].sort((a, b) => a.priceMonthly - b.priceMonthly);
  await persistArmStats(campaignId, arms);
  return arms;
}

/** Keeps `pricing_experiments` readable for the dashboard and post-mortems. */
async function persistArmStats(campaignId: string, arms: PriceArm[]): Promise<void> {
  if (arms.length === 0) return;
  const db = await getDb();
  for (const arm of arms) {
    await db.query(
      `UPDATE pricing_experiments
          SET assigned = $3, delivered = $4, commitments = $5,
              price_acceptances = $6, expected_mrr_per_100 = $7
        WHERE campaign_id = $1 AND price_monthly = $2`,
      [
        campaignId,
        arm.priceMonthly,
        arm.assigned,
        arm.delivered,
        arm.commitments,
        arm.priceAcceptances,
        arm.expectedMrrPer100,
      ],
    );
  }
}

/**
 * Null until every candidate arm has a sufficient sample.
 *
 * Then the winner is the highest expected MRR per 100 delivered. This is the
 * whole point: $9 converting at 12% earns $108 per 100, $29 converting at 7%
 * earns $203. Ranking by conversion rate would pick the wrong one.
 */
export async function bestPrice(campaignId: string): Promise<PriceArm | null> {
  const arms = await priceArms(campaignId);
  if (arms.length === 0) return null;
  if (arms.some((arm) => !arm.hasSufficientSample)) {
    logger.info('price comparison withheld: at least one arm is under-sampled', { campaignId });
    return null;
  }

  let winner = arms[0]!;
  for (const arm of arms) {
    if (arm.expectedMrrPer100 > winner.expectedMrrPer100) winner = arm;
  }
  return winner;
}
