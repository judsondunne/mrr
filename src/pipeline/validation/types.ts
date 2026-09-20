/**
 * Shared types for the validation layer.
 *
 * These shapes are the public contract re-exported by ./index.ts. Nothing in
 * this layer is probabilistic: every field below is produced by SQL counting
 * rows, or by comparing one of those counts to a configured threshold.
 */

export interface GateCheck {
  id: string;
  label: string;
  passed: boolean;
  /** Human-readable "have X, need Y". Shown verbatim in the dashboard. */
  detail: string;
  actual: number | string;
  required: number | string;
}

export interface GateEvaluation {
  opportunityId: string;
  campaignId: string | null;
  passed: boolean;
  checks: GateCheck[];
  /** Populated when passed === false. The "WHY THIS IS NOT READY" list. */
  unmetChecks: GateCheck[];
  evaluatedAt: string;
}

export interface CampaignCounts {
  qualifiedProspects: number;
  delivered: number;
  replied: number;
  positiveReplies: number;
  negativeReplies: number;
  hardBounced: number;
  complained: number;
  unsubscribed: number;
  uniqueStrongCommitmentCompanies: number;
  uniquePriceAcceptanceCompanies: number;
  uniqueActionCommitmentCompanies: number;
  uniqueMonetaryCommitmentCompanies: number;
  positiveIntentRate: number;
}

/**
 * Re-exported so the validation layer and the outreach layer can never
 * disagree about what an unhealthy campaign is. See lib/campaign-health.
 */
export type { HealthVerdict } from '../../lib/campaign-health';

/**
 * Stable check identifiers. The dashboard and the audit trail key off these,
 * so they must not be renamed once written to audit_events.
 */
export const CHECK_IDS = {
  categoryPaymentEvidence: 'CATEGORY_PAYMENT_EVIDENCE',
  qualifiedProspects: 'QUALIFIED_PROSPECTS',
  outreachVolume: 'OUTREACH_VOLUME',
  uniqueStrongCommitments: 'UNIQUE_STRONG_COMMITMENTS',
  uniquePriceAcceptances: 'UNIQUE_PRICE_ACCEPTANCES',
  uniqueActionCommitments: 'UNIQUE_ACTION_COMMITMENTS',
  positiveIntentRate: 'POSITIVE_INTENT_RATE',
  noFeasibilityBlocker: 'NO_FEASIBILITY_BLOCKER',
  mvpBuildDays: 'MVP_BUILD_DAYS',
  explainableV1Requirements: 'EXPLAINABLE_V1_REQUIREMENTS',
  extremeValidationMonetary: 'EXTREME_VALIDATION_MONETARY',
} as const;

export type CheckId = (typeof CHECK_IDS)[keyof typeof CHECK_IDS];

/** The ten checks every opportunity must pass, in dashboard display order. */
export const REQUIRED_CHECK_IDS: readonly CheckId[] = [
  CHECK_IDS.categoryPaymentEvidence,
  CHECK_IDS.qualifiedProspects,
  CHECK_IDS.outreachVolume,
  CHECK_IDS.uniqueStrongCommitments,
  CHECK_IDS.uniquePriceAcceptances,
  CHECK_IDS.uniqueActionCommitments,
  CHECK_IDS.positiveIntentRate,
  CHECK_IDS.noFeasibilityBlocker,
  CHECK_IDS.mvpBuildDays,
  CHECK_IDS.explainableV1Requirements,
];

export const EMPTY_COUNTS: CampaignCounts = {
  qualifiedProspects: 0,
  delivered: 0,
  replied: 0,
  positiveReplies: 0,
  negativeReplies: 0,
  hardBounced: 0,
  complained: 0,
  unsubscribed: 0,
  uniqueStrongCommitmentCompanies: 0,
  uniquePriceAcceptanceCompanies: 0,
  uniqueActionCommitmentCompanies: 0,
  uniqueMonetaryCommitmentCompanies: 0,
  positiveIntentRate: 0,
};
