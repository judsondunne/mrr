/**
 * The one email the owner actually wants.
 *
 * Rules this renderer obeys, in order of importance:
 *   1. Every quotation comes from a database row. There is no code path that
 *      can produce a sentence a prospect did not write.
 *   2. FIRST REVENUE MATH is labelled arithmetic, never a forecast.
 *   3. The rendered body is scanned for promise language and the render throws
 *      if any survived. "Guaranteed MRR" can never be sent.
 */
import { getConfig } from '../../lib/config';
import { AppError } from '../../lib/errors';
import { collectDossier, type ValidationDossier } from '../validation/dossier';
import type { ProspectEvidenceItem } from '../validation/evidence';
import { assertNoGuaranteeLanguage, containsClaimLanguage } from './claims';

const MAX_EVIDENCE_ITEMS = 5;
const MAX_REQUIREMENTS = 6;
const MAX_COMPETITORS = 4;
const MAX_WAITING_LISTED = 12;

export function formatInt(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatMoney(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded)
    ? `$${formatInt(rounded)}`
    : `$${formatInt(Math.floor(rounded))}.${String(Math.round((rounded % 1) * 100)).padStart(2, '0')}`;
}

function firstSentence(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const end = normalized.search(/[.!?](\s|$)/);
  return end > 0 ? normalized.slice(0, end + 1) : normalized;
}

function pad(label: string, width = 26): string {
  return label.length >= width ? `${label} ` : label + ' '.repeat(width - label.length);
}

