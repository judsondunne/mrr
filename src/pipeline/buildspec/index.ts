/**
 * PUBLIC API — BUILD SPEC GENERATOR. Owned by the validation agent.
 *
 * Writes validated/<slug>/ — a directory good enough to hand to a fresh Claude
 * Code session with "Build this. Do not expand scope."
 *
 * Assembly is deterministic: every capability, quote, price, count and URL in
 * the output is a database row rendered by code. A model may polish exactly one
 * paragraph (see ./prose.ts) and may not introduce a fact while doing it.
 * Writing is idempotent — re-running overwrites the same eight files.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../../lib/logger';
import { recordAudit } from '../../lib/audit';
import { collectDossier, type ValidationDossier } from '../validation/dossier';
import type { ProspectEvidenceItem } from '../validation/evidence';
import { containsClaimLanguage } from '../notify/claims';
import { formatInt, formatMoney, revenueMathLines } from '../notify/render';
import { resolveSpecLocation } from './paths';
import { polishParagraph } from './prose';

const logger = createLogger('buildspec');

export interface BuildSpecResult {
  slug: string;
  directory: string;
  files: string[];
}

export const SPEC_FILES = [
  'README.md',
  'market-evidence.md',
  'customers.md',
  'mvp.md',
  'requirements.md',
  'acceptance-tests.md',
  'architecture.md',
  'launch-plan.md',
] as const;

/** The nine headings mvp.md must contain, in this order. */
export const MVP_SECTIONS = [
  'PROBLEM',
  'ICP',
  'PRICE',
  'CORE WORKFLOW',
  'V1 FEATURES',
  'EXCLUDED FEATURES',
  'CUSTOMER EVIDENCE',
  'COMPETITOR EVIDENCE',
  'ACCEPTANCE CRITERIA',
] as const;

interface Requirement {
  id: string;
  text: string;
  origin: 'wedge' | 'customer';
  sourceNote: string;
}

interface SpecContext {
  d: ValidationDossier;
  productName: string;
  icp: string;
  problem: string;
  price: number | null;
  features: string[];
  exclusions: string[];
  requirements: Requirement[];
  quotableEvidence: ProspectEvidenceItem[];
  generatedAt: string;
}

export async function generateBuildSpec(opportunityId: string): Promise<BuildSpecResult> {
  const d = await collectDossier(opportunityId);
  const ctx = buildContext(d);

  const location = resolveSpecLocation(
    d.campaign?.landingSlug ?? ctx.productName,
    `opportunity-${d.opportunity.id}`,
  );
  await mkdir(location.directory, { recursive: true });

  const summary = await polishParagraph({
    task: 'buildspec_readme_summary',
    context: [
      `product: ${ctx.productName}`,
      `customer: ${ctx.icp}`,
      `workflow: ${d.wedge.coreWorkflow ?? 'not recorded'}`,
      `why they would switch: ${d.wedge.reasonSomeoneWouldSwitch ?? 'not recorded'}`,
    ].join('\n'),
    deterministic: deterministicSummary(ctx),
  });

  const contents: Record<string, string> = {
    'README.md': renderReadme(ctx, summary),
    'market-evidence.md': renderMarketEvidence(ctx),
    'customers.md': renderCustomers(ctx),
    'mvp.md': renderMvp(ctx),
    'requirements.md': renderRequirements(ctx),
    'acceptance-tests.md': renderAcceptanceTests(ctx),
    'architecture.md': renderArchitecture(ctx),
    'launch-plan.md': renderLaunchPlan(ctx),
  };

  for (const file of SPEC_FILES) {
    await writeFile(path.join(location.directory, file), contents[file] ?? '', 'utf8');
  }

  await recordAudit({
    entityType: 'opportunity',
    entityId: d.opportunity.id,
    eventType: 'DECISION',
    actor: 'generate_build_spec',
    reason: 'build spec written',
    detail: { slug: location.slug, files: [...SPEC_FILES] },
  });
  logger.info('build spec written', { opportunityId, slug: location.slug, directory: location.directory });

  return { slug: location.slug, directory: location.directory, files: [...SPEC_FILES] };
}

// --- context -----------------------------------------------------------------

