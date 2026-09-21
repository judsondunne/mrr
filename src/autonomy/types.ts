/**
 * Shared types for the autonomy layer.
 *
 * The rule this layer exists to keep: the CONTROL PLANE (gate thresholds,
 * cost ceilings, suppression, compliance, security) is typed code and env with
 * no AI write path. The STRATEGY PLANE is database rows inside these
 * constrained schemas. Nothing here may widen a control-plane value.
 */
import { z } from 'zod';

// --- runtime ----------------------------------------------------------------

export const RUNTIME_STATES = [
  'BOOTING',
  'SELF_TESTING',
  'SHADOW_VERIFYING',
  'RUNNING',
  'DEGRADED',
  'PAUSED_BUDGET',
  'PAUSED_DELIVERABILITY',
  'BLOCKED_CONFIGURATION',
  'EMERGENCY_STOP',
] as const;
export type RuntimeState = (typeof RUNTIME_STATES)[number];

export function isRuntimeState(v: string): v is RuntimeState {
  return (RUNTIME_STATES as readonly string[]).includes(v);
}

export const SUBSYSTEMS = [
  'database',
  'search',
  'llm',
  'email_out',
  'email_in',
  'scheduler',
  'supervisor',
  'discovery',
  'research',
  'prospecting',
  'campaigns',
  'webhook',
] as const;
export type Subsystem = (typeof SUBSYSTEMS)[number];

export type HealthStatus = 'OK' | 'DEGRADED' | 'FAILING' | 'UNKNOWN';

export interface SubsystemHealth {
  subsystem: Subsystem;
  status: HealthStatus;
  lastOkAt: Date | null;
  lastAttemptAt: Date | null;
  lastError: string | null;
  consecutiveFailures: number;
}

// --- work queue --------------------------------------------------------------

/**
 * Priority order, lowest number first. This encodes the rule that a prospect
 * waiting on a reply always beats discovering idea #5,000.
 */
export const PRIORITY = {
  PROTECT_CONVERSATION: 1,
  EVALUATE_POTENTIAL_WINNER: 2,
  MAINTAIN_DELIVERABILITY: 3,
  COMPLETE_ACTIVE_EXPERIMENT: 4,
  PROSPECT_QUALIFIED_EXPERIMENT: 5,
  DEEP_RESEARCH: 6,
  DISCOVERY_EXPLORATION: 7,
} as const;
export type Priority = (typeof PRIORITY)[keyof typeof PRIORITY];

export const WORK_KINDS = [
  'PROCESS_INBOUND_REPLY',
  'SEND_DUE_MESSAGES',
  'SCHEDULE_FOLLOWUPS',
  'EVALUATE_CAMPAIGN',
  'REVALIDATE_FEASIBILITY',
  'NOTIFY_VALIDATED',
  'QUALIFY_PROSPECTS',
  'DISCOVER_PROSPECTS',
  'PREPARE_CAMPAIGN',
  'RESEARCH_STAGE',
  'DISCOVER_OPPORTUNITIES',
  'EXPAND_QUERIES',
  'EVALUATE_SOURCE',
  'PROPOSE_HYPOTHESIS',
  'POST_MORTEM',
  'REFRESH_EVIDENCE',
] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

export type WorkStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'DEAD_LETTER' | 'CANCELLED';

export interface WorkItem {
  id: string;
  kind: WorkKind;
  payload: Record<string, unknown>;
  priority: number;
  status: WorkStatus;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: Date;
  lastError: string | null;
  deadLetterReason: string | null;
  idempotencyKey: string | null;
  opportunityId: string | null;
}

export interface EnqueueRequest {
  kind: WorkKind;
  payload?: Record<string, unknown>;
  priority: number;
  /** Same logical work is never queued twice. Required. */
  idempotencyKey: string;
  opportunityId?: string | null;
  maxAttempts?: number;
  runAt?: Date;
}

// --- strategy plane ----------------------------------------------------------

export const STRATEGY_DIMENSIONS = [
  'RESEARCH_SOURCE',
  'CATEGORY_FAMILY',
  'ICP_SEGMENT',
  'POSITIONING',
  'PRICE_POINT',
  'MESSAGE_VARIANT',
  'CONTACT_ROLE',
  'SEND_TIME',
  'QUERY_FAMILY',
] as const;
export type StrategyDimension = (typeof STRATEGY_DIMENSIONS)[number];

/**
 * Fields an LLM proposal may never contain. The strategy guard rejects any
 * mutation mentioning one of these, so "adapt the strategy" can never become
 * "raise the budget" or "lower the gate".
 */
