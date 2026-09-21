/**
 * Everything the owner email and the build spec are allowed to say about an
 * opportunity, assembled from database rows in one place.
 *
 * If a fact is not in this dossier, no downstream renderer may state it. That
 * is how "never fabricate a quotation" is enforced structurally rather than by
 * asking nicely.
 */
import { getDb, toNumber } from '../../lib/db';
import { AppError } from '../../lib/errors';
import {
  getCampaignCounts,
  getCommitmentCompaniesByType,
  getLatestCampaignId,
  getQualifiedProspectCount,
  getUniqueCompanyCountForTypes,
} from './counts';
import {
  getCompetitorEvidence,
  getCustomerDerivedRequirements,
  getEvidenceRows,
  getStrongestEvidence,
  getWaitingCompanies,
  type CompetitorEvidence,
  type CustomerRequirement,
  type EvidenceRowRef,
  type ProspectEvidenceItem,
  type WaitingCompany,
} from './evidence';
import { evaluateGate } from './gate';
import { evaluateRevenueIntent } from './revenue-intent';
import {
  loadOpportunity,
  parseWedge,
  resolveBuildDays,
  resolvePrice,
  type OpportunityRow,
  type WedgeFacts,
} from './opportunity';
import {
  EMPTY_COUNTS,
  type CampaignCounts,
  type GateEvaluation,
  type RevenueIntentEvaluation,
} from './types';

export interface CampaignFacts {
  id: string;
  state: string;
  offerName: string;
  priceMonthly: number | null;
  landingSlug: string;
  startedAt: string | null;
}

export interface ValidationDossier {
  opportunity: OpportunityRow;
  wedge: WedgeFacts;
  campaign: CampaignFacts | null;
  price: number | null;
  buildDays: number | null;
  counts: CampaignCounts;
  /** Unique companies per commitment type. */
  companiesByType: Record<string, number>;
  /** Unique companies that asked to install or trial (never double-counted). */
  installOrTrialCompanies: number;
  /** Unique companies whose commitment was neither price nor install/trial. */
  otherCommitmentCompanies: number;
  evidence: ProspectEvidenceItem[];
  /** Every citable row: all commitments plus all inbound replies. */
  evidenceRows: EvidenceRowRef[];
  requirements: CustomerRequirement[];
  competitors: CompetitorEvidence[];
  waitingCompanies: WaitingCompany[];
  evaluation: GateEvaluation;
  /** Which of the two tiers the evidence reached. Strictly stronger than the gate. */
  revenueIntent: RevenueIntentEvaluation;
}

interface CampaignRow {
  id: string;
  state: string;
  offer_name: string;
  price_monthly: string | number | null;
  landing_slug: string;
  started_at: string | Date | null;
}

export async function loadCampaignFacts(campaignId: string): Promise<CampaignFacts | null> {
  const db = await getDb();
  const res = await db.query<CampaignRow>(
    `SELECT id, state, offer_name, price_monthly, landing_slug, started_at
       FROM campaigns WHERE id = $1`,
    [campaignId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    state: row.state,
    offerName: row.offer_name,
    priceMonthly: row.price_monthly === null ? null : toNumber(row.price_monthly, 0),
    landingSlug: row.landing_slug,
    startedAt: row.started_at
      ? row.started_at instanceof Date
        ? row.started_at.toISOString()
        : String(row.started_at)
      : null,
  };
}

export async function collectDossier(opportunityId: string): Promise<ValidationDossier> {
  const opportunity = await loadOpportunity(opportunityId);
  if (!opportunity) throw new AppError(`no opportunity ${opportunityId}`, 'OPPORTUNITY_NOT_FOUND');

  const wedge = parseWedge(opportunity.wedge_json);
  const campaignId = await getLatestCampaignId(opportunityId);
  const campaign = campaignId ? await loadCampaignFacts(campaignId) : null;

  const [
    counts,
    companiesByType,
    installOrTrialCompanies,
    otherCommitmentCompanies,
    evidence,
    requirements,
    competitors,
    waitingCompanies,
    evaluation,
    evidenceRows,
  ] = await Promise.all([
      campaignId
        ? getCampaignCounts(campaignId)
        : (async () => ({
            ...EMPTY_COUNTS,
            qualifiedProspects: await getQualifiedProspectCount(opportunityId),
          }))(),
      campaignId ? getCommitmentCompaniesByType(campaignId) : Promise.resolve({}),
      campaignId
        ? getUniqueCompanyCountForTypes(campaignId, ['INSTALL_REQUEST', 'TRIAL_REQUEST'])
        : Promise.resolve(0),
      campaignId
        ? getUniqueCompanyCountForTypes(campaignId, ['ONBOARDING_DETAILS', 'OTHER_STRONG_INTENT'])
        : Promise.resolve(0),
      campaignId ? getStrongestEvidence(campaignId) : Promise.resolve([]),
      campaignId ? getCustomerDerivedRequirements(campaignId) : Promise.resolve([]),
      getCompetitorEvidence(opportunityId),
      campaignId ? getWaitingCompanies(campaignId) : Promise.resolve([]),
      evaluateGate(opportunityId),
      campaignId ? getEvidenceRows(campaignId) : Promise.resolve([]),
    ]);

  const revenueIntent = await evaluateRevenueIntent(opportunityId, evaluation);

  return {
    opportunity,
    wedge,
    campaign,
    price: resolvePrice(opportunity, wedge, campaign?.priceMonthly ?? null),
    buildDays: resolveBuildDays(opportunity, wedge),
    counts,
    companiesByType,
    installOrTrialCompanies,
    otherCommitmentCompanies,
    evidence,
    evidenceRows,
    requirements,
    competitors,
    waitingCompanies,
    evaluation,
    revenueIntent,
  };
}
