/**
 * PUBLIC API — BUILD SPEC GENERATOR. Owned by the validation agent.
 *
 * Writes validated/<slug>/ — a directory good enough to hand to a fresh Claude
 * Code session with "Build this. Do not expand scope."
 *
 * Assembly is deterministic: every capability, quote, price, count and URL in
 * the output is a database row rendered by code. A model may polish exactly one
 * paragraph (see ./prose.ts) and may not introduce a fact while doing it.
 * Writing is idempotent — re-running overwrites the same thirteen files.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../../lib/logger';
import { recordAudit } from '../../lib/audit';
import { AppError } from '../../lib/errors';
import { collectDossier, type ValidationDossier } from '../validation/dossier';
import type { ProspectEvidenceItem } from '../validation/evidence';
import { containsClaimLanguage } from '../notify/claims';
import { formatInt, formatMoney, revenueMathLines } from '../notify/render';
import { resolveSpecLocation } from './paths';
import { polishParagraph } from './prose';
import { traceRequirements, type SpecRequirement, type DroppedFeature } from './requirements';
import { lastFeasibilityReport } from '../../autonomy/feasibility';

const logger = createLogger('buildspec');

export interface BuildSpecResult {
  slug: string;
  directory: string;
  files: string[];
}

/**
 * The complete hand-off package. One concern per file, so a build session can
 * read only what it needs and a reviewer can check one claim at a time.
 */
export const SPEC_FILES = [
  'README.md',
  'MARKET.md',
  'ICP.md',
  'CUSTOMER_EVIDENCE.md',
  'COMPETITORS.md',
  'PRICING.md',
  'REQUIREMENTS.md',
  'NON_GOALS.md',
  'ARCHITECTURE.md',
  'API_FEASIBILITY.md',
  'ACCEPTANCE_TESTS.md',
  'LAUNCH_PLAN.md',
  'WAITING_CUSTOMERS.md',
] as const;

interface SpecContext {
  d: ValidationDossier;
  productName: string;
  icp: string;
  problem: string;
  price: number | null;
  features: string[];
  exclusions: string[];
  /** Traced requirements: every one cites the rows that justify it. */
  requirements: SpecRequirement[];
  /** V1 features that no row supports. They are cut, and named in NON_GOALS.md. */
  droppedFeatures: DroppedFeature[];
  quotableEvidence: ProspectEvidenceItem[];
  feasibility: FeasibilitySummary;
  generatedAt: string;
}

type FeasibilitySummary = Awaited<ReturnType<typeof lastFeasibilityReport>>;

