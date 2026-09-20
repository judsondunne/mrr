/**
 * Reads an opportunity and its stored wedge out of Postgres.
 *
 * Defensive by design: `wedge_json` was written by an upstream layer, so every
 * field is validated here with plain type guards. A malformed wedge degrades to
 * "missing", which makes gate check EXPLAINABLE_V1_REQUIREMENTS fail loudly
 * instead of letting a half-specified product through.
 */
import { getDb, toNumber } from '../../lib/db';

export interface OpportunityRow {
  id: string;
  name: string;
  ecosystem: string;
  category: string;
  description: string;
  source_url: string | null;
  state: string;
  proposed_wedge: string | null;
  target_customer: string | null;
  proposed_price_monthly: string | number | null;
  estimated_build_days: number | null;
  evidence_confidence: string | null;
  rejection_reason: string | null;
  wedge_json: unknown;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface WedgeFacts {
  productName: string | null;
  statement: string | null;
  targetCustomer: string | null;
  coreWorkflow: string | null;
  v1Features: string[];
  excludedFromV1: string[];
  capabilities: string[];
  proposedPriceMonthly: number | null;
  estimatedBuildDays: number | null;
  primaryCompetitor: string | null;
  oneSentenceOutcome: string | null;
  whoItIsFor: string | null;
  reasonSomeoneWouldSwitch: string | null;
  /** Blockers recorded on the wedge itself by the layer that generated it. */
  feasibilityBlockers: string[];
}

export const EMPTY_WEDGE_FACTS: WedgeFacts = {
  productName: null,
  statement: null,
  targetCustomer: null,
  coreWorkflow: null,
  v1Features: [],
  excludedFromV1: [],
  capabilities: [],
  proposedPriceMonthly: null,
  estimatedBuildDays: null,
  primaryCompetitor: null,
  oneSentenceOutcome: null,
  whoItIsFor: null,
  reasonSomeoneWouldSwitch: null,
  feasibilityBlockers: [],
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value) as unknown);
    } catch {
      return null;
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function readString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

function readStringArray(obj: Record<string, unknown>, key: string): string[] {
  const v = obj[key];
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map((x) => x.trim());
}

function readNumber(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export function parseWedge(wedgeJson: unknown): WedgeFacts {
  const obj = asRecord(wedgeJson);
  if (!obj) return { ...EMPTY_WEDGE_FACTS };
  return {
    productName: readString(obj, 'productName'),
    statement: readString(obj, 'statement'),
    targetCustomer: readString(obj, 'targetCustomer'),
    coreWorkflow: readString(obj, 'coreWorkflow'),
    v1Features: readStringArray(obj, 'v1Features'),
    excludedFromV1: readStringArray(obj, 'excludedFromV1'),
    capabilities: readStringArray(obj, 'capabilities'),
    proposedPriceMonthly: readNumber(obj, 'proposedPriceMonthly'),
    estimatedBuildDays: readNumber(obj, 'estimatedBuildDays'),
    primaryCompetitor: readString(obj, 'primaryCompetitor'),
    oneSentenceOutcome: readString(obj, 'oneSentenceOutcome'),
    whoItIsFor: readString(obj, 'whoItIsFor'),
    reasonSomeoneWouldSwitch: readString(obj, 'reasonSomeoneWouldSwitch'),
    feasibilityBlockers: readStringArray(obj, 'feasibilityBlockers'),
  };
}

export async function loadOpportunity(opportunityId: string): Promise<OpportunityRow | null> {
  const db = await getDb();
  const res = await db.query<OpportunityRow>(
    `SELECT id, name, ecosystem, category, description, source_url, state,
            proposed_wedge, target_customer, proposed_price_monthly, estimated_build_days,
            evidence_confidence, rejection_reason, wedge_json, created_at, updated_at
       FROM opportunities WHERE id = $1`,
    [opportunityId],
  );
  return res.rows[0] ?? null;
}

/** Monthly price actually shown to prospects: the campaign's, else the wedge's. */
export function resolvePrice(
  opportunity: OpportunityRow | null,
  wedge: WedgeFacts,
  campaignPrice: number | null,
): number | null {
  if (campaignPrice !== null && campaignPrice > 0) return campaignPrice;
  const stored = opportunity?.proposed_price_monthly ?? null;
  if (stored !== null && toNumber(stored, 0) > 0) return toNumber(stored, 0);
  if (wedge.proposedPriceMonthly !== null && wedge.proposedPriceMonthly > 0) {
    return wedge.proposedPriceMonthly;
  }
  return null;
}

/** Build-day estimate: the column the verification layer wrote, else the wedge's. */
export function resolveBuildDays(opportunity: OpportunityRow | null, wedge: WedgeFacts): number | null {
  if (opportunity?.estimated_build_days !== null && opportunity?.estimated_build_days !== undefined) {
    return opportunity.estimated_build_days;
  }
  return wedge.estimatedBuildDays;
}
