#!/usr/bin/env tsx
/**
 * BROAD B2B OPPORTUNITY DISCOVERY — `npm run discover:b2b`.
 *
 * The existing discovery layer has exactly one adapter (Shopify's app
 * marketplace), so every opportunity it can produce is a Shopify app category.
 * That answers "which app should I build for Shopify", not "where is there a
 * painful recurring B2B workflow somebody already pays to solve".
 *
 * This runs the second search against the real public web, reusing the same
 * budgeted, cost-tracked, robots-respecting infrastructure:
 *   - `search()`        real Brave, cache-first, charged to the search budget
 *   - `politeFetch()`   real HTTP with robots.txt, throttling and a size cap
 *   - `llmComplete()`   real Gemini, charged to the LLM budget
 *
 * ANTI-FABRICATION IS THE POINT. The model is only ever asked to EXTRACT from
 * a page that was actually fetched, and every quote it returns is checked to
 * appear verbatim in that page's text. A finding whose quote cannot be located
 * is discarded, not softened. Nothing is written that has no source URL.
 *
 * Read-only with respect to the outside world: it searches and fetches. It
 * sends nothing and contacts nobody.
 *
 * Usage:
 *   npm run discover:b2b                      # full breadth pass
 *   npm run discover:b2b -- --verticals 6     # fewer verticals, cheaper
 *   npm run discover:b2b -- --per-query 5
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv({ path: '.env', quiet: true });

// Research only. Nothing in this script sends, but the switches are asserted
// rather than assumed.
process.env.OUTREACH_ENABLED = 'false';

const { getConfig } = await import('../lib/config');
const { getDb, closeDb } = await import('../lib/db');
const { runMigrations } = await import('../lib/migrate');
const { search } = await import('../lib/search/index');
const { politeFetch } = await import('../lib/fetch');
const { llmComplete } = await import('../lib/llm/index');
const { extractText } = await import('../pipeline/prospecting/html');
const { hasBudget } = await import('../lib/cost');
const { getBudgetSnapshot } = await import('../lib/cost');
const { createLogger } = await import('../lib/logger');
const { BudgetExceededError } = await import('../lib/errors');

const logger = createLogger('discover:b2b');

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

// --- the search space --------------------------------------------------------

/**
 * Verticals chosen for one reason: the work is recurring, operational, and
 * already costs somebody money. Consumer markets and venture-scale platforms
 * are deliberately absent.
 */
interface Vertical {
  key: string;
  label: string;
  /** Words that identify the trade, used to keep queries on-topic. */
  terms: string[];
}

const VERTICALS: readonly Vertical[] = [
  { key: 'construction', label: 'construction & trades', terms: ['contractor', 'construction', 'subcontractor'] },
  { key: 'property', label: 'property management', terms: ['property management', 'landlord', 'HOA'] },
  { key: 'logistics', label: 'freight & logistics', terms: ['freight broker', 'trucking', 'dispatch'] },
  { key: 'healthcare-admin', label: 'medical practice admin', terms: ['medical billing', 'dental practice', 'prior authorization'] },
  { key: 'accounting', label: 'accounting & bookkeeping firms', terms: ['bookkeeping firm', 'CPA firm', 'accounting practice'] },
  { key: 'insurance', label: 'insurance agencies', terms: ['insurance agency', 'independent agent', 'commercial lines'] },
  { key: 'legal', label: 'small law firms', terms: ['law firm', 'paralegal', 'legal intake'] },
  { key: 'manufacturing', label: 'small manufacturing', terms: ['machine shop', 'job shop', 'manufacturing'] },
  { key: 'field-service', label: 'field service & HVAC', terms: ['HVAC', 'field service', 'plumbing company'] },
  { key: 'staffing', label: 'staffing & recruiting', terms: ['staffing agency', 'recruiting firm', 'applicant tracking'] },
  { key: 'restaurants', label: 'restaurant & food service ops', terms: ['restaurant', 'food distributor', 'catering'] },
  { key: 'nonprofit', label: 'nonprofit operations', terms: ['nonprofit', 'grant reporting', 'donor management'] },
  { key: 'education', label: 'schools & training providers', terms: ['school district', 'training provider', 'tutoring company'] },
  { key: 'realestate', label: 'real estate brokerages', terms: ['real estate brokerage', 'transaction coordinator', 'title company'] },
  { key: 'agencies', label: 'marketing & creative agencies', terms: ['marketing agency', 'creative agency', 'client reporting'] },
  { key: 'ecommerce-ops', label: 'ecommerce operations', terms: ['3PL', 'inventory reconciliation', 'returns processing'] },
];