export async function generateBuildSpec(opportunityId: string): Promise<BuildSpecResult> {
  const d = await collectDossier(opportunityId);
  // Read, never re-run: the notify path already paid for the spike.
  const feasibility = await lastFeasibilityReport(opportunityId);
  const ctx = buildContext(d, feasibility);

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

  const contents: Record<(typeof SPEC_FILES)[number], string> = {
    'README.md': renderReadme(ctx, summary),
    'MARKET.md': renderMarket(ctx),
    'ICP.md': renderIcp(ctx),
    'CUSTOMER_EVIDENCE.md': renderCustomerEvidence(ctx),
    'COMPETITORS.md': renderCompetitors(ctx),
    'PRICING.md': renderPricing(ctx),
    'REQUIREMENTS.md': renderRequirements(ctx),
    'NON_GOALS.md': renderNonGoals(ctx),
    'ARCHITECTURE.md': renderArchitecture(ctx),
    'API_FEASIBILITY.md': renderApiFeasibility(ctx),
    'ACCEPTANCE_TESTS.md': renderAcceptanceTests(ctx),
    'LAUNCH_PLAN.md': renderLaunchPlan(ctx),
    'WAITING_CUSTOMERS.md': renderWaitingCustomers(ctx),
  };

  for (const file of SPEC_FILES) {
    const body = contents[file];
    // An empty hand-off file is worse than a missing one: it looks complete.
    // A renderer that produces nothing is a bug, not a valid output.
    if (body === undefined || body.trim() === '') {
      throw new AppError(`build spec renderer produced no content for ${file}`, 'EMPTY_SPEC_FILE', false, {
        opportunityId,
        file,
      });
    }
    await writeFile(path.join(location.directory, file), body, 'utf8');
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

function buildContext(d: ValidationDossier, feasibility: FeasibilitySummary): SpecContext {
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

  // A V1 feature earns a requirement only by citing real rows. Anything the
  // evidence does not support is dropped here and named in NON_GOALS.md, so a
  // speculative feature cannot reach the build session at all.
  const traced = traceRequirements({
    v1Features: features,
    coreWorkflow: d.wedge.coreWorkflow,
    evidenceRows: d.evidenceRows,
    customerRequirements: d.requirements,
  });

  return {
    d,
    productName,
    icp,
    problem,
    price: d.price,
    features,
    exclusions,
    requirements: traced.requirements,
    droppedFeatures: traced.dropped,
    quotableEvidence: d.evidence.filter((e) => !containsClaimLanguage(e.quote)),
    feasibility,
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


function requirementRows(ctx: SpecContext): string[] {
  const lines = ['| id | requirement | basis | companies | source rows |', '| --- | --- | --- | --- | --- |'];
  for (const r of ctx.requirements) {
    lines.push(
      `| ${r.id} | ${r.text} | ${r.basis} | ${formatInt(r.companies)} | ${r.supportingRowIds
        .map((id) => `\`${id}\``)
        .join(', ')} |`,
    );
  }
  return lines;
}

function companyTable(ctx: SpecContext): string[] {
  const lines = [
    '| company | domain | what they committed to | price accepted |',
    '| --- | --- | --- | --- |',
  ];
  for (const c of ctx.d.waitingCompanies) {
    lines.push(
      `| ${c.companyName ?? c.companyKey} | ${c.domain ?? c.companyKey} | ${c.commitmentTypes.join(', ')} | ${
        c.priceMonthly === null ? '—' : `${formatMoney(c.priceMonthly)}/month`
      } |`,
    );
  }
  return lines;
}

// --- README.md ---------------------------------------------------------------

function renderReadme(ctx: SpecContext, summary: string): string {
  const d = ctx.d;
  return [
    ...header(ctx, `${ctx.productName} — validated build spec`),
    '**Build this. Do not expand scope.**',
    '',
    summary,
    '',
    '## The problem, in one place',
    '',
    ctx.problem,
    '',
    '## The core workflow this product exists to run',
    '',
    d.wedge.coreWorkflow ?? 'Not recorded on the wedge; see `REQUIREMENTS.md` for the committed scope.',
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
    ...d.evaluation.checks.map((check) => `- [${check.passed ? 'x' : ' '}] **${check.label}** — ${check.detail}`),
    '',
    '## Files',
    '',
    '| file | what it is |',
    '| --- | --- |',
    '| `MARKET.md` | why this category already takes money, with source URLs |',
    '| `ICP.md` | exactly who the customer is, and who is excluded |',
    '| `CUSTOMER_EVIDENCE.md` | verbatim customer text, each quote tied to its row id |',
    '| `COMPETITORS.md` | the alternatives, their pricing, and their recorded weaknesses |',
    '| `PRICING.md` | the price, who accepted it, and the revenue arithmetic |',
    '| `REQUIREMENTS.md` | numbered requirements, each traced to commitment/message rows |',
    '| `NON_GOALS.md` | what is explicitly NOT in V1, including features the evidence did not support |',
    '| `ARCHITECTURE.md` | the smallest architecture that satisfies V1 |',
    '| `API_FEASIBILITY.md` | which platform capabilities were verified, and which were not |',
    '| `ACCEPTANCE_TESTS.md` | the Given/When/Then set that says V1 is done |',
    '| `LAUNCH_PLAN.md` | the sequence from first deploy to first charge |',
    '| `WAITING_CUSTOMERS.md` | the real businesses to contact on day one |',
    '',
    '## Rules for the session that builds this',
    '',
    '1. Implement only the requirements in `REQUIREMENTS.md`. Anything in `NON_GOALS.md` is out.',
    '2. If a requirement is ambiguous, pick the interpretation supported by `CUSTOMER_EVIDENCE.md`.',
    '3. Ship the tests in `ACCEPTANCE_TESTS.md` before adding anything else.',
    '4. Do not add a second customer type, a second workflow, or an integration nobody asked for.',
    '',
  ].join('\n');
}

// --- MARKET.md ---------------------------------------------------------------

function renderMarket(ctx: SpecContext): string {
  const d = ctx.d;
  const paid = d.competitors.filter((c) => c.hasPermanentFreeTier === false);
  const lines = [
    ...header(ctx, 'Market — this category already takes money'),
    `Category payment evidence recorded on the opportunity: **${d.opportunity.evidence_confidence ?? 'NONE'}**.`,
    '',
    'Category demand is NOT proof that anyone wants this wedge. That proof lives in',
    '`CUSTOMER_EVIDENCE.md`. This page only establishes that money already moves here.',
    '',
    '## What the market looks like',
    '',
    `- Competitors recorded: ${formatInt(d.competitors.length)}`,
    `- Competitors with no permanent free tier: ${formatInt(paid.length)}`,
    `- Ecosystem: ${d.opportunity.ecosystem}`,
    `- Category: ${d.opportunity.category}`,
    '',
    '## Recorded payment evidence',
    '',
  ];

  const evidence = d.competitors.flatMap((c) => c.paymentEvidence.map((e) => ({ competitor: c.name, e })));
  if (evidence.length === 0) {
    lines.push(
      'No competitor payment-evidence rows were recorded. The gate requires category',
      'evidence, so treat this as a reason to re-check before building.',
      '',
    );
  } else {
    for (const { competitor, e } of evidence) {
      lines.push(`- **${competitor}** — \`${e.type}\` (${e.confidence}) — ${e.sourceUrl}`);
      if (e.quote && !containsClaimLanguage(e.quote)) lines.push(`  > "${e.quote}"`);
    }
    lines.push('');
  }

  lines.push(
    '## Discovery source',
    '',
    d.opportunity.source_url
      ? d.opportunity.source_url
      : 'No discovery source URL was recorded on the opportunity.',
    '',
    'Full per-competitor detail: `COMPETITORS.md`.',
    '',
  );
  return lines.join('\n');
}

// --- ICP.md ------------------------------------------------------------------

function renderIcp(ctx: SpecContext): string {
  const d = ctx.d;
  const lines = [
    ...header(ctx, 'ICP — who this is for'),
    '## The customer',
    '',
    ctx.icp,
    '',
    '## How we know they exist',
    '',
    `- ${formatInt(d.counts.qualifiedProspects)} businesses were qualified against this ICP from public evidence.`,
    `- ${formatInt(d.counts.delivered)} of them received outreach and ${formatInt(d.counts.replied)} replied.`,
    `- ${formatInt(d.waitingCompanies.length)} committed. They are listed in \`WAITING_CUSTOMERS.md\`.`,
    '',
    'Every qualified prospect was verified by fetching its own public page. None came',
    'from a purchased list, and none was qualified from a search snippet alone.',
    '',
  ];

  if (d.waitingCompanies.length > 0) {
    lines.push('## The companies that actually committed', '', ...companyTable(ctx), '');
  }

  lines.push('## Who is NOT the customer', '');
  if (ctx.exclusions.length === 0) {
    lines.push(
      'No exclusions were recorded on the wedge. Treat any second customer type as out',
      'of scope until a commitment row says otherwise.',
      '',
    );
  } else {
    lines.push(
      'The wedge explicitly excludes the following, which also means the customers who',
      'need them are not the V1 customer:',
      '',
    );
    for (const exclusion of ctx.exclusions) lines.push(`- ${exclusion}`);
    lines.push('');
  }
  return lines.join('\n');
}

// --- CUSTOMER_EVIDENCE.md ----------------------------------------------------

function renderCustomerEvidence(ctx: SpecContext): string {
  const d = ctx.d;
  const lines = [
    ...header(ctx, 'Customer evidence — what they actually said'),
    'Every quote below is a verbatim database row, cited by id. Nothing here is',
    'paraphrased, summarised or invented. A claim that cannot cite a row is not on',
    'this page.',
    '',
    '## Quotes',
    '',
  ];

  if (ctx.quotableEvidence.length === 0) {
    lines.push(
      'No quotable evidence row survived the claim-language filter. This is a blocker,',
      'not a formatting problem: do not build from an empty evidence page.',
      '',
    );
  } else {
    for (const item of ctx.quotableEvidence) lines.push(...quoteBlock(item));
    lines.push('');
  }

  lines.push('## Capabilities customers asked for, in their own words', '');
  if (d.requirements.length === 0) {
    lines.push(
      'No repeated capability request was extracted from replies. V1 is therefore the',
      'core workflow only — see `REQUIREMENTS.md`.',
      '',
    );
  } else {
    lines.push('| requested capability | companies | source message rows |', '| --- | --- | --- |');
    for (const r of d.requirements) {
      lines.push(
        `| ${r.requirement} | ${formatInt(r.companies)} | ${r.sourceRowIds.map((id) => `\`messages.${id}\``).join(', ')} |`,
      );
    }
    lines.push('');
  }

  lines.push(
    '## How to use this page',
    '',
    'When a V1 decision is ambiguous, choose the option that satisfies the most',
    'companies above. If a proposed feature appears nowhere on this page and nowhere',
    'in the core workflow, it is not in V1 — see `NON_GOALS.md`.',
    '',
  );
  return lines.join('\n');
}

// --- COMPETITORS.md ----------------------------------------------------------

function renderCompetitors(ctx: SpecContext): string {
  const d = ctx.d;
  const lines = [
    ...header(ctx, 'Competitors — what customers use today'),
    d.wedge.primaryCompetitor
      ? `The alternative named on the wedge is **${d.wedge.primaryCompetitor}**.`
      : 'No primary competitor was named on the wedge; the alternative may be a spreadsheet.',
    '',
    d.wedge.reasonSomeoneWouldSwitch
      ? `Recorded reason someone would switch: ${d.wedge.reasonSomeoneWouldSwitch}`
      : 'No switching reason was recorded on the wedge.',
    '',
  ];

  if (d.competitors.length === 0) {
    lines.push(
      '## No competitor rows recorded',
      '',
      'Nothing was recorded for this opportunity. Match no incumbent data model; build',
      'only what `REQUIREMENTS.md` says.',
      '',
    );
    return lines.join('\n');
  }

  lines.push('| competitor | pricing | permanent free tier | reviews | rating |', '| --- | --- | --- | --- | --- |');
  for (const c of d.competitors) {
    lines.push(
      `| ${c.name} | ${c.currentPricing ?? 'unknown'} | ${
        c.hasPermanentFreeTier === null ? 'unknown' : c.hasPermanentFreeTier ? 'yes' : 'no'
      } | ${c.reviewCount === null ? '—' : formatInt(c.reviewCount)} | ${c.rating ?? '—'} |`,
    );
  }
  lines.push('');

  for (const c of d.competitors) {
    lines.push(`## ${c.name}`, '', `- URL: ${c.url}`);
    if (c.currentPricing) lines.push(`- Pricing: ${c.currentPricing}`);
    if (c.freePlanDetails) lines.push(`- Free plan: ${c.freePlanDetails}`);
    if (c.launchAge) lines.push(`- Launched: ${c.launchAge}`);
    lines.push('');
    if (c.paymentEvidence.length > 0) {
      lines.push('Payment evidence:', '');
      for (const e of c.paymentEvidence) {
        lines.push(`- \`${e.type}\` (${e.confidence}) — ${e.sourceUrl}`);
        if (e.quote && !containsClaimLanguage(e.quote)) lines.push(`  > "${e.quote}"`);
      }
      lines.push('');
    }
  }

  lines.push(
    '## Rule',
    '',
    'Match an incumbent capability only where a row in `CUSTOMER_EVIDENCE.md` asked for',
    'it. Feature parity is not a goal and is the fastest way to miss the build budget.',
    '',
  );
  return lines.join('\n');
}

// --- PRICING.md --------------------------------------------------------------

function renderPricing(ctx: SpecContext): string {
  const d = ctx.d;
  const accepted = d.waitingCompanies.filter((c) => c.priceMonthly !== null);
  const lines = [
    ...header(ctx, 'Pricing'),
    `## The price`,
    '',
    `**${priceLine(ctx)}**`,
    '',
    `${formatInt(d.counts.uniquePriceAcceptanceCompanies)} unique companies accepted this price explicitly or joined the pilot at it.`,
    '',
    '## Who accepted it',
    '',
  ];

  if (accepted.length === 0) {
    lines.push(
      'No company has a price recorded against its commitment. Check',
      '`CUSTOMER_EVIDENCE.md` before charging anything.',
      '',
    );
  } else {
    lines.push('| company | price accepted | commitment types |', '| --- | --- | --- |');
    for (const c of accepted) {
      lines.push(
        `| ${c.companyName ?? c.companyKey} | ${
          c.priceMonthly === null ? '—' : `${formatMoney(c.priceMonthly)}/month`
        } | ${c.commitmentTypes.join(', ')} |`,
      );
    }
    lines.push('');
  }

  lines.push('## Revenue arithmetic', '', '```');
  lines.push(
    ...(ctx.price === null
      ? ['no price recorded; arithmetic cannot be shown']
      : revenueMathLines(d.waitingCompanies.length, ctx.price)),
  );
  lines.push('```', '');

  lines.push(
    '## Non-negotiables',
    '',
    `- Charge ${priceLine(ctx)} from day one. No indefinite free pilot.`,
    '- Do not add a second paid tier in V1. One price, one plan.',
    '- Do not discount below the accepted price; that invalidates the validation.',
    '- Billing goes through an off-the-shelf provider. Do not hand-roll subscriptions.',
    '',
  );
  return lines.join('\n');
}

// --- REQUIREMENTS.md ---------------------------------------------------------

function renderRequirements(ctx: SpecContext): string {
  const lines = [
    ...header(ctx, 'Requirements'),
    'Every requirement cites the rows that justify it. A requirement with no source',
    'does not exist, and a V1 feature that no row supports was removed — see',
    '`NON_GOALS.md` for what was cut and why.',
    '',
    'Basis values:',
    '',
    '- `REQUESTED` — customer text asked for this in its own words.',
    '- `NEEDED_BY_CORE_WORKFLOW` — nobody named it, but it is part of the workflow',
    '  companies committed to at the displayed price.',
    '',
  ];

  if (ctx.requirements.length === 0) {
    lines.push(
      '## No requirement survived tracing',
      '',
      'Every V1 feature failed to cite a row. Do not build: re-read',
      '`CUSTOMER_EVIDENCE.md` and re-derive the wedge.',
      '',
    );
    return lines.join('\n');
  }

  lines.push(...requirementRows(ctx), '');

  for (const r of ctx.requirements) {
    lines.push(`## ${r.id} — ${r.text}`, '');
    lines.push(`- Basis: \`${r.basis}\``);
    lines.push(`- Unique companies: ${formatInt(r.companies)}`);
    lines.push(`- Why: ${r.sourceNote}`);
    if (r.matchedOn.length > 0) lines.push(`- Matched on: ${r.matchedOn.map((t) => `\`${t}\``).join(', ')}`);
    lines.push(`- Source rows: ${r.supportingRowIds.map((id) => `\`${id}\``).join(', ')}`);
    lines.push('');
  }

  lines.push(
    '## Non-negotiable constraints',
    '',
    `- Price is ${priceLine(ctx)}; do not add a second paid tier in V1.`,
    ctx.d.buildDays === null
      ? '- No build estimate was recorded. Keep it inside one week.'
      : `- The estimate that passed the gate is ${formatInt(ctx.d.buildDays)} days. If the plan exceeds it, cut scope, not quality.`,
    '- No requirement may be added that is not on this page.',
    '',
  );
  return lines.join('\n');
}

// --- NON_GOALS.md ------------------------------------------------------------

function renderNonGoals(ctx: SpecContext): string {
  const lines = [
    ...header(ctx, 'Non-goals — what V1 does not do'),
    'This page is as binding as `REQUIREMENTS.md`. Everything here was considered and',
    'deliberately left out. Adding any of it is scope creep, not initiative.',
    '',
    '## Excluded by the wedge',
    '',
  ];

  if (ctx.exclusions.length === 0) {
    lines.push('Nothing was explicitly excluded on the wedge.', '');
  } else {
    for (const exclusion of ctx.exclusions) lines.push(`- ${exclusion}`);
    lines.push('');
  }

  lines.push('## Cut for lack of evidence', '');
  if (ctx.droppedFeatures.length === 0) {
    lines.push(
      'Every proposed V1 feature cited at least one real row, so nothing was cut here.',
      '',
    );
  } else {
    lines.push(
      'These were proposed as V1 features but no commitment row, reply or recorded core',
      'workflow supported them. They are OUT of V1:',
      '',
      '| dropped feature | why it was cut |',
      '| --- | --- |',
    );
    for (const dropped of ctx.droppedFeatures) {
      lines.push(`| ${dropped.text} | ${dropped.reason} |`);
    }
    lines.push('');
  }

  lines.push(
    '## Always out of V1',
    '',
    '- A second customer type. The ICP is one segment; see `ICP.md`.',
    '- A second paid tier, usage pricing, or annual plans.',
    '- Any integration no company named in `CUSTOMER_EVIDENCE.md`.',
    '- Feature parity with the incumbent for its own sake; see `COMPETITORS.md`.',
    '- Analytics, dashboards or reporting that no requirement asks for.',
    '',
    '## How to handle a new idea',
    '',
    'Find a row in `CUSTOMER_EVIDENCE.md` that asks for it. If there is none, it belongs',
    'on this page, not in the build.',
    '',
  );
  return lines.join('\n');
}

// --- ARCHITECTURE.md ---------------------------------------------------------

function renderArchitecture(ctx: SpecContext): string {
  const d = ctx.d;
  return [
    ...header(ctx, 'Architecture — the smallest thing that satisfies V1'),
    d.buildDays === null
      ? 'No build estimate was recorded; keep the design small enough to ship in one week.'
      : `Budget: ${formatInt(d.buildDays)} days. Every decision below exists to protect that number.`,
    '',
    '## Shape',
    '',
    `- One ${d.opportunity.ecosystem} app/integration, one database, one background worker. No microservices.`,
    '- Server-rendered admin UI. No SPA unless a requirement genuinely requires one.',
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
    '## What each requirement needs from the architecture',
    '',
    ...(ctx.requirements.length === 0
      ? ['No traced requirement; nothing to design for yet.']
      : ctx.requirements.map((r) => `- **${r.id}** (${r.basis}) — ${r.text}`)),
    '',
    '## Integration notes',
    '',
    d.wedge.primaryCompetitor
      ? `- The incumbent is ${d.wedge.primaryCompetitor}. Match its data model only where a customer asked for it.`
      : '- No primary competitor was recorded.',
    `- Core workflow to support end to end: ${d.wedge.coreWorkflow ?? 'see REQUIREMENTS.md'}`,
    '- Platform capability status is in `API_FEASIBILITY.md`. Read it before designing around an API.',
    '',
    '## Explicit non-goals',
    '',
    'See `NON_GOALS.md`. Nothing on that page gets a table, a column or an endpoint.',
    '',
  ].join('\n');
}

// --- API_FEASIBILITY.md ------------------------------------------------------

function renderApiFeasibility(ctx: SpecContext): string {
  const f = ctx.feasibility;
  const lines = [
    ...header(ctx, 'API feasibility — what was verified, and what was not'),
    'A capability listed as UNVERIFIED is not the same as one that works. It means',
    'nothing contradicted it and nobody checked. Verify before designing around it.',
    '',
    f.checkedAt === null
      ? '**No feasibility revalidation has been recorded for this opportunity.** Treat every capability below as unverified.'
      : `Last revalidated: ${f.checkedAt.toISOString()} · verdict: ${
          f.feasible === null ? 'not recorded' : f.feasible ? 'FEASIBLE' : 'NOT FEASIBLE'
        }`,
    '',
    '## Checks',
    '',
  ];

  if (f.checks.length === 0) {
    lines.push(
      'No individual checks were recorded. The notification path runs feasibility',
      'revalidation immediately before the owner is told to build, so an empty list',
      'here means the spec was generated before that ran.',
      '',
    );
  } else {
    lines.push('| check | result | detail | source |', '| --- | --- | --- | --- |');
    for (const c of f.checks) {
      lines.push(
        `| \`${c.name}\` | ${c.passed ? 'PASS' : 'FAIL'} | ${c.detail || '—'} | ${c.sourceUrl ?? '—'} |`,
      );
    }
    lines.push('');
  }

  const section = (title: string, items: string[], empty: string): void => {
    lines.push(`## ${title}`, '');
    if (items.length === 0) lines.push(empty, '');
    else {
      for (const item of items) lines.push(`- ${item}`);
      lines.push('');
    }
  };

  section(
    'Verified capabilities',
    f.verifiedCapabilities,
    'None were positively confirmed against platform documentation or a spike.',
  );
  section(
    'Unverified capabilities',
    f.unverifiedCapabilities,
    'Nothing is outstanding — or nothing was recorded. Check the date above.',
  );
  section(
    'Missing capabilities',
    f.missingCapabilities,
    'No capability was recorded as missing. Nothing is known to be impossible.',
  );

  lines.push(
    '## Rule for the build session',
    '',
    '1. Before writing an integration, confirm the capability is listed as verified.',
    '2. If it is unverified, spike it FIRST, in an afternoon, before building on it.',
    '3. If it turns out to be missing, stop and report it. Do not work around a missing',
    '   platform capability by expanding scope.',
    '',
  );
  return lines.join('\n');
}

