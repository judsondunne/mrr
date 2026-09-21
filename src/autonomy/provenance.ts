/**
 * PUBLIC API — EVIDENCE PROVENANCE + STALENESS. Owned by the evidence agent.
 *
 * Every material factual claim that reaches an owner notification or a build
 * spec must be traceable to a stored source. Inferred facts stay marked as
 * inferred; they never silently become confirmed facts.
 */
export type ClaimType =
  | 'COMPETITOR_PRICING'
  | 'MERCHANT_BEHAVIOUR'
  | 'CUSTOMER_COMPLAINT'
  | 'PLATFORM_CAPABILITY'
  | 'PROSPECT_IDENTITY'
  | 'COMMITMENT';

export interface EvidenceClaim {
  id: string;
  opportunityId: string | null;
  claimType: ClaimType;
  claimText: string;
  sourceUrl: string | null;
  fetchedAt: Date | null;
  contentHash: string | null;
  evidenceExcerpt: string | null;
  extractionModel: string | null;
  promptVersion: number | null;
  confidence: number | null;
  expiresAt: Date | null;
  inferred: boolean;
}

export declare function recordClaim(params: {
  opportunityId: string | null;
  claimType: ClaimType;
  claimText: string;
  sourceUrl?: string | null;
  sourceDocumentId?: string | null;
  evidenceExcerpt?: string | null;
  extractionModel?: string | null;
  promptVersion?: number | null;
  confidence?: number | null;
  inferred?: boolean;
}): Promise<EvidenceClaim>;

export declare function claimsFor(
  opportunityId: string,
  claimType?: ClaimType,
): Promise<EvidenceClaim[]>;

/** Claims past their TTL. Must be refreshed before a build recommendation. */
export declare function staleClaims(opportunityId: string): Promise<EvidenceClaim[]>;

export declare function refreshStaleEvidence(opportunityId: string): Promise<{
  refreshed: number;
  stillStale: number;
}>;

/**
 * Gate helper: true only when every claim required for a build recommendation
 * is present, traceable and unexpired.
 */
export declare function evidenceIsCurrent(opportunityId: string): Promise<{
  current: boolean;
  missing: ClaimType[];
  stale: ClaimType[];
}>;