function buildContext(d: ValidationDossier): SpecContext {
  const productName = d.wedge.productName ?? d.opportunity.name;
  const icp =
    d.wedge.whoItIsFor ??
    d.wedge.targetCustomer ??
    d.opportunity.target_customer ??
    `${d.opportunity.ecosystem} businesses in ${d.opportunity.category}`;
  const problem =
    d.wedge.statement ??
    d.opportunity.proposed_wedge ??
    d.opportunity.description ??
    `${d.opportunity.category} on ${d.opportunity.ecosystem}`;

  const features = d.wedge.v1Features.slice(0, 5);
  const exclusions = d.wedge.excludedFromV1;

  const requirements: Requirement[] = [];
  features.forEach((feature, i) => {
    requirements.push({
      id: `REQ-${i + 1}`,
      text: feature,
      origin: 'wedge',
      sourceNote: `wedge V1 feature ${i + 1} (opportunities.wedge_json of ${d.opportunity.id})`,
    });
  });
  d.requirements.forEach((requirement, i) => {
    requirements.push({
      id: `REQ-${features.length + i + 1}`,
      text: requirement.requirement,
      origin: 'customer',
      sourceNote: `requested by ${requirement.companies} ${requirement.companies === 1 ? 'company' : 'companies'} (messages: ${requirement.sourceRowIds.join(', ')})`,
    });
  });

  return {
    d,
    productName,
    icp,
    problem,
    price: d.price,
    features,
    exclusions,
    requirements,
    quotableEvidence: d.evidence.filter((e) => !containsClaimLanguage(e.quote)),
    generatedAt: new Date().toISOString(),
  };
}

function deterministicSummary(ctx: SpecContext): string {
  const parts = [
    `${ctx.productName} is a deliberately narrow ${ctx.d.opportunity.ecosystem} product for ${ctx.icp}.`,
  ];
  if (ctx.d.wedge.oneSentenceOutcome) parts.push(ctx.d.wedge.oneSentenceOutcome);
  if (ctx.d.wedge.reasonSomeoneWouldSwitch) {
    parts.push(`Prospects said they would switch because: ${ctx.d.wedge.reasonSomeoneWouldSwitch}`);
  }
  parts.push('Build exactly what is listed in mvp.md and nothing else.');
  return parts.join(' ');
}

// --- shared renderers --------------------------------------------------------

function quoteBlock(item: ProspectEvidenceItem): string[] {
  const who = item.companyName ? `${item.companyName} (${item.companyKey})` : item.companyKey;
  const lines = [
    `- **${who}** — ${item.kind} via ${item.source} on ${item.occurredAt.slice(0, 10) || 'unknown date'}`,
    `  > "${item.quote}"${item.truncated ? ' [truncated]' : ''}`,
    `  _source row: ${item.origin}.${item.rowId}_`,
  ];
  if (item.evidenceUrl) lines.push(`  _evidence url: ${item.evidenceUrl}_`);
  return lines;
}

function priceLine(ctx: SpecContext): string {
  return ctx.price === null ? 'not recorded' : `${formatMoney(ctx.price)}/month`;
}

function header(ctx: SpecContext, title: string): string[] {
  return [
    `# ${title}`,
    '',
    `Opportunity: \`${ctx.d.opportunity.id}\` · ecosystem: ${ctx.d.opportunity.ecosystem} · category: ${ctx.d.opportunity.category}`,
    `Generated: ${ctx.generatedAt}`,
    '',
  ];
}

// --- README.md ---------------------------------------------------------------

function renderReadme(ctx: SpecContext, summary: string): string {
  const d = ctx.d;
  const lines = [
    ...header(ctx, `${ctx.productName} — validated build spec`),
    '**Build this. Do not expand scope.**',
    '',
    summary,
    '',
    '## What is already proven',
    '',
    `- ${formatInt(d.counts.uniqueStrongCommitmentCompanies)} unique companies produced a strong purchase-intent event.`,
    `- ${formatInt(d.counts.uniquePriceAcceptanceCompanies)} unique companies accepted ${priceLine(ctx)}.`,
    `- ${formatInt(d.counts.uniqueActionCommitmentCompanies)} unique companies acted beyond conversation (install, trial, onboarding data or payment).`,
    `- ${formatInt(d.counts.delivered)} outreach emails were delivered and ${formatInt(d.counts.replied)} replies came back.`,
    `- ${formatInt(d.counts.qualifiedProspects)} qualified prospects were identified for this ICP.`,
    '',
    'Counts are unique companies, never message counts. Opens are not counted at all.',
    '',
    '## Gate result',
    '',
    ...d.evaluation.checks.map(
      (check) => `- [${check.passed ? 'x' : ' '}] **${check.label}** — ${check.detail}`,
    ),
    '',
    '## Files',
    '',
    '| file | what it is |',
    '| --- | --- |',
    '| `mvp.md` | the scope contract: problem, ICP, price, workflow, V1, exclusions, acceptance |',
    '| `market-evidence.md` | why this category already takes money, with source URLs |',
    '| `customers.md` | the real businesses that committed, and what they asked for |',
    '| `requirements.md` | numbered requirements, each traced to a row |',
    '| `acceptance-tests.md` | the Given/When/Then set that says V1 is done |',
    '| `architecture.md` | the smallest architecture that satisfies V1 |',
    '| `launch-plan.md` | who to contact on day one and what to charge |',
    '',
    '## Rules for the session that builds this',
    '',
    '1. Implement only the V1 features in `mvp.md`. Anything in EXCLUDED FEATURES is out.',
    '2. If a requirement is ambiguous, pick the interpretation supported by `customers.md`.',
    '3. Ship the acceptance tests in `acceptance-tests.md` before adding anything else.',
    '4. Do not add a second customer type, a second workflow, or an integration nobody asked for.',
    '',
  ];
  return lines.join('\n');
}

