/**
 * THE GATE.
 *
 * RESEARCH IS NOT VALIDATION. A competitor having customers proves CATEGORY
 * DEMAND; it proves nothing about our wedge. So the only thing in this codebase
 * that can move an opportunity toward READY_TO_BUILD is the deterministic
 * evaluation below, and the only proof it produces is a GateToken.
 *
 * This is the ONE file permitted to import __mintGateToken. If a second import
 * of it ever appears anywhere in src/, that is a bug and a security incident.
 *
 * evaluateGate() has NO side effects: it never transitions, never writes, never
 * sends. The dashboard calls it on every page load.
 */
import { getConfig } from '../../lib/config';
import { AppError } from '../../lib/errors';
import { __mintGateToken, type GateToken } from '../../lib/state-machine';
import {
  getCampaignCounts,
  getExtremeValidationCounts,
  getLatestCampaignId,
  getQualifiedProspectCount,
} from './counts';
import { getFeasibilityBlockers } from './blockers';
import { getCustomerDerivedRequirements } from './evidence';
import {
  loadOpportunity,
  parseWedge,
  resolveBuildDays,
  type OpportunityRow,
  type WedgeFacts,
} from './opportunity';
import {
  CHECK_IDS,
  EMPTY_COUNTS,
  type CampaignCounts,
  type GateCheck,
  type GateEvaluation,
} from './types';

const CONFIDENCE_RANK: Record<string, number> = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };

function rankConfidence(value: string | null | undefined): number {
  if (!value) return 0;
  return CONFIDENCE_RANK[value.toUpperCase()] ?? 0;
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return n === 1 ? singular : pluralForm;
}

function check(
  id: string,
  label: string,
  passed: boolean,
  detail: string,
  actual: number | string,
  required: number | string,
): GateCheck {
  return { id, label, passed, detail, actual, required };
}

export interface GateInputs {
  opportunity: OpportunityRow;
  wedge: WedgeFacts;
  campaignId: string | null;
  counts: CampaignCounts;
  blockerDetails: string[];
  customerRequirementCount: number;
  extreme: { pricedPilotReservations: number; paymentMethods: number; deposits: number };
}

/**
 * Reads every input the gate needs. Separated from the pure decision below so
 * the decision function can be exercised without a database.
 */
export async function collectGateInputs(opportunityId: string): Promise<GateInputs> {
  const opportunity = await loadOpportunity(opportunityId);
  if (!opportunity) {
    throw new AppError(`no opportunity ${opportunityId}`, 'OPPORTUNITY_NOT_FOUND');
  }

  const campaignId = await getLatestCampaignId(opportunityId);
  const counts = campaignId
    ? await getCampaignCounts(campaignId)
    : { ...EMPTY_COUNTS, qualifiedProspects: await getQualifiedProspectCount(opportunityId) };

  const [blockers, requirements, extreme] = await Promise.all([
    getFeasibilityBlockers(opportunityId),
    campaignId ? getCustomerDerivedRequirements(campaignId) : Promise.resolve([]),
    campaignId
      ? getExtremeValidationCounts(campaignId)
      : Promise.resolve({ pricedPilotReservations: 0, paymentMethods: 0, deposits: 0 }),
  ]);

  return {
    opportunity,
    wedge: parseWedge(opportunity.wedge_json),
    campaignId,
    counts,
    blockerDetails: blockers.map((b) => b.detail),
    customerRequirementCount: requirements.length,
    extreme,
  };
}

/**
 * The decision. Pure function of numbers and configured thresholds — same
 * inputs, same answer, every time, with no I/O and no model in the path.
 */