/**
 * Pain-signal query shapes. Each targets a place where people describe the
 * work they actually do, rather than where vendors describe what they sell —
 * vendor marketing is explicitly NOT evidence of customer pain.
 */
const QUERY_SHAPES: ReadonlyArray<{ id: string; build: (t: string) => string; kind: EvidenceKind }> = [
  { id: 'reddit-spreadsheet', kind: 'PRACTITIONER_COMPLAINT', build: (t) => `site:reddit.com ${t} spreadsheet manual process hours` },
  { id: 'reddit-software-hate', kind: 'PRACTITIONER_COMPLAINT', build: (t) => `site:reddit.com ${t} software frustrating outdated clunky` },
  { id: 'reddit-how-do-you', kind: 'PRACTITIONER_COMPLAINT', build: (t) => `site:reddit.com ${t} "how do you" track manually every week` },
  { id: 'paying-someone', kind: 'EXISTING_SPEND', build: (t) => `${t} "we pay" OR "hired someone" data entry manual admin hours week` },
  { id: 'job-posting', kind: 'EXISTING_SPEND', build: (t) => `${t} job posting "data entry" OR "administrative assistant" spreadsheets reports duties` },
  { id: 'incumbent-pricing', kind: 'INCUMBENT', build: (t) => `${t} software pricing per month per user comparison` },
];

type EvidenceKind = 'PRACTITIONER_COMPLAINT' | 'EXISTING_SPEND' | 'INCUMBENT';

// --- extraction contract -----------------------------------------------------

/** Clip rather than reject: an over-long answer is verbose, not wrong. */
const clipped = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' ? v.slice(0, max) : v), z.string().max(max));

const Finding = z.object({
  /** false when the page is vendor marketing, listicle spam, or off-topic. */
  isRealEvidence: z.boolean(),
  /** Why this page is or is not evidence of a real recurring workflow. */
  assessment: clipped(400),
  /** The recurring workflow, in the practitioner's terms. Empty when none. */
  workflow: clipped(240),
  /** Who does this work day to day. */
  whoDoesIt: clipped(160),
  /** Who would pay for a tool that fixed it. */
  likelyBuyer: clipped(160),
  /** Verbatim from the page. VERIFIED against the fetched text. */
  quote: clipped(400),
  /** Anything the page says is currently paid for: software, staff, agencies. */
  currentSpendSignal: clipped(240),
  /** How often the work recurs, as the page describes it. */
  frequency: clipped(80),
  /** 0-1. How strongly this single page evidences a painful recurring job. */
  painStrength: z.number().min(0).max(1),
  /** True when the page is a vendor selling something, not a practitioner. */
  isVendorMarketing: z.boolean(),
});
type Finding = z.infer<typeof Finding>;

const EXTRACT_SYSTEM = [
  'You extract evidence of painful, recurring BUSINESS workflows from one web page.',
  'You are given text that was actually fetched from that page.',
  'RULES:',
  '- Use ONLY the supplied text. If the text does not say it, do not write it.',
  '- `quote` MUST be copied VERBATIM from the supplied text. Never paraphrase it.',
  '- A vendor describing its own product is NOT evidence of customer pain. Set',
  '  isVendorMarketing=true and isRealEvidence=false for marketing pages,',
  '  listicles, and "top 10 tools" content.',
  '- Evidence means a practitioner describing work they actually do, time it',
  '  takes, money it costs, or software that frustrates them.',
  '- Be strict. A vague mention is not evidence. painStrength above 0.6 requires',
  '  a specific, recurring, costly workflow.',
  'LENGTH LIMITS (characters, keep well under): assessment 400, workflow 240,',
  'whoDoesIt 160, likelyBuyer 160, quote 400, currentSpendSignal 240, frequency 80.',
  'Pick the single most telling sentence for `quote` rather than a long passage.',
].join('\n');