// --- market-evidence.md ------------------------------------------------------

function renderMarketEvidence(ctx: SpecContext): string {
  const d = ctx.d;
  const lines = [
    ...header(ctx, 'Market evidence — this category already takes money'),
    `Category payment evidence recorded on the opportunity: **${d.opportunity.evidence_confidence ?? 'NONE'}**.`,
    '',
    'Category demand is NOT proof that anyone wants this wedge. That proof lives in `customers.md`.',
    '',
  ];

  if (d.competitors.length === 0) {
    lines.push('_No competitor rows were recorded for this opportunity._', '');
  }

  for (const competitor of d.competitors) {
    lines.push(`## ${competitor.name}`, '');
    lines.push(`- URL: ${competitor.url}`);
    if (competitor.currentPricing) lines.push(`- Pricing: ${competitor.currentPricing}`);
    if (competitor.freePlanDetails) lines.push(`- Free plan: ${competitor.freePlanDetails}`);
    if (competitor.hasPermanentFreeTier !== null) {
      lines.push(`- Permanent free tier: ${competitor.hasPermanentFreeTier ? 'yes' : 'no'}`);
    }
    if (competitor.reviewCount !== null) lines.push(`- Reviews: ${formatInt(competitor.reviewCount)}`);
    if (competitor.rating !== null) lines.push(`- Rating: ${competitor.rating}`);
    if (competitor.launchAge) lines.push(`- Launched: ${competitor.launchAge}`);
    lines.push('');
    if (competitor.paymentEvidence.length > 0) {
      lines.push('Payment evidence:', '');
      for (const evidence of competitor.paymentEvidence) {
        lines.push(`- \`${evidence.type}\` (${evidence.confidence}) — ${evidence.sourceUrl}`);
        if (evidence.quote && !containsClaimLanguage(evidence.quote)) {
          lines.push(`  > "${evidence.quote}"`);
        }
      }
      lines.push('');
    }
  }

  if (d.opportunity.source_url) {
    lines.push('## Discovery source', '', d.opportunity.source_url, '');
  }
  return lines.join('\n');
}

// --- customers.md ------------------------------------------------------------

function renderCustomers(ctx: SpecContext): string {
  const d = ctx.d;
  const lines = [
    ...header(ctx, 'Customers — the businesses that actually committed'),
    'Every line on this page is a database row. Nothing here is paraphrased or invented.',
    '',
    '## Companies waiting',
    '',
  ];

  if (d.waitingCompanies.length === 0) {
    lines.push('_No company has committed yet._', '');
  } else {
    lines.push(
      '| company | domain | commitments | price accepted |',
      '| --- | --- | --- | --- |',
    );
    for (const company of d.waitingCompanies) {
      lines.push(
        `| ${company.companyName ?? company.companyKey} | ${company.domain ?? company.companyKey} | ${company.commitmentTypes.join(', ')} | ${company.priceMonthly === null ? '—' : `${formatMoney(company.priceMonthly)}/month`} |`,
      );
    }
    lines.push('');
  }

  lines.push('## What they said', '');
  if (ctx.quotableEvidence.length === 0) {
    lines.push('_No quotable evidence rows._', '');
  } else {
    for (const item of ctx.quotableEvidence) lines.push(...quoteBlock(item));
    lines.push('');
  }

  lines.push('## Features derived from this feedback', '');
  if (d.requirements.length === 0) {
    lines.push('_No repeated capability request was extracted from replies._', '');
  } else {
    lines.push('| requested capability | companies | source message rows |', '| --- | --- | --- |');
    for (const requirement of d.requirements) {
      lines.push(
        `| ${requirement.requirement} | ${formatInt(requirement.companies)} | ${requirement.sourceRowIds.join(', ')} |`,
      );
    }
    lines.push('');
  }

  lines.push(
    '## How to use this page',
    '',
    'When a V1 decision is ambiguous, choose the option that satisfies the most companies above.',
    'If a proposed feature appears nowhere on this page, it is not in V1.',
    '',
  );
  return lines.join('\n');
}

