/**
 * Prospect discovery from PUBLIC information only.
 *
 * Queries are built deterministically from the wedge and aimed at pages a
 * business publishes on purpose — wholesale/trade/stockist pages, storefront
 * signals, public reviews that name a merchant. Search finds candidates; the
 * merchant's own site confirms who they are. Nothing here reads anything that
 * is not publicly served, and no contact list is ever bought or imported.
 */
import type { Wedge } from '../../lib/contracts.js';
import { getConfig } from '../../lib/config.js';
import { getDb } from '../../lib/db.js';
import { hasBudget } from '../../lib/cost.js';
import { politeFetch } from '../../lib/fetch.js';
import { contentHash, newId } from '../../lib/hash.js';
import { createLogger } from '../../lib/logger.js';
import { search, type SearchResult } from '../../lib/search/index.js';
import { BudgetExceededError } from '../../lib/errors.js';
import { extractCompanyName, extractText, looksLikeAuthWall } from './html.js';
import {
  domainToCompanyName,
  isDisallowedProspectDomain,
  normalizeDomain,
} from './domain.js';
import { keywordsFrom } from './qualify.js';

const logger = createLogger('prospecting:discover');

export interface ProspectQuery {
  query: string;
  /** Why this query should surface real businesses. Recorded as evidence. */
  intent: string;
}

/** Pages businesses publish for buyers — the highest-signal public surfaces. */
const PUBLIC_PAGE_QUERIES: ReadonlyArray<readonly [string, string]> = [
  ['"wholesale" "minimum order"', 'public wholesale page stating order minimums'],
  ['"trade account" application', 'public trade-account application page'],
  ['"become a stockist"', 'public stockist page'],
  ['"wholesale enquiries" contact', 'public wholesale contact page'],
  ['"wholesale ordering" "case pack"', 'public case-pack ordering page'],
  ['"local delivery" "in-store pickup"', 'public delivery/pickup page'],
  ['"order minimums" "net 30"', 'public trade terms page'],
];

const ECOSYSTEM_STOREFRONT_MARKERS: Readonly<Record<string, string>> = {
  shopify: '"powered by shopify"',
  woocommerce: '"proudly powered by wordpress" woocommerce',
  bigcommerce: '"powered by bigcommerce"',
  squarespace: '"powered by squarespace"',
};

/**
 * Deterministic. The same wedge always produces the same queries, which keeps
 * the search cache useful and the spend predictable.
 */
export function buildProspectQueries(
  wedge: Wedge,
  opts: { ecosystem: string; category: string },
): ProspectQuery[] {
  const icpWords = keywordsFrom(`${wedge.targetCustomer} ${wedge.whoItIsFor}`, 4);
  const icp = icpWords.slice(0, 3).join(' ');
  const narrow = icpWords.slice(0, 2).join(' ');
  const storefront = ECOSYSTEM_STOREFRONT_MARKERS[opts.ecosystem.toLowerCase()] ?? '';
  const queries: ProspectQuery[] = [];
  const push = (query: string, intent: string): void => {
    const q = query.replace(/\s+/g, ' ').trim();
    if (q === '' || queries.some((existing) => existing.query === q)) return;
    queries.push({ query: q, intent });
  };

  for (const entry of PUBLIC_PAGE_QUERIES) {
    const [fragment, intent] = entry;
    push(`${icp} ${fragment}`, intent);
  }
  if (storefront !== '') {
    push(`${storefront} ${icp} wholesale`, 'live storefront on the target ecosystem');
    push(`${storefront} ${narrow} "trade account"`, 'live storefront with a trade programme');
  }
  if (wedge.primaryCompetitor.trim() !== '') {
    push(
      `"${wedge.primaryCompetitor.trim()}" review "our store"`,
      'public review of the incumbent that names the merchant using it',
    );
  }
  push(`${icp} ${opts.category.replace(/[-_]+/g, ' ')} wholesale`, 'category-specific wholesale page');
  push(`${narrow} "wholesale price list" pdf`, 'published wholesale price list');
  return queries;
}

export interface DiscoverOptions {
  /** Stop once this many NEW prospects have been inserted in this pass. */
  targetNewProspects?: number;
  maxSearches?: number;
  resultsPerQuery?: number;
  /** Fetch each candidate's site to read its real name. Default true. */
  verifyWithFetch?: boolean;
}

export interface DiscoverOutcome {
  opportunityId: string;
  searchesUsed: number;
  resultsSeen: number;
  inserted: number;
  duplicates: number;
  skipped: number;
  budgetExhausted: boolean;
  queriesExhausted: boolean;
}

export const DEFAULT_MAX_SEARCHES_PER_PASS = 12;
export const DEFAULT_RESULTS_PER_QUERY = 20;

async function existingDomains(opportunityId: string): Promise<Set<string>> {
  const db = await getDb();
  const res = await db.query<{ domain: string }>(
    'SELECT domain FROM prospects WHERE opportunity_id = $1',
    [opportunityId],
  );
  return new Set(res.rows.map((r) => r.domain));
}

