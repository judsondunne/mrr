/**
 * PUBLIC API — WEDGE LAYER. Owned by the wedge/prospecting agent.
 */
import { Wedge, type RejectionReason } from '../../lib/contracts';
import { getDb } from '../../lib/db';
import { createLogger, errorToFields } from '../../lib/logger';
import { transitionOpportunity } from '../../lib/audit';
import { BudgetExceededError } from '../../lib/errors';
import { clusterComplaints } from './clustering';
import { generateWedge, type WedgeProblem } from './generate';

const logger = createLogger('wedge');

export interface WedgeResult {
  opportunityId: string;
  wedge: Wedge | null;
  clusterCount: number;
  rejected: boolean;
  rejectionDetail: string | null;
}

export const WEDGE_ACTOR = 'generate_wedges';

interface OpportunityRow {
  id: string;
  name: string;
  ecosystem: string;
  category: string;
  description: string;
  state: string;
  wedge_json: unknown;
}

async function loadOpportunity(opportunityId: string): Promise<OpportunityRow | null> {
  const db = await getDb();
  const res = await db.query<OpportunityRow>(
    `SELECT id, name, ecosystem, category, description, state, wedge_json
       FROM opportunities WHERE id = $1`,
    [opportunityId],
  );
  return res.rows[0] ?? null;
}