// --- mvp.md ------------------------------------------------------------------

function renderMvp(ctx: SpecContext): string {
  const d = ctx.d;
  const lines = [...header(ctx, `${ctx.productName} — MVP scope contract`)];

  lines.push('## PROBLEM', '', ctx.problem, '');

  lines.push('## ICP', '', ctx.icp, '');
  lines.push(
    `Qualified prospects identified: ${formatInt(d.counts.qualifiedProspects)}. Companies already committed: ${formatInt(d.waitingCompanies.length)}.`,
    '',
  );

  lines.push('## PRICE', '', priceLine(ctx), '');
  lines.push(
    `${formatInt(d.counts.uniquePriceAcceptanceCompanies)} unique companies accepted this price explicitly or joined the pilot at it.`,
    '',
  );

  lines.push('## CORE WORKFLOW', '', d.wedge.coreWorkflow ?? '_not recorded on the wedge_', '');

  lines.push('## V1 FEATURES', '');
  ctx.features.forEach((feature, i) => lines.push(`${i + 1}. ${feature}`));
  lines.push('');

  lines.push('## EXCLUDED FEATURES', '');
  if (ctx.exclusions.length === 0) {
    lines.push('- anything not listed under V1 FEATURES');
  } else {
    for (const exclusion of ctx.exclusions) lines.push(`- ${exclusion}`);
  }
  lines.push('');

  lines.push('## CUSTOMER EVIDENCE', '');
  if (ctx.quotableEvidence.length === 0) {
    lines.push('_see customers.md_');
  } else {
    for (const item of ctx.quotableEvidence.slice(0, 5)) lines.push(...quoteBlock(item));
  }
  lines.push('');

  lines.push('## COMPETITOR EVIDENCE', '');
  if (d.competitors.length === 0) {
    lines.push('_no competitor rows recorded_');
  } else {
    for (const competitor of d.competitors) {
      const pricing = competitor.currentPricing ? ` — ${competitor.currentPricing}` : '';
      lines.push(`- ${competitor.name}${pricing} — ${competitor.url}`);
    }
  }
  lines.push('');

  lines.push('## ACCEPTANCE CRITERIA', '');
  ctx.requirements.forEach((requirement) => {
    lines.push(`- ${requirement.id}: ${requirement.text}`);
  });
  lines.push('', 'Full Given/When/Then set: `acceptance-tests.md`.', '');

  return lines.join('\n');
}

// --- requirements.md ---------------------------------------------------------

function renderRequirements(ctx: SpecContext): string {
  const lines = [
    ...header(ctx, 'Requirements'),
    'Each requirement traces to a row. A requirement with no source does not exist.',
    '',
    '| id | requirement | origin | source |',
    '| --- | --- | --- | --- |',
  ];
  for (const requirement of ctx.requirements) {
    lines.push(
      `| ${requirement.id} | ${requirement.text} | ${requirement.origin} | ${requirement.sourceNote} |`,
    );
  }
  lines.push(
    '',
    '## Non-negotiable constraints',
    '',
    `- Price is ${priceLine(ctx)}; do not add a second paid tier in V1.`,
    ctx.d.buildDays === null
      ? '- No build estimate was recorded.'
      : `- The estimate that passed the gate is ${formatInt(ctx.d.buildDays)} days. If the plan exceeds it, cut scope, not quality.`,
    '- No feature may be added that is not in `mvp.md`.',
    '',
  );
  return lines.join('\n');
}

// --- acceptance-tests.md -----------------------------------------------------