async function recordSourceDocument(params: {
  opportunityId: string;
  url: string;
  text: string;
  status: number;
}): Promise<void> {
  try {
    const db = await getDb();
    await db.query(
      `INSERT INTO source_documents (id, opportunity_id, url, source_type, content_hash, extracted_text, http_status, metadata_json)
       VALUES ($1,$2,$3,'MERCHANT_SITE',$4,$5,$6,$7)
       ON CONFLICT (url, content_hash) DO NOTHING`,
      [
        newId('src'),
        params.opportunityId,
        params.url,
        contentHash(params.text),
        params.text.slice(0, 20_000),
        params.status,
        JSON.stringify({ capturedBy: 'discover_prospects' }),
      ],
    );
  } catch (err) {
    logger.debug('source document write skipped', { url: params.url, err: String(err) });
  }
}

function cleanSearchTitle(title: string): string {
  return title
    .split(/\s+[|–—•·]\s+|\s+-\s+/)[0]
    ?.replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) ?? '';
}

/**
 * One discovery pass for one opportunity. Idempotent: existing domains are
 * skipped and the unique index on (opportunity_id, domain) is the backstop.
 */
export async function discoverProspectsFor(params: {
  opportunityId: string;
  wedge: Wedge;
  ecosystem: string;
  category: string;
  options?: DiscoverOptions;
}): Promise<DiscoverOutcome> {
  const cfg = getConfig();
  const opts = params.options ?? {};
  const target = opts.targetNewProspects ?? cfg.preferredQualifiedProspects;
  const maxSearches = opts.maxSearches ?? DEFAULT_MAX_SEARCHES_PER_PASS;
  const resultsPerQuery = opts.resultsPerQuery ?? DEFAULT_RESULTS_PER_QUERY;
  const verify = opts.verifyWithFetch !== false;

  const known = await existingDomains(params.opportunityId);
  const queries = buildProspectQueries(params.wedge, {
    ecosystem: params.ecosystem,
    category: params.category,
  });

  const outcome: DiscoverOutcome = {
    opportunityId: params.opportunityId,
    searchesUsed: 0,
    resultsSeen: 0,
    inserted: 0,
    duplicates: 0,
    skipped: 0,
    budgetExhausted: false,
    queriesExhausted: false,
  };

  const db = await getDb();
  const seenThisPass = new Set<string>();

  for (const [index, entry] of queries.entries()) {
    if (outcome.inserted >= target || outcome.searchesUsed >= maxSearches) break;

    // Give up rather than burning the budget on a category that will not pay.
    if (!(await hasBudget('SEARCH', cfg.braveSearchCostPerCall))) {
      outcome.budgetExhausted = true;
      logger.warn('search budget exhausted during prospect discovery', {
        opportunityId: params.opportunityId,
        searchesUsed: outcome.searchesUsed,
      });
      break;
    }

    let results: SearchResult[];
    try {
      results = await search(entry.query, resultsPerQuery);
      outcome.searchesUsed += 1;
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        outcome.budgetExhausted = true;
        break;
      }
      logger.warn('prospect search failed', { query: entry.query, err: String(err) });
      continue;
    }

    for (const result of results) {
      if (outcome.inserted >= target) break;
      outcome.resultsSeen += 1;

      const domain = normalizeDomain(result.url);
      if (domain === null || isDisallowedProspectDomain(domain)) {
        outcome.skipped += 1;
        continue;
      }
      if (seenThisPass.has(domain)) {
        outcome.duplicates += 1;
        continue;
      }
      seenThisPass.add(domain);
      if (known.has(domain)) {
        outcome.duplicates += 1;
        continue;
      }

      let companyName = cleanSearchTitle(result.title) || domainToCompanyName(domain);
      let evidenceUrl = result.url;
      let fetched = false;

      if (verify) {
        try {
          const res = await politeFetch(result.url);
          if (!looksLikeAuthWall(res.body, res.finalUrl)) {
            const text = extractText(res.body);
            companyName = extractCompanyName(res.body, domain);
            evidenceUrl = res.finalUrl || result.url;
            fetched = true;
            await recordSourceDocument({
              opportunityId: params.opportunityId,
              url: evidenceUrl,
              text,
              status: res.status,
            });
          }
        } catch (err) {
          // A merchant whose page we cannot read is still a candidate; the
          // qualification pass will fetch again and disqualify if it stays dark.
          logger.debug('candidate fetch failed during discovery', {
            url: result.url,
            err: String(err),
          });
        }
      }

      const inserted = await db.query<{ id: string }>(
        `INSERT INTO prospects
           (id, opportunity_id, company_name, domain, ecosystem, public_evidence_url, status, evidence_json)
         VALUES ($1,$2,$3,$4,$5,$6,'DISCOVERED',$7)
         ON CONFLICT (opportunity_id, domain) DO NOTHING
         RETURNING id`,
        [
          newId('pr'),
          params.opportunityId,
          companyName.slice(0, 200),
          domain,
          params.ecosystem,
          evidenceUrl,
          JSON.stringify({
            discoveredVia: entry.query,
            queryIntent: entry.intent,
            queryIndex: index,
            searchTitle: result.title.slice(0, 200),
            searchUrl: result.url,
            siteFetched: fetched,
          }),
        ],
      );

      if (inserted.rows.length > 0) {
        known.add(domain);
        outcome.inserted += 1;
      } else {
        outcome.duplicates += 1;
      }
    }
  }

  outcome.queriesExhausted =
    outcome.searchesUsed >= queries.length && outcome.inserted < target && !outcome.budgetExhausted;

  logger.info('prospect discovery pass complete', { ...outcome });
  return outcome;
}

export { normalizeDomain, isDisallowedProspectDomain } from './domain.js';
