/**
 * PUBLIC API — PROSPECTING LAYER. Owned by the wedge/prospecting agent.
 */
export interface ProspectingResult {
  opportunityId: string;
  discovered: number;
  qualified: number;
  rejected: boolean;
  rejectionDetail: string | null;
}

/** Finds candidate businesses for opportunities in WEDGE_GENERATED/PROSPECTING. */
export declare function discoverProspects(limit: number): Promise<ProspectingResult[]>;

/**
 * Verifies candidates against their real site (not search snippets) and finds
 * a PUBLIC business email. Moves the opportunity to CAMPAIGN_READY once the
 * configured minimum is reached, or PROSPECTABILITY_REJECTED if unreachable.
 */
export declare function qualifyProspects(limit: number): Promise<ProspectingResult[]>;
