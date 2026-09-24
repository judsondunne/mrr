#!/usr/bin/env tsx
/**
 * DEEP DIVE ON THE STRONGEST OPPORTUNITIES — `npm run deep:dive`.
 *
 * Takes the ranked clusters produced by `npm run discover:b2b` and, for the
 * top N, answers the questions that decide whether something is worth building:
 * who already sells into this, what they charge, what their customers complain
 * about, and which real companies have the problem.
 *
 * Same rules as discovery, for the same reason:
 *   - real Brave search, real polite fetching, real Gemini extraction
 *   - every claim carries a source URL
 *   - incumbent PRICING is only recorded when a price string is found on a
 *     fetched page; a model's recollection of what a product costs is not a
 *     price
 *   - vendor marketing is recorded as vendor marketing, never as customer pain
 *
 * It contacts nobody. Prospect discovery reads public pages only and records a
 * contact PATH (a public address or contact page), which a human can act on.
 *
 * Usage: npm run deep:dive [-- --top 5 --prospects 20]
 */
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv({ path: '.env', quiet: true });
process.env.OUTREACH_ENABLED = 'false';

const { getConfig } = await import('../lib/config');
const { closeDb } = await import('../lib/db');
const { runMigrations } = await import('../lib/migrate');
const { search } = await import('../lib/search/index');
const { politeFetch } = await import('../lib/fetch');
const { llmComplete } = await import('../lib/llm/index');
const { extractText } = await import('../pipeline/prospecting/html');
const { extractMonthlyPrices } = await import('../pipeline/discovery/parse');
const { findPublicContact } = await import('../pipeline/prospecting/contact');
const { normalizeDomain, isDisallowedProspectDomain } = await import('../pipeline/prospecting/domain');
const { hasBudget, getBudgetSnapshot } = await import('../lib/cost');
const { BudgetExceededError } = await import('../lib/errors');

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const TOP = Math.max(1, Number(arg('top', '5')));
const PROSPECT_TARGET = Math.max(1, Number(arg('prospects', '20')));

const clip = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' ? v.slice(0, max) : v), z.string().max(max));

// --- what we extract ---------------------------------------------------------

const Incumbent = z.object({
  isProductPage: z.boolean(),
  productName: clip(120),
  whatItDoes: clip(300),
  /** Copied verbatim from the page. Verified. Empty when the page shows none. */
  pricingText: clip(200),
  targetCustomer: clip(160),
  /** Weaknesses the PAGE itself reveals (missing features, enterprise-only). */
  apparentWeakness: clip(300),
});

const Complaint = z.object({
  isCustomerComplaint: z.boolean(),
  aboutProduct: clip(120),
  complaint: clip(300),
  quote: clip(400),
  severity: z.number().min(0).max(1),
});

const ProspectFit = z.object({
  isRealOperatingBusiness: z.boolean(),
  companyName: clip(120),
  whatTheyDo: clip(200),
  /**
   * Verbatim from the page, describing what the business DOES — its services,
   * scale, or market. Not its pain: no company advertises the workflow that
   * hurts, so requiring that as proof rejected every real prospect.
   */
  workflowEvidence: clip(300),
  /**
   * Why a business of this type would perform the workflow. Clearly an
   * INFERENCE, kept separate from the verbatim evidence above so the report
   * never presents reasoning as observation.
   */
  workflowInference: clip(240),
  fitsIcp: z.boolean(),
  approximateSize: clip(80),
  roleToContact: clip(80),
  personalizationHook: clip(240),
});

interface Cluster {
  key: string;
  vertical: string;
  workflow: string;
  buyer: string;
  sources: number;
  domains: number;
  score: number;
  hasSpendSignal: boolean;
  findings: Array<{ url: string; quote: string; currentSpendSignal: string; painStrength: number }>;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.slice(0, 40);
  }
}
const norm = (s: string): string => s.toLowerCase().replace(/[\s ]+/g, ' ').replace(/[""'']/g, "'").trim();

async function fetchText(url: string, cap = 9000): Promise<string | null> {
  try {
    const res = await politeFetch(url);
    if (res.contentType !== '' && !res.contentType.includes('html')) return null;
    const text = extractText(res.body).slice(0, cap);
    return text.length > 200 ? text : null;
  } catch {
    return null;
  }
}

// --- main --------------------------------------------------------------------