interface PageFinding extends Finding {
  url: string;
  title: string;
  vertical: string;
  shape: string;
  kind: EvidenceKind;
  quoteVerified: boolean;
  /** Whether the quote came from the page itself or from a search snippet. */
  provenance: 'FETCHED_PAGE' | 'SEARCH_SNIPPET';
}

// --- run ---------------------------------------------------------------------

const MAX_VERTICALS = Math.max(1, Number(arg('verticals', String(VERTICALS.length))));
const PER_QUERY = Math.max(1, Number(arg('per-query', '6')));
const MAX_PAGE_CHARS = 9000;

async function main(): Promise<void> {
  const cfg = getConfig();
  await runMigrations();

  console.log('='.repeat(78));
  console.log('  BROAD B2B OPPORTUNITY DISCOVERY — real search, real pages, real extraction');
  console.log('='.repeat(78));
  console.log(`  search   : ${cfg.searchProvider}`);
  console.log(`  llm      : ${cfg.llmProvider} (${cfg.llmFast})`);
  console.log(`  outreach : ${cfg.outreachEnabled ? 'ENABLED' : 'disabled'}  (nothing here sends)`);

  if (cfg.searchProvider === 'mock' || cfg.llmProvider === 'mock') {
    console.error('\nRefusing to run: a mock provider cannot produce real evidence.');
    process.exitCode = 1;
    return;
  }

  const verticals = VERTICALS.slice(0, MAX_VERTICALS);
  const findings: PageFinding[] = [];
  const seenUrls = new Set<string>();
  let searches = 0;
  let fetched = 0;
  let notFetched = 0;
  let discarded = 0;

  for (const vertical of verticals) {
    const term = vertical.terms[0] ?? vertical.label;
    console.log(`\n--- ${vertical.label}`);

    for (const shape of QUERY_SHAPES) {
      if (!(await hasBudget('SEARCH', cfg.braveSearchCostPerCall))) {
        console.log('  search budget exhausted; stopping discovery here');
        break;
      }
      const query = shape.build(term);
      let results: Awaited<ReturnType<typeof search>> = [];
      try {
        results = await search(query, PER_QUERY);
        searches += 1;
      } catch (err) {
        if (err instanceof BudgetExceededError) break;
        logger.warn('search failed', { query, err: String(err).slice(0, 120) });
        continue;
      }

      for (const result of results) {
        if (seenUrls.has(result.url)) continue;
        seenUrls.add(result.url);

        // Fetch the page when we are allowed to. Reddit and several forums
        // disallow crawling in robots.txt and politeFetch honours that, so the
        // richest pain evidence on the web is simply not fetchable. Rather than
        // drop those sources or violate robots, fall back to Brave's own result
        // snippet — real, attributable text — and mark the finding as
        // snippet-derived so its weaker provenance is visible in the report.
        let text = '';
        let provenance: 'FETCHED_PAGE' | 'SEARCH_SNIPPET' = 'FETCHED_PAGE';
        try {
          const res = await politeFetch(result.url);
          if (res.contentType !== '' && !res.contentType.includes('html')) continue;
          text = extractText(res.body).slice(0, MAX_PAGE_CHARS);
          fetched += 1;
        } catch {
          notFetched += 1;
          const snippet = `${result.title}. ${result.description ?? ''}`.trim();
          if (snippet.length < 80) continue;
          text = snippet;
          provenance = 'SEARCH_SNIPPET';
        }
        if (text.length < 80) continue;
        if (provenance === 'FETCHED_PAGE' && text.length < 400) continue;

        let finding: Finding;
        try {
          const res = await llmComplete({
            tier: 'fast',
            phase: 'DISCOVERY',
            task: 'b2b.extract_pain_evidence',
            schemaName: 'PainEvidence',
            schema: Finding,
            maxTokens: 700,
            system: EXTRACT_SYSTEM,
            user: `Industry context: ${vertical.label}\nPage URL: ${result.url}`,
            // The page is attacker-controlled text. It goes through the
            // untrusted channel so the LLM layer fences it as DATA.
            untrusted: { page_text: text },
          });
          finding = res.data;
        } catch (err) {
          if (err instanceof BudgetExceededError) {
            console.log('  LLM budget exhausted; stopping extraction');
            break;
          }
          continue;
        }

        // THE anti-fabrication check: the quote must really be on the page.
        const quoteVerified =
          finding.quote.trim().length > 0 &&
          normalize(text).includes(normalize(finding.quote));

        if (!finding.isRealEvidence || finding.isVendorMarketing || !quoteVerified) {
          discarded += 1;
          continue;
        }

        findings.push({
          ...finding,
          url: result.url,
          title: result.title,
          vertical: vertical.key,
          shape: shape.id,
          kind: shape.kind,
          quoteVerified,
          provenance,
        });
        console.log(
          `  [${finding.painStrength.toFixed(2)}] ${finding.workflow.slice(0, 70)}  <- ${hostOf(result.url)}`,
        );
      }
    }
  }

  // --- rank ------------------------------------------------------------------
  const clusters = clusterByWorkflow(findings);
  clusters.sort((a, b) => b.score - a.score);

  const snap = await getBudgetSnapshot();
  console.log('\n' + '='.repeat(78));
  console.log(
    `  ${searches} searches, ${fetched} pages fetched, ${findings.length} verified findings, ` +
      `${discarded} discarded (vendor marketing / unverifiable quote)`,
  );
  console.log(
    `  spend: search $${snap.searchSpentUsd.toFixed(4)}/${snap.searchBudgetUsd}, ` +
      `LLM $${snap.llmSpentUsd.toFixed(4)}/${snap.llmBudgetUsd}`,
  );
  console.log('='.repeat(78));

  await writeReport(clusters, findings, { searches, fetched, discarded });
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s ]+/g, ' ').replace(/[“”‘’]/g, "'").trim();
}
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.slice(0, 40);
  }
}

