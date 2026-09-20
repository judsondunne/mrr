/**
 * Shared domain types and Zod schemas.
 *
 * This is the interface boundary between pipeline layers. Every layer imports
 * from here so layers compile independently of each other.
 */
import { z } from 'zod';

// --- evidence ---------------------------------------------------------------

export const EvidenceType = z.enum([
  'INCUMBENT_NO_FREE_TIER',
  'CUSTOMER_REFERENCES_PAID_PLAN',
  'CUSTOMER_EXCEEDS_FREE_TIER',
  'MULTIPLE_PAID_COMPETITORS',
  'DISCLOSED_REVENUE_OR_CUSTOMERS',
  'ACQUISITION_LISTING',
  'SUSTAINED_USAGE_DURATION',
  'PRICING_PAGE_EXISTS',
  'PRODUCT_HUNT_LAUNCH',
  'DOWNLOADS_NO_PAID_PROOF',
  'GENERIC_REVIEWS',
  'AI_MARKET_ESTIMATE',
]);
export type EvidenceType = z.infer<typeof EvidenceType>;

/** Evidence types that count as a STRONG direct payment signal. */
export const STRONG_EVIDENCE_TYPES: ReadonlySet<EvidenceType> = new Set<EvidenceType>([
  'INCUMBENT_NO_FREE_TIER',
  'CUSTOMER_REFERENCES_PAID_PLAN',
  'CUSTOMER_EXCEEDS_FREE_TIER',
  'MULTIPLE_PAID_COMPETITORS',
  'DISCLOSED_REVENUE_OR_CUSTOMERS',
]);

/** Corroborating signals of sustained demand. Never sufficient alone. */
export const SUPPORTING_EVIDENCE_TYPES: ReadonlySet<EvidenceType> = new Set<EvidenceType>([
  'ACQUISITION_LISTING',
  'SUSTAINED_USAGE_DURATION',
]);

export const EvidenceItem = z.object({
  type: EvidenceType,
  sourceUrl: z.string(),
  quote: z.string().max(500),
  date: z.string().nullable(),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  note: z.string().max(300).default(''),
});
export type EvidenceItem = z.infer<typeof EvidenceItem>;

export const EvidenceConfidence = z.enum(['HIGH', 'MEDIUM', 'LOW', 'NONE']);
export type EvidenceConfidence = z.infer<typeof EvidenceConfidence>;

// --- wedge ------------------------------------------------------------------

export const Wedge = z.object({
  /** "For [very specific customer], do [one recurring job], with [one reason]." */
  statement: z.string().min(20).max(400),
  productName: z.string().min(2).max(60),
  targetCustomer: z.string().min(10).max(300),
  coreWorkflow: z.string().min(10).max(600),
  v1Features: z.array(z.string().max(200)).min(3).max(5),
  excludedFromV1: z.array(z.string().max(200)).min(1).max(12),
  proposedPriceMonthly: z.number().positive().max(500),
  estimatedBuildDays: z.number().int().positive().max(30),
  primaryCompetitor: z.string().max(200),
  reasonSomeoneWouldSwitch: z.string().max(600),
  oneSentenceOutcome: z.string().max(240),
  capabilities: z.array(z.string().max(160)).min(3).max(5),
  whoItIsFor: z.string().max(300),
});
export type Wedge = z.infer<typeof Wedge>;

// --- prospects --------------------------------------------------------------

export const ProspectStatus = z.enum([
  'DISCOVERED',
  'QUALIFYING',
  'QUALIFIED',
  'DISQUALIFIED',
  'CONTACTED',
  'REPLIED',
  'COMMITTED',
  'SUPPRESSED',
  'BOUNCED',
]);
export type ProspectStatus = z.infer<typeof ProspectStatus>;

export interface ProspectRecord {
  id: string;
  opportunity_id: string;
  company_name: string;
  domain: string;
  ecosystem: string;
  public_evidence_url: string | null;
  qualification_reason: string | null;
  qualification_score: number | null;
  contact_name_if_public: string | null;
  contact_email: string | null;
  contact_source_url: string | null;
  email_is_public: boolean;
  country: string | null;
  status: string;
  suppressed_at: string | null;
}

