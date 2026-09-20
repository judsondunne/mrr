/**
 * PUBLIC API — VALIDATION LAYER. Owned by the validation agent.
 *
 * Everything in this layer is DETERMINISTIC CODE. No model call may appear
 * anywhere under src/pipeline/validation/ — tests/unit/validation.test.ts greps
 * this directory's own source to prove it.
 */
export type { GateCheck, GateEvaluation, CampaignCounts, HealthVerdict } from './types';
export { CHECK_IDS, REQUIRED_CHECK_IDS, EMPTY_COUNTS } from './types';
export type { CheckId } from './types';

/** Reads the counts the gate uses. Pure SQL, unique-company based. */
export { getCampaignCounts } from './counts';

/** Evaluates the gate WITHOUT transitioning. Safe to call from the dashboard. */
export { evaluateGate } from './gate';

/**
 * Evaluates every active campaign and transitions opportunities to
 * VALIDATION_STRONG / READY_TO_BUILD / VALIDATION_FAILED. The ONLY caller
 * permitted to mint a GateToken.
 */
export { evaluateCampaigns, checkCampaignHealth, snapshotCampaignMetrics } from './evaluate';

// --- secondary surface used by the dashboard, notify and buildspec layers ----

export {
  getCommitmentCompaniesByType,
  getExtremeValidationCounts,
  getLatestCampaignId,
  getQualifiedProspectCount,
} from './counts';
export { getFeasibilityBlockers, recordFeasibilityBlocker } from './blockers';
export {
  getCompetitorEvidence,
  getCustomerDerivedRequirements,
  getStrongestEvidence,
  getWaitingCompanies,
  clipQuote,
  normalizeQuote,
} from './evidence';
export type {
  CompetitorEvidence,
  CompetitorPaymentEvidence,
  CustomerRequirement,
  ProspectEvidenceItem,
  WaitingCompany,
} from './evidence';
export { getLatestMetrics } from './evaluate';
export { collectDossier, loadCampaignFacts } from './dossier';
export type { CampaignFacts, ValidationDossier } from './dossier';
export { loadOpportunity, parseWedge, resolvePrice, resolveBuildDays } from './opportunity';
export type { OpportunityRow, WedgeFacts } from './opportunity';