// --- ACCEPTANCE_TESTS.md -----------------------------------------------------

function renderAcceptanceTests(ctx: SpecContext): string {
  const lines = [
    ...header(ctx, 'Acceptance tests'),
    'V1 is done when every test below passes. Not before, and not after adding more.',
    '',
  ];

  if (ctx.requirements.length === 0) {
    lines.push(
      'No traced requirement, so there is no acceptance set. Do not build.',
      '',
    );
  }

  ctx.requirements.forEach((r, i) => {
    lines.push(`## AT-${i + 1} — ${r.id}`, '');
    lines.push(`**Requirement:** ${r.text}`);
    lines.push(`**Basis:** \`${r.basis}\` — ${r.sourceNote}`);
    lines.push(`**Source rows:** ${r.supportingRowIds.map((id) => `\`${id}\``).join(', ')}`);
    lines.push('');
    lines.push(`- **Given** a ${ctx.icp} account with the product installed`);
    lines.push(`- **When** the operator performs the workflow that exercises: ${r.text}`);
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
    '- **When** its surface is reviewed against `REQUIREMENTS.md` and `NON_GOALS.md`',
    '- **Then** nothing exists that is listed as a non-goal',
    '',
  );
  return lines.join('\n');
}

// --- LAUNCH_PLAN.md ----------------------------------------------------------

function renderLaunchPlan(ctx: SpecContext): string {
  const d = ctx.d;
  const waiting = d.waitingCompanies;
  return [
    ...header(ctx, 'Launch plan'),
    `${formatInt(waiting.length)} ${waiting.length === 1 ? 'company' : 'companies'} already committed during validation. They are the launch list; the contact detail is in \`WAITING_CUSTOMERS.md\`.`,
    '',
    '## Sequence',
    '',
    '1. Ship V1 to a private URL and invite the committed companies first.',
    '2. Onboard them one at a time; watch the core workflow end to end for each.',
    `3. Charge ${priceLine(ctx)} from day one. No indefinite free pilot.`,
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
    `The qualified list behind this campaign holds ${formatInt(d.counts.qualifiedProspects)} businesses, so there is somewhere to go after the committed companies are live.`,
    '',
    '## What would falsify this',
    '',
    '- A committed company declines to onboard when the product is real.',
    '- The core workflow needs data the platform will not give us (see `API_FEASIBILITY.md`).',
    '- Nobody converts to a paid plan after onboarding.',
    '',
    'Any of those means stop, write down which one, and do not build more features.',
    '',
  ].join('\n');
}