export const FORBIDDEN_STRATEGY_FIELDS: readonly string[] = [
  'minUniqueStrongCommitments',
  'minUniquePriceAcceptances',
  'minUniqueActionCommitments',
  'minDeliveredBeforeStandardEvaluation',
  'minPositiveIntentRate',
  'requiredCategoryEvidenceConfidence',
  'monthlyLlmBudgetUsd',
  'monthlySearchBudgetUsd',
  'maxEmailsPerDay',
  'maxEmailsPerCampaign',
  'maxFollowups',
  'allowedOutreachCountries',
  'maxHardBounceRate',
  'maxComplaintRate',
  'maxUnsubscribeRate',
  'suppression',
  'adminToken',
  'cronSecret',
  'unsubscribeSecret',
  'anthropicApiKey',
  'resendApiKey',
  'autonomyEnabled',
  'outreachEnabled',
  'killSwitch',
  'cooldownDays',
  'gate',
];

export const HypothesisProposal = z.object({
  dimension: z.enum(STRATEGY_DIMENSIONS),
  hypothesis: z.string().min(10).max(400),
  reason: z.string().min(10).max(600),
  expectedBenefit: z.string().min(5).max(300),
  experimentScope: z.string().min(5).max(300),
  /** Constrained free-form config for this dimension. Validated per-dimension. */
  proposal: z.record(z.string(), z.unknown()),
});
export type HypothesisProposal = z.infer<typeof HypothesisProposal>;

export type HypothesisStatus = 'PROPOSED' | 'REJECTED' | 'ADMITTED' | 'RETIRED';

export interface EligibilityVerdict {
  eligible: boolean;
  reasons: string[];
  similarTo?: string | null;
}

/** Beta-Bernoulli posterior for one arm. */
export interface BanditArm {
  dimension: StrategyDimension;
  armKey: string;
  alpha: number;
  beta: number;
  trials: number;
  successes: number;
  totalReward: number;
  enabled: boolean;
}

export interface Allocation {
  armKey: string;
  /** True when this pick came from the reserved exploration budget. */
  exploring: boolean;
  sampledValue: number;
  /** False until the arm has enough trials to be called a winner. */
  hasSufficientSample: boolean;
}

// --- outcomes ----------------------------------------------------------------

export interface OutcomeInput {
  opportunityId: string | null;
  campaignId: string | null;
  ecosystem: string | null;
  category: string | null;
  problemType: string | null;
  icp: string | null;
  source: string | null;
  queryFamily: string | null;
  competitorProfile: string | null;
  wedgeType: string | null;
  priceMonthly: number | null;
  valueProposition: string | null;
  emailVariant: string | null;
  landingVariant: string | null;
  contactRoleStrategy: string | null;
  sendTimeBucket: string | null;
  followupStrategy: string | null;
  strategyVersionIds: string[];
}

export interface OutcomeResults {
  qualifiedProspects: number;
  delivered: number;
  deliveryRate: number;
  bounceRate: number;
  replyRate: number;
  negativeRate: number;
  strongInterest: number;
  priceAcceptances: number;
  pilotSignups: number;
  installRequests: number;
  onboardingDetails: number;
  paymentEvents: number;
  timeToFirstInterestHours: number | null;
  timeToFirstCommitmentHours: number | null;
  finalResult: 'VALIDATED' | 'FAILED' | 'ABANDONED' | 'RUNNING';
  failureReason: string | null;
}

// --- sources -----------------------------------------------------------------

export type SourceStatus = 'UNVERIFIED' | 'VERIFIED' | 'REJECTED' | 'DISABLED';
export type SourceKind = 'MARKETPLACE' | 'SEARCH' | 'MERCHANT_SITE' | 'REVIEW_SITE' | 'COMMUNITY' | 'OTHER';

export interface SourceRecord {
  id: string;
  name: string;
  kind: SourceKind;
  baseUrl: string | null;
  ecosystem: string | null;
  status: SourceStatus;
  trustLevel: number;
  structured: boolean;
  enabled: boolean;
}

// --- company fatigue ----------------------------------------------------------

export type ContactState = 'AVAILABLE' | 'COOLDOWN' | 'ENGAGED' | 'NEVER_CONTACT';

export interface ContactEligibility {
  allowed: boolean;
  reason: string | null;
  state: ContactState;
  cooldownUntil: Date | null;
}

// --- validation levels ---------------------------------------------------------

/**
 * Two confidence labels. VALIDATED_COMMITMENT is the existing deterministic
 * gate. VALIDATED_REVENUE_INTENT is strictly stronger and never implied.
 */
export type ValidationLevel = 'VALIDATED_COMMITMENT' | 'VALIDATED_REVENUE_INTENT';

export type SpendPhase = 'DISCOVERY' | 'RESEARCH' | 'PROSPECTING' | 'REPLY' | 'FINAL_ANALYSIS';
