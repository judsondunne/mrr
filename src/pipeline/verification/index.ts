/**
 * PUBLIC API — CATEGORY VERIFICATION LAYER. Owned by the discovery agent.
 */
import type { EvidenceConfidence, EvidenceItem, RejectionReason } from '../../lib/contracts.js';

export interface VerificationOutcome {
  opportunityId: string;
  verified: boolean;
  confidence: EvidenceConfidence;
  strongEvidence: EvidenceItem[];
  supportingEvidence: EvidenceItem[];
  competitorCount: number;
  paidCompetitorCount: number;
  estimatedBuildDays: number | null;
  rejectionReason: RejectionReason | null;
  rejectionDetail: string | null;
}

/** Verifies up to `limit` opportunities sitting in DISCOVERED. */
export declare function verifyCategories(limit: number): Promise<VerificationOutcome[]>;

/** Verifies exactly one opportunity. Moves it to VERIFIED or REJECTED. */
export declare function verifyOpportunity(opportunityId: string): Promise<VerificationOutcome>;