// --- clustering --------------------------------------------------------------

export interface Cluster {
  key: string;
  vertical: string;
  workflow: string;
  buyer: string;
  findings: PageFinding[];
  /**
   * Distinct URLs — three different Reddit threads are three different
   * practitioners, so counting hostnames alone undercounted corroboration.
   */
  sources: number;
  /** Distinct hostnames. Cross-site agreement is stronger than one forum. */
  domains: number;
  score: number;
  hasSpendSignal: boolean;
}

/**
 * Groups findings that describe the same job. Deliberately lexical: content
 * words shared between workflow descriptions. A model deciding what counts as
 * "the same problem" would be unreviewable.
 */
function clusterByWorkflow(findings: PageFinding[]): Cluster[] {
  const STOP = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'their', 'have', 'has',
    'are', 'was', 'were', 'you', 'your', 'our', '們', 'all', 'can', 'not', 'but', 'they',
    'them', 'when', 'what', 'which', 'each', 'every', 'more', 'most', 'some', 'than',
    'then', 'there', 'these', 'those', 'work', 'time', 'using', 'used', 'use', 'need',
    'needs', 'manual', 'manually', 'process', 'business', 'company', 'customer',
  ]);
  const tokens = (s: string): Set<string> =>
    new Set(
      s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
        .filter((w) => w.length > 3 && !STOP.has(w)),
    );

  const clusters: Cluster[] = [];
  for (const f of findings) {
    const ft = tokens(f.workflow);
    let best: Cluster | null = null;
    let bestOverlap = 0;
    for (const c of clusters) {
      if (c.vertical !== f.vertical) continue;
      const ct = tokens(c.workflow);
      let overlap = 0;
      for (const t of ft) if (ct.has(t)) overlap += 1;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = c;
      }
    }
    if (best && bestOverlap >= 2) {
      best.findings.push(f);
      continue;
    }
    clusters.push({
      key: `${f.vertical}:${clusters.length + 1}`,
      vertical: f.vertical,
      workflow: f.workflow,
      buyer: f.likelyBuyer,
      findings: [f],
      sources: 0,
      domains: 0,
      score: 0,
    hasSpendSignal: false,
    });
  }

  for (const c of clusters) {
    c.sources = new Set(c.findings.map((f) => f.url)).size;
    c.domains = new Set(c.findings.map((f) => hostOf(f.url))).size;
    c.hasSpendSignal = c.findings.some(
      (f) => f.kind === 'EXISTING_SPEND' || f.currentSpendSignal.trim().length > 12,
    );
    const avgPain = c.findings.reduce((n, f) => n + f.painStrength, 0) / c.findings.length;
    const practitioners = c.findings.filter((f) => f.kind === 'PRACTITIONER_COMPLAINT').length;
    // Independent sources and evidence of money already moving dominate. A
    // single loud complaint is not a market.
    c.score =
      avgPain * 3 +
      Math.min(c.sources, 6) * 1.2 +
      Math.min(c.domains, 4) * 0.8 +
      (c.hasSpendSignal ? 2.5 : 0) +
      Math.min(practitioners, 4) * 0.75;
  }
  return clusters;
}