// --- WAITING_CUSTOMERS.md ----------------------------------------------------

function renderWaitingCustomers(ctx: SpecContext): string {
  const d = ctx.d;
  const lines = [
    ...header(ctx, 'Waiting customers — who to contact on day one'),
    'These are real businesses that committed during validation. Every row is a',
    '`commitments` row; nothing here is a lead list or a guess.',
    '',
  ];

  if (d.waitingCompanies.length === 0) {
    lines.push(
      '## Nobody is waiting',
      '',
      'No company has committed. An opportunity in this state should not have passed the',
      'gate — re-read `README.md` for the gate result before building anything.',
      '',
    );
    return lines.join('\n');
  }

  lines.push(...companyTable(ctx), '');
  lines.push(
    `Unique companies with a strong commitment: ${formatInt(d.counts.uniqueStrongCommitmentCompanies)}.`,
    `Unique companies that accepted the price: ${formatInt(d.counts.uniquePriceAcceptanceCompanies)}.`,
    `Unique companies that acted beyond conversation: ${formatInt(d.counts.uniqueActionCommitmentCompanies)}.`,
    '',
    '## What each of them said',
    '',
  );

  if (ctx.quotableEvidence.length === 0) {
    lines.push('No quotable row survived the claim-language filter; see `CUSTOMER_EVIDENCE.md`.', '');
  } else {
    for (const item of ctx.quotableEvidence) lines.push(...quoteBlock(item));
    lines.push('');
  }

  lines.push(
    '## Contact rules',
    '',
    '- These companies opted in. Reach out directly, referencing what they asked for.',
    '- Honour the suppression list: anyone who opted out is not on this page and must',
    '  not be contacted again.',
    '- Do not bulk-mail this list. Onboard one company at a time.',
    '',
  );
  return lines.join('\n');
}