function renderAcceptanceTests(ctx: SpecContext): string {
  const lines = [
    ...header(ctx, 'Acceptance tests'),
    'V1 is done when every test below passes. Not before, and not after adding more.',
    '',
  ];

  ctx.requirements.forEach((requirement, i) => {
    lines.push(`## AT-${i + 1} — ${requirement.id}`, '');
    lines.push(`**Requirement:** ${requirement.text}`);
    lines.push(`**Source:** ${requirement.sourceNote}`);
    lines.push('');
    lines.push(`- **Given** a ${ctx.icp} account with the product installed`);
    lines.push(`- **When** the operator performs the workflow that exercises: ${requirement.text}`);
    lines.push('- **Then** the outcome is persisted, visible on reload, and produced no error');
    lines.push('');
  });

  lines.push(
    '## AT-BILLING',
    '',
    `- **Given** a new account on the ${priceLine(ctx)} plan`,
    '- **When** the trial or pilot period ends',
    '- **Then** the account is charged the displayed price and the invoice is visible to the customer',
    '',
    '## AT-SCOPE',
    '',
    '- **Given** the shipped product',
    '- **When** its surface is reviewed against `mvp.md`',
    '- **Then** nothing exists that is listed under EXCLUDED FEATURES',
    '',
  );
  return lines.join('\n');
}

// --- architecture.md ---------------------------------------------------------

function renderArchitecture(ctx: SpecContext): string {
  const d = ctx.d;
  const lines = [
    ...header(ctx, 'Architecture — the smallest thing that satisfies V1'),
    d.buildDays === null
      ? 'No build estimate was recorded; keep the design small enough to ship in one week.'
      : `Budget: ${formatInt(d.buildDays)} days. Every decision below exists to protect that number.`,
    '',
    '## Shape',
    '',
    `- One ${d.opportunity.ecosystem} app/integration, one database, one background worker. No microservices.`,
    '- Server-rendered admin UI. No SPA unless a V1 feature genuinely requires one.',
    '- Single Postgres database. Every table owned by this product.',
    '- Billing via an off-the-shelf provider. Do not build subscription logic by hand.',
    '',
    '## Data model sketch',
    '',
    '| entity | why V1 needs it |',
    '| --- | --- |',
    `| account | one row per ${ctx.icp.split(' ').slice(0, 6).join(' ')} customer |`,
    '| configuration | the settings the core workflow reads |',
    '| event log | what the product did, for support and for the customer |',
    '| subscription | plan, price, status, from the billing provider |',
    '',
    '## Integration notes',
    '',
    d.wedge.primaryCompetitor
      ? `- The incumbent is ${d.wedge.primaryCompetitor}. Match its data model only where a customer asked for it.`
      : '- No primary competitor was recorded.',
    `- Core workflow to support end to end: ${d.wedge.coreWorkflow ?? 'see mvp.md'}`,
    '',
    '## Explicit non-goals',
    '',
    ...(ctx.exclusions.length > 0
      ? ctx.exclusions.map((exclusion) => `- ${exclusion}`)
      : ['- anything not in V1 FEATURES']),
    '',
  ];
  return lines.join('\n');
}

// --- launch-plan.md ----------------------------------------------------------

function renderLaunchPlan(ctx: SpecContext): string {
  const d = ctx.d;
  const waiting = d.waitingCompanies;
  const lines = [
    ...header(ctx, 'Launch plan'),
    '## Day one contacts',
    '',
    `${formatInt(waiting.length)} ${waiting.length === 1 ? 'company' : 'companies'} already committed during validation.`,
    '',
  ];

  if (waiting.length > 0) {
    lines.push(
      '| company | domain | what they committed to | price |',
      '| --- | --- | --- | --- |',
    );
    for (const company of waiting) {
      lines.push(
        `| ${company.companyName ?? company.companyKey} | ${company.domain ?? company.companyKey} | ${company.commitmentTypes.join(', ')} | ${company.priceMonthly === null ? '—' : `${formatMoney(company.priceMonthly)}/month`} |`,
      );
    }
    lines.push('');
  }

  lines.push(
    '## Sequence',
    '',
    '1. Ship V1 to a private URL and invite the committed companies first.',
    '2. Onboard them one at a time; watch the core workflow end to end for each.',
    '3. Charge the displayed price from day one. No indefinite free pilot.',
    '4. Only after every committed company is live, reopen outreach to the rest of the qualified list.',
    '',
    '## First revenue math',
    '',
    '```',
    ...(ctx.price === null
      ? ['no price recorded; arithmetic cannot be shown']
      : revenueMathLines(waiting.length, ctx.price)),
    '```',
    '',
    '## What would falsify this',
    '',
    '- A committed company declines to onboard when the product is real.',
    '- The core workflow needs data the platform will not give us.',
    '- Nobody converts to a paid plan after onboarding.',
    '',
    'Any of those means stop, write down which one, and do not build more features.',
    '',
  );
  return lines.join('\n');
}