/** JSONB comes back parsed on one driver and as text on the other. */
export function parseWedgeJson(raw: unknown): Wedge | null {
  if (raw === null || raw === undefined) return null;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const parsed = Wedge.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Reads the stored wedge for an opportunity. Used by the prospecting layer. */
export async function loadWedgeFor(opportunityId: string): Promise<Wedge | null> {
  const db = await getDb();
  const res = await db.query<{ wedge_json: unknown }>(
    'SELECT wedge_json FROM opportunities WHERE id = $1',
    [opportunityId],
  );
  const row = res.rows[0];
  return row ? parseWedgeJson(row.wedge_json) : null;
}

async function loadCompetitors(opportunityId: string): Promise<
  Array<{ name: string; currentPricing: string | null; hasPermanentFreeTier: boolean | null; reviewCount: number | null }>
> {
  const db = await getDb();
  const res = await db.query<{
    name: string;
    current_pricing: string | null;
    has_permanent_free_tier: boolean | null;
    review_count: number | string | null;
  }>(
    `SELECT name, current_pricing, has_permanent_free_tier, review_count
       FROM competitors WHERE opportunity_id = $1
      ORDER BY review_count DESC NULLS LAST, name ASC`,
    [opportunityId],
  );
  return res.rows.map((r) => ({
    name: r.name,
    currentPricing: r.current_pricing,
    hasPermanentFreeTier: r.has_permanent_free_tier,
    reviewCount:
      r.review_count === null || r.review_count === undefined ? null : Number(r.review_count),
  }));
}

/** Why a category that cannot yield a narrow wedge is being killed. */
export function rejectionReasonFor(problems: readonly WedgeProblem[]): RejectionReason {
  const codes = new Set(problems.map((p) => p.code));
  if (codes.has('BUILD_TOO_LONG') || codes.has('TOO_MANY_V1_FEATURES')) return 'BUILD_TOO_LARGE';
  if (
    codes.has('GENERIC_STATEMENT') ||
    codes.has('NO_SPECIFIC_CUSTOMER') ||
    codes.has('CUSTOMER_NOT_NARROW') ||
    codes.has('VAGUE_WORKFLOW')
  ) {
    return 'GENERIC_AI_WRAPPER';
  }
  return 'MANUAL';
}

/**
 * Generates and persists one wedge.
 *
 * Idempotent: an opportunity already in WEDGE_GENERATED is returned as-is
 * rather than re-synthesized, and anything not in CATEGORY_VERIFIED is skipped
 * without a state change.
 */
export async function generateWedgeFor(opportunityId: string): Promise<WedgeResult> {
  const opp = await loadOpportunity(opportunityId);
  if (!opp) {
    return {
      opportunityId,
      wedge: null,
      clusterCount: 0,
      rejected: false,
      rejectionDetail: 'no such opportunity',
    };
  }

  if (opp.state === 'WEDGE_GENERATED') {
    return {
      opportunityId,
      wedge: parseWedgeJson(opp.wedge_json),
      clusterCount: 0,
      rejected: false,
      rejectionDetail: null,
    };
  }

  if (opp.state !== 'CATEGORY_VERIFIED') {
    return {
      opportunityId,
      wedge: null,
      clusterCount: 0,
      rejected: false,
      rejectionDetail: `skipped: state is ${opp.state}, not CATEGORY_VERIFIED`,
    };
  }

  const clusters = await clusterComplaints(opportunityId);
  const competitors = await loadCompetitors(opportunityId);

  const { wedge, attempts, problems } = await generateWedge({
    opportunity: {
      id: opp.id,
      name: opp.name,
      ecosystem: opp.ecosystem,
      category: opp.category,
      description: opp.description ?? '',
    },
    clusters,
    competitors,
  });

  if (!wedge) {
    const reason = rejectionReasonFor(problems);
    const detail = problems.map((p) => `[${p.code}] ${p.message}`).join(' ');
    await transitionOpportunity({
      opportunityId,
      to: 'CATEGORY_REJECTED',
      actor: WEDGE_ACTOR,
      reason: `no narrow wedge after ${attempts} attempts: ${reason}`,
      detail: { attempts, problems, clusterCount: clusters.length },
      set: { rejection_reason: reason },
    });
    logger.warn('opportunity killed: no narrow wedge', { opportunityId, reason, attempts });
    return {
      opportunityId,
      wedge: null,
      clusterCount: clusters.length,
      rejected: true,
      rejectionDetail: `${reason}: ${detail}`.slice(0, 1000),
    };
  }

  await transitionOpportunity({
    opportunityId,
    to: 'WEDGE_GENERATED',
    actor: WEDGE_ACTOR,
    reason: `wedge synthesized and validated in code (attempt ${attempts})`,
    detail: {
      attempts,
      clusterCount: clusters.length,
      v1Features: wedge.v1Features.length,
      statement: wedge.statement,
    },
    set: {
      proposed_wedge: wedge.statement,
      target_customer: wedge.targetCustomer,
      proposed_price_monthly: wedge.proposedPriceMonthly,
      estimated_build_days: wedge.estimatedBuildDays,
      wedge_json: wedge,
    },
  });

  return {
    opportunityId,
    wedge,
    clusterCount: clusters.length,
    rejected: false,
    rejectionDetail: null,
  };
}

/** Generates wedges for opportunities in CATEGORY_VERIFIED. */
export async function generateWedges(limit: number): Promise<WedgeResult[]> {
  if (limit <= 0) return [];
  const db = await getDb();
  const res = await db.query<{ id: string }>(
    `SELECT id FROM opportunities
      WHERE state = 'CATEGORY_VERIFIED'
      ORDER BY created_at ASC
      LIMIT $1`,
    [limit],
  );

  const out: WedgeResult[] = [];
  for (const row of res.rows) {
    try {
      out.push(await generateWedgeFor(row.id));
    } catch (err) {
      // Budget exhaustion halts the whole job; anything else is one bad
      // opportunity and must not stop the others.
      if (err instanceof BudgetExceededError) throw err;
      logger.error('wedge generation failed', { opportunityId: row.id, ...errorToFields(err) });
      out.push({
        opportunityId: row.id,
        wedge: null,
        clusterCount: 0,
        rejected: false,
        rejectionDetail: `error: ${String(err)}`.slice(0, 500),
      });
    }
  }
  return out;
}

export type { ComplaintCluster, ComplaintCode } from './clustering';
export { clusterComplaints, tagComplaintText, COMPLAINT_TAXONOMY } from './clustering';
export { validateWedge, generateWedge } from './generate';
export type { WedgeProblem, WedgeValidation } from './generate';