// --- replies ----------------------------------------------------------------

export const ReplyClassification = z.enum([
  'NOT_INTERESTED',
  'UNSUBSCRIBE',
  'INTERESTED_WEAK',
  'INTERESTED_STRONG',
  'PRICE_ACCEPTED',
  'WANTS_PILOT',
  'ASKING_QUESTION',
  'FEATURE_REQUIREMENT',
  'USING_COMPETITOR',
  'WRONG_PERSON',
  'OUT_OF_OFFICE',
  'OTHER',
]);
export type ReplyClassification = z.infer<typeof ReplyClassification>;

export const ReplyAnalysis = z.object({
  classification: ReplyClassification,
  intent: z.string().max(400),
  requestedFeature: z.string().max(300).nullable(),
  competitorMentioned: z.string().max(120).nullable(),
  priceReaction: z.enum(['ACCEPTED', 'TOO_HIGH', 'TOO_LOW', 'QUESTIONED', 'NOT_MENTIONED']),
  timing: z.string().max(160).nullable(),
  explicitlyWantsAccess: z.boolean(),
  explicitlyAcceptedPrice: z.boolean(),
  requiresHuman: z.boolean(),
  /** 0..1. Advisory ONLY — never an input to the READY_TO_BUILD gate. */
  intentScore: z.number().min(0).max(1),
});
export type ReplyAnalysis = z.infer<typeof ReplyAnalysis>;

// --- commitments ------------------------------------------------------------

export const CommitmentType = z.enum([
  'EXPLICIT_PRICE_ACCEPTANCE',
  'PILOT_SIGNUP',
  'INSTALL_REQUEST',
  'TRIAL_REQUEST',
  'ONBOARDING_DETAILS',
  'PAYMENT_METHOD_ADDED',
  'DEPOSIT',
  'OTHER_STRONG_INTENT',
]);
export type CommitmentType = z.infer<typeof CommitmentType>;

/**
 * Every commitment type is, by definition, STRONG evidence. Weak signals
 * (opens, page views, "sounds interesting", likes) never become commitments —
 * there is deliberately no enum member for them.
 */
export const ALL_COMMITMENT_TYPES: readonly CommitmentType[] = CommitmentType.options;

/** Commitments that prove the prospect ACTED, not merely agreed. */
export const ACTION_COMMITMENT_TYPES: ReadonlySet<CommitmentType> = new Set<CommitmentType>([
  'INSTALL_REQUEST',
  'TRIAL_REQUEST',
  'ONBOARDING_DETAILS',
  'PAYMENT_METHOD_ADDED',
  'DEPOSIT',
]);

/** Commitments that constitute explicit acceptance of the stated price. */
export const PRICE_ACCEPTANCE_TYPES: ReadonlySet<CommitmentType> = new Set<CommitmentType>([
  'EXPLICIT_PRICE_ACCEPTANCE',
  'PILOT_SIGNUP',
  'PAYMENT_METHOD_ADDED',
  'DEPOSIT',
]);

/** Monetary commitments, used only by EXTREME_VALIDATION mode. */
export const MONETARY_COMMITMENT_TYPES: ReadonlySet<CommitmentType> = new Set<CommitmentType>([
  'PAYMENT_METHOD_ADDED',
  'DEPOSIT',
]);

export const CommitmentSource = z.enum(['EMAIL_REPLY', 'LANDING_FORM', 'STRIPE', 'MANUAL']);
export type CommitmentSource = z.infer<typeof CommitmentSource>;

export interface CommitmentInput {
  campaignId: string;
  prospectId: string | null;
  companyKey: string;
  type: CommitmentType;
  priceMonthly: number | null;
  source: CommitmentSource;
  evidenceText: string;
  evidenceUrl?: string | null;
  messageId?: string | null;
  verified?: boolean;
}