async function main(): Promise<void> {
  const cfg = getConfig();
  await runMigrations();
  if (cfg.searchProvider === 'mock' || cfg.llmProvider === 'mock') {
    console.error('Refusing to run against mock providers.');
    process.exitCode = 1;
    return;
  }

  const dir = path.resolve(process.cwd(), 'research');
  const files = (await readdir(dir)).filter((f) => f.startsWith('b2b-findings-')).sort();
  const latest = files[files.length - 1];
  if (!latest) {
    console.error('No discovery output found. Run: npm run discover:b2b');
    process.exitCode = 1;
    return;
  }
  const parsed = JSON.parse(await readFile(path.join(dir, latest), 'utf8')) as { clusters: Cluster[] };
  const clusters = parsed.clusters.filter((c) => c.findings.length >= 2).slice(0, TOP);

  console.log('='.repeat(78));
  console.log(`  DEEP DIVE — top ${clusters.length} opportunities from ${latest}`);
  console.log('='.repeat(78));

  const dossiers: unknown[] = [];

  for (const [idx, cluster] of clusters.entries()) {
    console.log(`\n### ${idx + 1}. [${cluster.vertical}] ${cluster.workflow.slice(0, 80)}`);
    const topic = `${cluster.vertical} ${cluster.workflow}`.slice(0, 120);

    // --- incumbents and their real prices ---------------------------------
    const incumbents: Array<z.infer<typeof Incumbent> & { url: string; priceFound: string[] }> = [];
    for (const q of [
      `${cluster.vertical} software ${keyNoun(cluster.workflow)} pricing`,
      `best ${keyNoun(cluster.workflow)} software for ${cluster.vertical} price per month`,
    ]) {
      if (!(await hasBudget('SEARCH', cfg.braveSearchCostPerCall))) break;
      let results: Awaited<ReturnType<typeof search>> = [];
      try {
        results = await search(q, 5);
      } catch (err) {
        if (err instanceof BudgetExceededError) break;
        continue;
      }
      for (const r of results.slice(0, 4)) {
        if (incumbents.length >= 6) break;
        const text = await fetchText(r.url);
        if (!text) continue;
        try {
          const res = await llmComplete({
            tier: 'fast',
            phase: 'RESEARCH',
            task: 'deep.incumbent',
            schemaName: 'Incumbent',
            schema: Incumbent,
            maxTokens: 600,
            system:
              'You describe ONE software product from its own page. Use only the supplied text. ' +
              'pricingText must be copied VERBATIM from the text, or left empty if no price appears. ' +
              'Never state a price you were not shown.',
            user: `Page URL: ${r.url}`,
            untrusted: { page_text: text },
          });
          if (!res.data.isProductPage) continue;
          // A price is only a price if it is on the page we fetched.
          const priceVerified =
            res.data.pricingText.trim() !== '' && norm(text).includes(norm(res.data.pricingText));
          incumbents.push({
            ...res.data,
            pricingText: priceVerified ? res.data.pricingText : '',
            // extractMonthlyPrices returns {amount, raw}; render the matched text.
            priceFound: extractMonthlyPrices(text).slice(0, 4).map((m) => m.raw),
            url: r.url,
          });
          console.log(`   incumbent: ${res.data.productName.slice(0, 40)} ${priceVerified ? `(${res.data.pricingText.slice(0, 40)})` : '(no price on page)'}`);
        } catch (err) {
          if (err instanceof BudgetExceededError) break;
        }
      }
    }

    // --- what customers say about them ------------------------------------
    const complaints: Array<z.infer<typeof Complaint> & { url: string }> = [];
    const names = incumbents.map((i) => i.productName).filter((n) => n.length > 2).slice(0, 3);
    for (const name of names.length > 0 ? names : [keyNoun(cluster.workflow)]) {
      if (!(await hasBudget('SEARCH', cfg.braveSearchCostPerCall))) break;
      let results: Awaited<ReturnType<typeof search>> = [];
      try {
        results = await search(`"${name}" review complaints expensive frustrating alternative`, 5);
      } catch {
        continue;
      }
      for (const r of results.slice(0, 3)) {
        const page = await fetchText(r.url, 7000);
        const text = page ?? `${r.title}. ${r.description ?? ''}`;
        if (text.length < 80) continue;
        try {
          const res = await llmComplete({
            tier: 'fast',
            phase: 'RESEARCH',
            task: 'deep.complaint',
            schemaName: 'Complaint',
            schema: Complaint,
            maxTokens: 500,
            system:
              'Extract ONE customer complaint about a software product from the supplied text. ' +
              'quote must be copied VERBATIM. A vendor praising itself is not a complaint: ' +
              'set isCustomerComplaint=false. Use only the supplied text.',
            user: `Product under discussion: ${name}\nPage URL: ${r.url}`,
            untrusted: { page_text: text },
          });
          if (!res.data.isCustomerComplaint) continue;
          if (!norm(text).includes(norm(res.data.quote))) continue; // unverifiable
          complaints.push({ ...res.data, url: r.url });
          console.log(`   complaint: ${res.data.complaint.slice(0, 60)}`);
        } catch {
          /* budget or transient: move on */
        }
      }
    }

    // --- real companies with the problem ----------------------------------
    const prospects: Array<z.infer<typeof ProspectFit> & { url: string; domain: string; contact: string | null }> = [];
    const seen = new Set<string>();
    for (const q of prospectQueries(cluster)) {
      if (prospects.length >= PROSPECT_TARGET) break;
      if (!(await hasBudget('SEARCH', cfg.braveSearchCostPerCall))) break;
      let results: Awaited<ReturnType<typeof search>> = [];
      try {
        results = await search(q, 10);
      } catch {
        continue;
      }
      for (const r of results) {
        if (prospects.length >= PROSPECT_TARGET) break;
        const domain = normalizeDomain(r.url);
        if (!domain || isDisallowedProspectDomain(domain) || seen.has(domain)) continue;
        seen.add(domain);

        const text = await fetchText(`https://${domain}/`, 8000);
        if (!text) continue;
        try {
          const res = await llmComplete({
            tier: 'fast',
            phase: 'PROSPECTING',
            task: 'deep.prospect_fit',
            schemaName: 'ProspectFit',
            schema: ProspectFit,
            maxTokens: 600,
            system: [
              'Decide whether ONE business matches a described customer profile, from its own public page.',
              'Use only the supplied text.',
              'fitsIcp = is this a real operating business of the target type? Do NOT require the page',
              'to mention the painful workflow — businesses advertise services, not their internal pain.',
              'workflowEvidence must be copied VERBATIM from the text and should show what the business',
              'DOES (its services, scale, or market).',
              'workflowInference is your reasoning for why this type of business would perform the',
              'workflow. Keep it clearly separate from the quote.',
              'A software vendor selling TO this audience, a directory, or a listicle is NOT a match.',
            ].join('\n'),
            user: `Target customer: ${cluster.buyer}\nWorkflow they should perform: ${cluster.workflow}\nPage URL: https://${domain}/`,
            untrusted: { page_text: text },
          });
          if (!res.data.isRealOperatingBusiness || !res.data.fitsIcp) continue;
          if (!norm(text).includes(norm(res.data.workflowEvidence))) continue;

          let contactPath: string | null = null;
          try {
            const found = await findPublicContact({ domain, seedUrls: [], prefetched: [], maxPages: 2 });
            contactPath = found ? `${found.email} (published at ${found.sourceUrl})` : null;
          } catch {
            contactPath = null;
          }
          prospects.push({ ...res.data, url: `https://${domain}/`, domain, contact: contactPath });
          console.log(`   prospect: ${res.data.companyName.slice(0, 40)} — ${domain}${contactPath ? ' [contact found]' : ''}`);
        } catch {
          /* move on */
        }
      }
    }

    dossiers.push({ cluster, incumbents, complaints, prospects });
  }

  await writeDossiers(dossiers);
  const snap = await getBudgetSnapshot();
  console.log(
    `\n  spend: search $${snap.searchSpentUsd.toFixed(4)}/${snap.searchBudgetUsd}, ` +
      `LLM $${snap.llmSpentUsd.toFixed(4)}/${snap.llmBudgetUsd}`,
  );
}