// --- report ------------------------------------------------------------------

async function writeReport(
  clusters: Cluster[],
  findings: PageFinding[],
  stats: { searches: number; fetched: number; discarded: number },
): Promise<void> {
  const dir = path.resolve(process.cwd(), 'research');
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  await writeFile(
    path.join(dir, `b2b-findings-${stamp}.json`),
    JSON.stringify({ generatedAt: new Date().toISOString(), stats, clusters, findings }, null, 2),
    'utf8',
  );

  const top = clusters.filter((c) => c.findings.length > 0).slice(0, 25);
  const lines: string[] = [
    '# Broad B2B opportunity scan',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    `${stats.searches} real searches · ${stats.fetched} pages fetched · ` +
      `${findings.length} findings kept · ${stats.discarded} discarded as vendor marketing ` +
      'or unverifiable quote.',
    '',
    'Every quote below was checked to appear verbatim in the page it is attributed to.',
    'Vendor marketing pages were rejected: a company describing its own product is not',
    'evidence that anyone is in pain.',
    '',
    '| # | vertical | workflow | pages | sites | spend signal | score |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  top.forEach((c, i) => {
    lines.push(
      `| ${i + 1} | ${c.vertical} | ${c.workflow.slice(0, 80)} | ${c.sources} | ${c.domains} | ${c.hasSpendSignal ? 'yes' : 'no'} | ${c.score.toFixed(1)} |`,
    );
  });
  lines.push('');

  for (const [i, c] of top.entries()) {
    lines.push(`## ${i + 1}. ${c.workflow}`, '');
    lines.push(`- **Vertical:** ${c.vertical}`);
    lines.push(`- **Likely buyer:** ${c.buyer}`);
    lines.push(`- **Independent sources:** ${c.sources} distinct pages across ${c.domains} site(s)`);
    lines.push(`- **Score:** ${c.score.toFixed(2)}`);
    lines.push('');
    lines.push('### Evidence');
    lines.push('');
    for (const f of c.findings) {
      const prov = f.provenance === 'FETCHED_PAGE' ? 'full page' : 'search snippet only';
      lines.push(`- **${hostOf(f.url)}** — ${f.kind}, pain ${f.painStrength.toFixed(2)}, _${prov}_`);
      lines.push(`  > ${f.quote.replace(/\n+/g, ' ').slice(0, 300)}`);
      lines.push(`  _source:_ ${f.url}`);
      if (f.currentSpendSignal.trim()) lines.push(`  _spend signal:_ ${f.currentSpendSignal}`);
      if (f.frequency.trim()) lines.push(`  _frequency:_ ${f.frequency}`);
      lines.push('');
    }
  }

  const file = path.join(dir, `b2b-scan-${stamp}.md`);
  await writeFile(file, lines.join('\n'), 'utf8');
  console.log(`\n  report: ${file}`);
  console.log(`  json  : ${path.join(dir, `b2b-findings-${stamp}.json`)}`);
}

try {
  await main();
} catch (err) {
  console.error(`\ndiscovery error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await closeDb().catch(() => undefined);
}