// --- rejection --------------------------------------------------------------

export const RejectionReason = z.enum([
  'NO_PAYMENT_EVIDENCE',
  'ONLY_WEAK_EVIDENCE',
  'DISALLOWED_DOMAIN',
  'BUILD_TOO_LARGE',
  'DOMINATED_BY_FREE_NATIVE_FEATURE',
  'GENERIC_AI_WRAPPER',
  'NETWORK_EFFECTS_REQUIRED',
  'TWO_SIDED_MARKETPLACE',
  'ENTERPRISE_SALES_REQUIRED',
  'HIGH_LIABILITY',
  'INSUFFICIENT_PROSPECTS',
  'PROSPECTS_NOT_REACHABLE',
  'NO_MEANINGFUL_RESPONSE',
  'NEGATIVE_SENTIMENT_DOMINANT',
  'PRICE_REJECTION_DOMINANT',
  'ICP_DISCOVERY_FAILED',
  'CAMPAIGN_HEALTH_FAILURE',
  'DUPLICATE',
  'MANUAL',
]);
export type RejectionReason = z.infer<typeof RejectionReason>;

// --- notifications ----------------------------------------------------------

export const NotificationKind = z.enum([
  'READY_TO_BUILD',
  'CREDENTIAL_FAILURE',
  'DOMAIN_FAILURE',
  'COST_LIMIT',
  'SECURITY_FAILURE',
  'JOB_FAILURE',
]);
export type NotificationKind = z.infer<typeof NotificationKind>;

// --- adapter interfaces (extension points) ----------------------------------

export interface DiscoveredCandidate {
  name: string;
  ecosystem: string;
  category: string;
  description: string;
  sourceUrl: string;
  /** Marketplace listing URLs for competitors found in this category. */
  competitorUrls: string[];
  metadata?: Record<string, unknown>;
}

/** Implement one per ecosystem. ShopifyAdapter is the only MVP implementation. */
export interface OpportunitySource {
  readonly ecosystem: string;
  discover(limit: number): Promise<DiscoveredCandidate[]>;
}

export interface ExtractedCompetitor {
  name: string;
  url: string;
  currentPricing: string | null;
  freePlanDetails: string | null;
  hasPermanentFreeTier: boolean | null;
  reviewCount: number | null;
  rating: number | null;
  launchAge: string | null;
  evidence: EvidenceItem[];
  reviews: ExtractedReview[];
}

export interface ExtractedReview {
  sourceUrl: string;
  rating: number | null;
  reviewDate: string | null;
  merchantName: string | null;
  merchantDomainIfPublic: string | null;
  usageDuration: string | null;
  text: string;
  paymentSignal: 'PAID_PLAN_REFERENCED' | 'EXCEEDS_FREE_TIER' | 'NONE';
  complaintTags: string[];
}

/**
 * Optional context passed to an extractor so the source documents it fetches
 * can be linked to the opportunity that triggered the fetch.
 */
export interface ExtractContext {
  opportunityId?: string | null;
}

/** Implement one per marketplace. */
export interface EvidenceExtractor {
  readonly ecosystem: string;
  extractCompetitor(url: string, ctx?: ExtractContext): Promise<ExtractedCompetitor | null>;
}

export interface ProspectCandidate {
  companyName: string;
  domain: string;
  publicEvidenceUrl: string;
  qualificationReason: string;
  contactEmail: string | null;
  contactSourceUrl: string | null;
  contactNameIfPublic: string | null;
  country: string | null;
  evidence?: Record<string, unknown>;
}

/** Implement one per ecosystem. */
export interface ProspectFinder {
  readonly ecosystem: string;
  find(params: {
    opportunityId: string;
    wedge: Wedge;
    limit: number;
  }): Promise<ProspectCandidate[]>;
}

export interface MarketplaceAdapter {
  readonly ecosystem: string;
  readonly source: OpportunitySource;
  readonly extractor: EvidenceExtractor;
  readonly prospectFinder: ProspectFinder;
}