/** The distinctive noun of a workflow description, for building searches. */
function keyNoun(workflow: string): string {
  const stop = new Set(['manually', 'managing', 'tracking', 'using', 'which', 'their', 'including', 'involves', 'across', 'multiple', 'from', 'into', 'with', 'that', 'this', 'each', 'they', 'them', 'and', 'the', 'for']);
  const words = workflow.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !stop.has(w));
  return words.slice(0, 3).join(' ');
}

const PROSPECT_CITIES = ['Austin TX', 'Denver CO', 'Charlotte NC', 'Portland OR', 'Nashville TN', 'Columbus OH'];

/** What the businesses in a vertical call themselves on their own websites. */
const VERTICAL_BUSINESS_TERMS: Readonly<Record<string, string>> = {
  agencies: 'digital marketing agency',
  realestate: 'real estate brokerage',
  manufacturing: 'machine shop contract manufacturing',
  'healthcare-admin': 'medical billing company',
  property: 'property management company',
  construction: 'general contractor construction company',
  insurance: 'independent insurance agency',
  accounting: 'bookkeeping accounting firm',
  restaurants: 'restaurant group hospitality',
  education: 'tutoring training provider',
  logistics: 'freight broker logistics company',
  staffing: 'staffing recruiting agency',
  nonprofit: 'nonprofit organization',
  legal: 'law firm',
  'field-service': 'HVAC plumbing service company',
  'ecommerce-ops': '3PL fulfillment company',
};

function prospectQueries(c: Cluster): string[] {
  const term = VERTICAL_BUSINESS_TERMS[c.vertical] ?? c.vertical.replace(/-/g, ' ');
  // City-scoped queries land on individual operating businesses; generic ones
  // return directories, "top 10" listicles and vendor pages.
  const exclude = '-site:reddit.com -site:linkedin.com -site:yelp.com -site:indeed.com -site:glassdoor.com';
  return PROSPECT_CITIES.slice(0, 4).map((city) => `${term} ${city} ${exclude}`);
}

