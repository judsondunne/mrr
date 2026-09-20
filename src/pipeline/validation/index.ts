/**
 * PUBLIC API — VALIDATION LAYER. Owned by the validation agent.
 *
 * Everything in this layer is DETERMINISTIC CODE. No model call may appear
 * anywhere under src/pipeline/validation/ — tests/unit/validation.test.ts greps
 * this directory's own source to prove it.
 */
export type { GateCheck, GateEvaluation, CampaignCounts, HealthVerdict } from './types.js';
export { CHECK_IDS, REQUIRED_CHECK_IDS, EMPTY_COUNTS } from './types.js';
export type { CheckId } from './types.js';

/** Reads the counts the gate uses. Pure SQL, unique-company based. */
export { getCampaignCounts } from './counts.js';

/** Evaluates the gate WITHOUT transitioning. Safe to call from the dashboard. */
export { evaluateGate } from './gate.js';

/**
 * Evaluates every active campaign and transitions opportunities to
 * VALIDATION_STRONG / READY_TO_BUILD / VALIDATION_FAILED. The ONLY caller
 * permitted to mint a GateToken.
 */
export { evaluateCampaigns, checkCampaignHealth, snapshotCampaignMetrics } from './evaluate.js';

// --- secondary surface used by the dashboard, notify and buildspec layers ----

export {
  getCommitmentCompaniesByType,
  getExtremeValidationCounts,
  getLatestCampaignId,
  getQualifiedProspectCount,
} from './counts.js';
export { getFeasibilityBlockers, recordFeasibilityBlocker } from './blockers.js';
export {
  getCompetitorEvidence,
  getCustomerDerivedRequirements,
  getStrongestEvidence,
  getWaitingCompanies,
  clipQuote,
  normalizeQuote,
} from './evidence.js';
export type {
  CompetitorEvidence,
  CompetitorPaymentEvidence,
  CustomerRequirement,
  ProspectEvidenceItem,
  WaitingCompany,
} from './evidence.js';
export { getLatestMetrics } from './evaluate.js';
export { collectDossier, loadCampaignFacts } from './dossier.js';
export type { CampaignFacts, ValidationDossier } from './dossier.js';
export { loadOpportunity, parseWedge, resolvePrice, resolveBuildDays } from './opportunity.js';
export type { OpportunityRow, WedgeFacts } from './opportunity.js';
