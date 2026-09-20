/**
 * PUBLIC API — VALIDATION LAYER. Owned by the validation agent.
 *
 * Everything in this layer is DETERMINISTIC CODE. No LLM call may appear
 * anywhere under src/pipeline/validation/.
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

/** Reads the counts the gate uses. Pure SQL, unique-company based. */
export declare function getCampaignCounts(campaignId: string): Promise<CampaignCounts>;

/** Evaluates the gate WITHOUT transitioning. Safe to call from the dashboard. */
export declare function evaluateGate(opportunityId: string): Promise<GateEvaluation>;

/**
 * Evaluates every active campaign and transitions opportunities to
 * VALIDATION_STRONG / READY_TO_BUILD / VALIDATION_FAILED. The ONLY caller
 * permitted to mint a GateToken.
 */
export declare function evaluateCampaigns(): Promise<GateEvaluation[]>;

/** Campaign-health check used between send batches. */
export interface HealthVerdict {
  healthy: boolean;
  reason: string | null;
  hardBounceRate: number;
  complaintRate: number;
  unsubscribeRate: number;
}
export declare function checkCampaignHealth(campaignId: string): Promise<HealthVerdict>;

/** Writes a campaign_metrics snapshot row. */
export declare function snapshotCampaignMetrics(campaignId: string): Promise<void>;