export function decideGate(inputs: GateInputs): GateEvaluation {
  const cfg = getConfig();
  const g = cfg.gate;
  const { counts, wedge, opportunity } = inputs;
  const checks: GateCheck[] = [];

  // 1. The category already takes money from customers, at HIGH confidence.
  const requiredRank = rankConfidence(g.requiredCategoryEvidenceConfidence);
  const actualConfidence = (opportunity.evidence_confidence ?? 'NONE').toUpperCase();
  const evidenceOk = rankConfidence(actualConfidence) >= requiredRank;
  checks.push(
    check(
      CHECK_IDS.categoryPaymentEvidence,
      'Category payment evidence',
      evidenceOk,
      evidenceOk
        ? `category payment evidence is ${actualConfidence}, need ${g.requiredCategoryEvidenceConfidence}`
        : actualConfidence === 'NONE'
          ? `no category payment evidence recorded, need ${g.requiredCategoryEvidenceConfidence}`
          : `category payment evidence is ${actualConfidence}, need ${g.requiredCategoryEvidenceConfidence}`,
      actualConfidence,
      g.requiredCategoryEvidenceConfidence,
    ),
  );

  // 2. Enough real, qualified businesses were identified to be worth asking.
  const prospectsOk = counts.qualifiedProspects >= g.minQualifiedProspects;
  checks.push(
    check(
      CHECK_IDS.qualifiedProspects,
      'Qualified prospects identified',
      prospectsOk,
      `${counts.qualifiedProspects} qualified ${plural(counts.qualifiedProspects, 'prospect')} identified, need ${g.minQualifiedProspects}`,
      counts.qualifiedProspects,
      g.minQualifiedProspects,
    ),
  );

  // 3. Enough outreach delivered — OR inbound demand already settled the question.
  //    "Exceeded" is strict on purpose: the volume requirement is only waived
  //    when demand is beyond every threshold, not merely level with it.
  const commitmentsAlreadyConclusive =
    counts.uniqueStrongCommitmentCompanies > g.minUniqueStrongCommitments &&
    counts.uniquePriceAcceptanceCompanies > g.minUniquePriceAcceptances &&
    counts.uniqueActionCommitmentCompanies > g.minUniqueActionCommitments;
  const volumeMet = counts.delivered >= g.minDeliveredBeforeStandardEvaluation;
  const volumeOk = volumeMet || commitmentsAlreadyConclusive;
  checks.push(
    check(
      CHECK_IDS.outreachVolume,
      'Outreach volume (or early inbound demand)',
      volumeOk,
      volumeMet
        ? `${counts.delivered} outreach ${plural(counts.delivered, 'email')} delivered, need ${g.minDeliveredBeforeStandardEvaluation}`
        : commitmentsAlreadyConclusive
          ? `only ${counts.delivered} outreach ${plural(counts.delivered, 'email')} delivered (need ${g.minDeliveredBeforeStandardEvaluation}), but inbound demand already exceeded every commitment threshold: ${counts.uniqueStrongCommitmentCompanies} strong, ${counts.uniquePriceAcceptanceCompanies} price-accepted, ${counts.uniqueActionCommitmentCompanies} acted — all unique companies`
          : `${counts.delivered} outreach ${plural(counts.delivered, 'email')} delivered, need ${g.minDeliveredBeforeStandardEvaluation}`,
      counts.delivered,
      g.minDeliveredBeforeStandardEvaluation,
    ),
  );

  // 4. Unique COMPANIES with a strong purchase-intent event. Not messages.
  const strongOk = counts.uniqueStrongCommitmentCompanies >= g.minUniqueStrongCommitments;
  checks.push(
    check(
      CHECK_IDS.uniqueStrongCommitments,
      'Unique companies with strong purchase intent',
      strongOk,
      `${counts.uniqueStrongCommitmentCompanies} unique ${plural(counts.uniqueStrongCommitmentCompanies, 'company', 'companies')} generated strong purchase-intent events, need ${g.minUniqueStrongCommitments}`,
      counts.uniqueStrongCommitmentCompanies,
      g.minUniqueStrongCommitments,
    ),
  );

  // 5. Unique companies that accepted the displayed price or joined the pilot at it.
  const priceOk = counts.uniquePriceAcceptanceCompanies >= g.minUniquePriceAcceptances;
  checks.push(
    check(
      CHECK_IDS.uniquePriceAcceptances,
      'Unique companies that accepted the price',
      priceOk,
      `${counts.uniquePriceAcceptanceCompanies} unique ${plural(counts.uniquePriceAcceptanceCompanies, 'company', 'companies')} accepted the price, need ${g.minUniquePriceAcceptances}`,
      counts.uniquePriceAcceptanceCompanies,
      g.minUniquePriceAcceptances,
    ),
  );

  // 6. Unique companies that ACTED — install, trial, onboarding data, payment.
  const actionOk = counts.uniqueActionCommitmentCompanies >= g.minUniqueActionCommitments;
  checks.push(
    check(
      CHECK_IDS.uniqueActionCommitments,
      'Unique companies that acted beyond conversation',
      actionOk,
      `${counts.uniqueActionCommitmentCompanies} unique ${plural(counts.uniqueActionCommitmentCompanies, 'company', 'companies')} supplied onboarding info, requested install/trial, or otherwise acted beyond conversation, need ${g.minUniqueActionCommitments}`,
      counts.uniqueActionCommitmentCompanies,
      g.minUniqueActionCommitments,
    ),
  );

  // 7. Positive-intent rate among DELIVERED outreach.
  const rateOk = counts.delivered > 0 && counts.positiveIntentRate >= g.minPositiveIntentRate;
  checks.push(
    check(
      CHECK_IDS.positiveIntentRate,
      'Positive-intent rate among delivered outreach',
      rateOk,
      counts.delivered === 0
        ? `no outreach delivered yet, so the positive-intent rate cannot be computed, need ${pct(g.minPositiveIntentRate)}`
        : `positive-intent rate ${pct(counts.positiveIntentRate)} (${counts.uniqueStrongCommitmentCompanies} committed unique ${plural(counts.uniqueStrongCommitmentCompanies, 'company', 'companies')} / ${counts.delivered} delivered), need ${pct(g.minPositiveIntentRate)}`,
      Number(counts.positiveIntentRate.toFixed(4)),
      g.minPositiveIntentRate,
    ),
  );

  // 8. No recorded technical or platform feasibility blocker.
  const blockerOk = inputs.blockerDetails.length === 0;
  checks.push(
    check(
      CHECK_IDS.noFeasibilityBlocker,
      'No technical or platform feasibility blocker',
      blockerOk,
      blockerOk
        ? 'no technical or platform feasibility blocker recorded, need none'
        : `${inputs.blockerDetails.length} feasibility ${plural(inputs.blockerDetails.length, 'blocker')} recorded, need none: ${inputs.blockerDetails.join('; ')}`,
      inputs.blockerDetails.length,
      0,
    ),
  );

  // 9. The MVP is small enough to actually ship.
  const buildDays = resolveBuildDays(opportunity, wedge);
  const buildOk = buildDays !== null && buildDays <= g.maxMvpBuildDays;
  checks.push(
    check(
      CHECK_IDS.mvpBuildDays,
      'Estimated MVP build size',
      buildOk,
      buildDays === null
        ? `no MVP build estimate recorded, need ${g.maxMvpBuildDays} days or fewer`
        : `estimated MVP build is ${buildDays} ${plural(buildDays, 'day')}, need ${g.maxMvpBuildDays} days or fewer`,
      buildDays ?? 'unknown',
      g.maxMvpBuildDays,
    ),
  );

  // 10. We can state the exact V1 scope, and at least one requirement came from
  //     a real customer rather than from us.
  const featureCount = wedge.v1Features.length;
  const hasFeatures = featureCount >= 3;
  const requirementCount = inputs.customerRequirementCount;
  const explainOk = hasFeatures && requirementCount >= 1;
  checks.push(
    check(
      CHECK_IDS.explainableV1Requirements,
      'V1 requirements are explainable from prospect evidence',
      explainOk,
      explainOk
        ? `V1 scope is explainable: ${featureCount} wedge ${plural(featureCount, 'feature')} plus ${requirementCount} customer-derived ${plural(requirementCount, 'requirement')} from real replies, need at least 3 features and 1 customer-derived requirement`
        : !hasFeatures
          ? `only ${featureCount} V1 ${plural(featureCount, 'feature')} recorded on the wedge, need at least 3 plus 1 customer-derived requirement`
          : `no customer-derived requirement has been extracted from a real reply yet (${featureCount} wedge features recorded), need at least 1`,
      `${featureCount} features / ${requirementCount} customer requirements`,
      '>=3 features / >=1 customer requirement',
    ),
  );

  // EXTREME_VALIDATION: never auto-enabled, and it only ever RAISES the bar.
  if (g.extremeValidation) {
    const { pricedPilotReservations, paymentMethods, deposits } = inputs.extreme;
    const pilotsNeeded = g.minUniqueStrongCommitments;
    const methodsNeeded = g.minUniquePriceAcceptances;
    const depositsNeeded = 1;
    const extremeOk =
      pricedPilotReservations >= pilotsNeeded ||
      paymentMethods >= methodsNeeded ||
      deposits >= depositsNeeded;
    checks.push(
      check(
        CHECK_IDS.extremeValidationMonetary,
        'EXTREME_VALIDATION monetary commitment',
        extremeOk,
        `EXTREME_VALIDATION requires one of: ${pricedPilotReservations} price-accepted pilot ${plural(pricedPilotReservations, 'reservation')} (need ${pilotsNeeded}), ${paymentMethods} voluntarily supplied payment ${plural(paymentMethods, 'method')} (need ${methodsNeeded}), ${deposits} refundable pilot ${plural(deposits, 'deposit')} (need ${depositsNeeded})`,
        `${pricedPilotReservations} pilots / ${paymentMethods} payment methods / ${deposits} deposits`,
        `${pilotsNeeded} pilots OR ${methodsNeeded} payment methods OR ${depositsNeeded} deposit`,
      ),
    );
  }

  const unmetChecks = checks.filter((c) => !c.passed);
  return {
    opportunityId: opportunity.id,
    campaignId: inputs.campaignId,
    passed: unmetChecks.length === 0,
    checks,
    unmetChecks,
    evaluatedAt: new Date().toISOString(),
  };
}

/** Evaluates the gate WITHOUT transitioning. Safe to call from the dashboard. */
export async function evaluateGate(opportunityId: string): Promise<GateEvaluation> {
  return decideGate(await collectGateInputs(opportunityId));
}

/**
 * Evaluates, and mints the proof if — and only if — every check passed.
 *
 * The GateToken class has no exported constructor, so this function is the only
 * path in the entire system to a VALIDATION_STRONG or READY_TO_BUILD state.
 */
export async function evaluateGateAndMint(
  opportunityId: string,
): Promise<{ evaluation: GateEvaluation; token: GateToken | null }> {
  const evaluation = await evaluateGate(opportunityId);
  if (!evaluation.passed) return { evaluation, token: null };
  const token = __mintGateToken(
    opportunityId,
    evaluation.checks.map((c) => `${c.id}: ${c.detail}`),
  );
  return { evaluation, token };
}