async function writeDossiers(dossiers: unknown[]): Promise<void> {
  const dir = path.resolve(process.cwd(), 'research');
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await writeFile(path.join(dir, `deep-dive-${stamp}.json`), JSON.stringify(dossiers, null, 2), 'utf8');

  const lines: string[] = ['# Deep dive — strongest opportunities', '', `Generated: ${new Date().toISOString()}`, ''];
  lines.push(
    'Prices appear only where the figure was found on a page that was actually fetched.',
    'Complaint quotes were checked to appear verbatim in their source.',
    'No company listed here has been contacted.',
    '',
  );

  for (const [i, d] of (dossiers as Array<{
    cluster: Cluster;
    incumbents: Array<{ productName: string; url: string; pricingText: string; priceFound: string[]; whatItDoes: string; apparentWeakness: string; targetCustomer: string }>;
    complaints: Array<{ aboutProduct: string; complaint: string; quote: string; url: string; severity: number }>;
    prospects: Array<{ companyName: string; domain: string; whatTheyDo: string; workflowEvidence: string; workflowInference: string; approximateSize: string; roleToContact: string; personalizationHook: string; contact: string | null }>;
  }>).entries()) {
    const c = d.cluster;
    lines.push(`## ${i + 1}. ${c.workflow}`, '');
    lines.push(`- **Vertical:** ${c.vertical}`);
    lines.push(`- **Buyer:** ${c.buyer}`);
    lines.push(`- **Pain evidence:** ${c.sources} distinct pages across ${c.domains} site(s), score ${c.score.toFixed(1)}`);
    lines.push('');

    lines.push('### Pain evidence (verbatim, from discovery)', '');
    for (const f of c.findings.slice(0, 5)) {
      lines.push(`- > ${f.quote.replace(/\n+/g, ' ').slice(0, 260)}`);
      lines.push(`  _${f.url}_`);
      if (f.currentSpendSignal) lines.push(`  _currently paying for:_ ${f.currentSpendSignal}`);
    }
    lines.push('');

    lines.push('### Incumbents', '');
    if (d.incumbents.length === 0) lines.push('_None identified from fetched pages._', '');
    for (const inc of d.incumbents) {
      lines.push(`- **${inc.productName}** — ${inc.url}`);
      if (inc.whatItDoes) lines.push(`  - ${inc.whatItDoes}`);
      lines.push(`  - Price on page: ${inc.pricingText || (inc.priceFound.length ? `figures found: ${inc.priceFound.join(', ')}` : '_none shown_')}`);
      if (inc.targetCustomer) lines.push(`  - Sells to: ${inc.targetCustomer}`);
      if (inc.apparentWeakness) lines.push(`  - Apparent weakness: ${inc.apparentWeakness}`);
    }
    lines.push('');

    lines.push('### What customers say about incumbents', '');
    if (d.complaints.length === 0) lines.push('_No verifiable customer complaint found._', '');
    for (const cm of d.complaints) {
      lines.push(`- **${cm.aboutProduct}** (severity ${cm.severity.toFixed(2)}) — ${cm.complaint}`);
      lines.push(`  > ${cm.quote.replace(/\n+/g, ' ').slice(0, 260)}`);
      lines.push(`  _${cm.url}_`);
    }
    lines.push('');

    lines.push(`### Real companies matching the ICP (${d.prospects.length}) — NOT CONTACTED`, '');
    if (d.prospects.length === 0) lines.push('_None verified._', '');
    else {
      lines.push('| company | website | what they do (verbatim) | why they likely have the problem (inference) | size | role to contact | public contact path |');
      lines.push('| --- | --- | --- | --- | --- | --- | --- |');
      for (const p of d.prospects) {
        lines.push(
          `| ${p.companyName} | ${p.domain} | ${p.workflowEvidence.slice(0, 80).replace(/\|/g, '/')} | ${p.workflowInference.slice(0, 80).replace(/\|/g, '/')} | ${p.approximateSize || '—'} | ${p.roleToContact || '—'} | ${p.contact ?? 'not published'} |`,
        );
      }
      lines.push('');
      for (const p of d.prospects.slice(0, 8)) {
        if (p.personalizationHook) lines.push(`- **${p.companyName}** hook: ${p.personalizationHook}`);
      }
    }
    lines.push('');
  }

  const file = path.join(dir, `deep-dive-${stamp}.md`);
  await writeFile(file, lines.join('\n'), 'utf8');
  console.log(`\n  dossier: ${file}`);
}

try {
  await main();
} catch (err) {
  console.error(`\ndeep dive error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await closeDb().catch(() => undefined);
}