function unit(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatInt(n)} ${n === 1 ? singular : pluralForm}`;
}

function dateOnly(iso: string): string {
  return iso ? iso.slice(0, 10) : 'unknown date';
}

function evidenceLabel(item: ProspectEvidenceItem): string {
  const who = item.companyName ? `${item.companyName} [${item.companyKey}]` : item.companyKey;
  const via = item.origin === 'commitments' ? `via ${item.source}` : 'via email reply';
  return `${who} — ${item.kind} ${via} on ${dateOnly(item.occurredAt)}`;
}

export interface RenderedEmail {
  subject: string;
  body: string;
}

/**
 * Renders the READY_TO_BUILD email.
 *
 * Throws when the opportunity cannot be described exactly — no campaign, or a
 * wedge without a stated V1 scope. An email that cannot say precisely what to
 * build is worse than no email.
 */
export async function renderReadyToBuildEmail(opportunityId: string): Promise<RenderedEmail> {
  const dossier = await collectDossier(opportunityId);
  return renderFromDossier(dossier);
}

export function renderFromDossier(d: ValidationDossier): RenderedEmail {
  const cfg = getConfig();
  const name = d.wedge.productName ?? d.opportunity.name;

  if (!d.campaign) {
    throw new AppError(
      `opportunity ${d.opportunity.id} has no campaign, so there are no real validation results to report`,
      'NO_CAMPAIGN',
    );
  }
  const features = d.wedge.v1Features.slice(0, 5);
  if (features.length < 3) {
    throw new AppError(
      `opportunity ${d.opportunity.id} has only ${features.length} V1 features recorded; the owner email must name 3-5 MVP capabilities`,
      'WEDGE_INCOMPLETE',
    );
  }
  if (d.price === null) {
    throw new AppError(`opportunity ${d.opportunity.id} has no price to report`, 'PRICE_MISSING');
  }

  const price = d.price;
  const sections: string[] = [];
  const subject = `🚨 VALIDATED MRR OPPORTUNITY: ${name}`;

  sections.push(subject);

  // --- THE PRODUCT ---------------------------------------------------------
  const product =
    d.wedge.oneSentenceOutcome ??
    d.wedge.statement ??
    d.opportunity.proposed_wedge ??
    d.opportunity.description;
  sections.push(block('THE PRODUCT', [firstSentence(product || name)]));

  // --- WHO WANTS IT --------------------------------------------------------
  const icp =
    d.wedge.whoItIsFor ??
    d.wedge.targetCustomer ??
    d.opportunity.target_customer ??
    `${d.opportunity.ecosystem} businesses in ${d.opportunity.category}`;
  sections.push(block('WHO WANTS IT', [icp]));

  // --- PROPOSED PRICE ------------------------------------------------------
  sections.push(block('PROPOSED PRICE', [`${formatMoney(price)}/month`]));

  // --- REAL VALIDATION RESULTS --------------------------------------------
  const pilots = d.companiesByType.PILOT_SIGNUP ?? 0;
  const resultLines = [
    `${pad('Delivered:')}${formatInt(d.counts.delivered)}`,
    `${pad('Replies:')}${formatInt(d.counts.replied)}`,
    `${pad('Strong positive:')}${unit(d.counts.uniqueStrongCommitmentCompanies, 'unique company', 'unique companies')}`,
    `${pad('Price accepted:')}${unit(d.counts.uniquePriceAcceptanceCompanies, 'unique company', 'unique companies')}`,
    `${pad('Pilot reservations:')}${unit(pilots, 'unique company', 'unique companies')}`,
    `${pad('Install/trial requests:')}${unit(d.installOrTrialCompanies, 'unique company', 'unique companies')}`,
    `${pad('Other commitments:')}${unit(d.otherCommitmentCompanies, 'unique company', 'unique companies')}`,
    '',
    `VALIDATED — ${formatInt(d.counts.uniqueStrongCommitmentCompanies)} real ${d.counts.uniqueStrongCommitmentCompanies === 1 ? 'business' : 'businesses'} explicitly indicated they are prepared to use this at ${formatMoney(price)}/month.`,
    'Every number above counts unique companies, not emails or clicks. Opens are not counted at all.',
  ];
  sections.push(block('REAL VALIDATION RESULTS', resultLines));

  // --- ACTUAL PROSPECT EVIDENCE -------------------------------------------
  const evidenceLines: string[] = [];
  let omitted = 0;
  let shown = 0;
  for (const item of d.evidence) {
    if (shown >= MAX_EVIDENCE_ITEMS) break;
    if (containsClaimLanguage(item.quote)) {
      omitted += 1;
      continue;
    }
    evidenceLines.push(`  ${evidenceLabel(item)}`);
    evidenceLines.push(`    "${item.quote}"${item.truncated ? ' [truncated]' : ''}`);
    if (item.evidenceUrl) evidenceLines.push(`    source: ${item.evidenceUrl}`);
    shown += 1;
  }
  if (evidenceLines.length === 0) {
    evidenceLines.push('  (no quotable evidence rows found — see the evidence package link below)');
  }
  if (omitted > 0) {
    evidenceLines.push(
      `  (${omitted} ${omitted === 1 ? 'quote' : 'quotes'} omitted: the text contained promotional claim language this system will not repeat.)`,
    );
  }
  sections.push(block('ACTUAL PROSPECT EVIDENCE', evidenceLines));

  // --- WHY THIS CATEGORY IS ALREADY MONETIZED ------------------------------
  const competitorLines: string[] = [];
  for (const competitor of d.competitors.slice(0, MAX_COMPETITORS)) {
    const facts = [
      competitor.currentPricing ? `pricing: ${competitor.currentPricing}` : null,
      competitor.hasPermanentFreeTier === false ? 'no permanent free tier' : null,
      competitor.hasPermanentFreeTier === true ? 'has a free tier' : null,
      competitor.reviewCount !== null ? `${formatInt(competitor.reviewCount)} reviews` : null,
    ].filter((x): x is string => x !== null);
    competitorLines.push(`  ${competitor.name}${facts.length > 0 ? ` — ${facts.join(', ')}` : ''}`);
    competitorLines.push(`    ${competitor.url}`);
    for (const evidence of competitor.paymentEvidence.slice(0, 2)) {
      if (evidence.quote && !containsClaimLanguage(evidence.quote)) {
        competitorLines.push(`    [${evidence.type}] "${evidence.quote}"`);
      } else {
        competitorLines.push(`    [${evidence.type}]`);
      }
      competitorLines.push(`      ${evidence.sourceUrl}`);
    }
  }
  if (competitorLines.length === 0) {
    competitorLines.push('  (no competitor rows recorded for this opportunity)');
  }
  sections.push(block('WHY THIS CATEGORY IS ALREADY MONETIZED', competitorLines));

  // --- WHAT TO BUILD -------------------------------------------------------
  sections.push(
    block(
      'WHAT TO BUILD',
      features.map((feature, i) => `  ${i + 1}. ${feature}`),
    ),
  );

  // --- DO NOT BUILD --------------------------------------------------------
  const exclusions = d.wedge.excludedFromV1.length > 0
    ? d.wedge.excludedFromV1.map((x) => `  - ${x}`)
    : ['  - anything not listed under WHAT TO BUILD'];
  sections.push(block('DO NOT BUILD', exclusions));

  // --- CUSTOMER-DERIVED REQUIREMENTS ---------------------------------------
  const requirementLines: string[] = [];
  for (const requirement of d.requirements.slice(0, MAX_REQUIREMENTS)) {
    if (containsClaimLanguage(requirement.requirement)) continue;
    requirementLines.push(
      `  - ${requirement.requirement} (asked by ${unit(requirement.companies, 'company', 'companies')})`,
    );
  }
  if (requirementLines.length === 0) {
    requirementLines.push('  (no repeated capability request extracted from replies)');
  }
  sections.push(block('CUSTOMER-DERIVED REQUIREMENTS', requirementLines));

  // --- PROSPECTS WAITING ---------------------------------------------------
  const waiting = d.waitingCompanies;
  const waitingLines = [
    `${unit(waiting.length, 'company', 'companies')} already committed and can be contacted the day this ships.`,
    ...waiting
      .slice(0, MAX_WAITING_LISTED)
      .map(
        (c) =>
          `  - ${c.companyName ?? c.companyKey} [${c.domain ?? c.companyKey}] — ${c.commitmentTypes.join(', ')}`,
      ),
  ];
  if (waiting.length > MAX_WAITING_LISTED) {
    waitingLines.push(`  ...and ${formatInt(waiting.length - MAX_WAITING_LISTED)} more`);
  }
  sections.push(block('PROSPECTS WAITING', waitingLines));

  // --- ENGINEERING PLAN ----------------------------------------------------
  const planLines = [
    d.buildDays === null
      ? 'Build estimate: not recorded.'
      : `Build estimate: ${unit(d.buildDays, 'day')} (cap is ${unit(cfg.gate.maxMvpBuildDays, 'day')}).`,
    'Major pieces:',
    ...features.map((feature) => `  - ${feature}`),
  ];
  if (d.wedge.coreWorkflow) planLines.push(`Core workflow: ${d.wedge.coreWorkflow}`);
  sections.push(block('ENGINEERING PLAN', planLines));

  // --- FIRST REVENUE MATH --------------------------------------------------
  sections.push(block('FIRST REVENUE MATH', revenueMathLines(waiting.length, price)));

  // --- EVIDENCE PACKAGE ----------------------------------------------------
  const base = cfg.publicBaseUrl;
  const evidencePackage = [
    `${base}/admin/opportunities/${d.opportunity.id}`,
    `Campaign: ${d.campaign.id} (landing page /v/${d.campaign.landingSlug})`,
    `Gate: ${d.evaluation.checks.filter((c) => c.passed).length} of ${d.evaluation.checks.length} deterministic checks passed at ${d.evaluation.evaluatedAt}.`,
  ];
  sections.push(block('EVIDENCE PACKAGE', evidencePackage));

  const body = sections.join('\n\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';

  // The hard stop. Nothing leaves this function with a promise in it.
  assertNoGuaranteeLanguage(body, `READY_TO_BUILD email for ${d.opportunity.id}`);

  return { subject, body };
}

/**
 * Plain arithmetic, explicitly labelled as such. Multiplication is a fact;
 * conversion is not, so every line is written as a conditional.
 */
export function revenueMathLines(waitingCompanies: number, price: number): string[] {
  const lines = ['This is arithmetic, not a forecast:'];
  if (waitingCompanies > 0) {
    lines.push(
      `  ${formatInt(waitingCompanies)} waiting pilot ${waitingCompanies === 1 ? 'customer' : 'customers'} x ${formatMoney(price)} = ${formatMoney(waitingCompanies * price)} MRR if all convert`,
    );
  }
  for (const target of [500, 1000]) {
    const customers = Math.ceil(target / price);
    lines.push(
      `  ${formatInt(customers)} customers x ${formatMoney(price)} = ${formatMoney(customers * price)} MRR`,
    );
  }
  lines.push('  Conversion is not assumed anywhere above; these are multiplications.');
  return lines;
}

function block(heading: string, lines: string[]): string {
  return [heading, ...lines].join('\n');
}
