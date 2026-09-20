/**
 * Generic, cached research helper.
 *
 * Other layers (wedge, prospecting) reuse this instead of touching a search
 * provider directly, so every query is budgeted, cached, and persisted as a
 * source document exactly once.
 *
 * Rules this enforces for its callers:
 *   - one `search()` per topic, and only when the search budget allows it
 *   - pages are fetched with `politeFetch` (robots.txt honoured) and stored by
 *     content hash, so unchanged pages are never re-analyzed
 *   - the cleaned text is returned; raw HTML never leaves this module
 */
import { BudgetExceededError, FetchError } from '../../lib/errors.js';
import { politeFetch } from '../../lib/fetch.js';
import { createLogger } from '../../lib/logger.js';
import { search, type SearchResult } from '../../lib/search/index.js';
import { htmlToText } from './parse.js';
import { storeSourceDocument, type SourceType } from './source-documents.js';

const logger = createLogger('discovery:research');

export interface ResearchOptions {
  /** Number of search results to request. Default 8, capped at 20. */
  count?: number;
  /** How many of those results to actually fetch. Default 0 (search only). */
  fetchPages?: number;
  /** Characters of cleaned text to keep per page. Default 8000. */
  maxCharsPerPage?: number;
  sourceType?: SourceType;
  opportunityId?: string | null;
  /** Skip results whose host matches one of these. */
  excludeHosts?: string[];
}

export interface ResearchPage {
  url: string;
  title: string;
  text: string;
  status: number;
  /** False when this exact content was already stored — skip re-analysis. */
  isNew: boolean;
}

export interface ResearchResult {
  topic: string;
  results: SearchResult[];
  pages: ResearchPage[];
  /** True when the search budget was exhausted and no query was issued. */
  budgetExhausted: boolean;
}

const MAX_FETCHES_PER_TOPIC = 5;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Searches once for `topic`, optionally fetching and cleaning the top pages.
 * Never throws for an individual page failure; a blown budget returns
 * `budgetExhausted` rather than exploding the caller's job.
 */
export async function research(topic: string, opts: ResearchOptions = {}): Promise<ResearchResult> {
  const count = Math.min(Math.max(opts.count ?? 8, 1), 20);
  const fetchPages = Math.min(opts.fetchPages ?? 0, MAX_FETCHES_PER_TOPIC);
  const maxChars = opts.maxCharsPerPage ?? 8_000;
  const excluded = new Set((opts.excludeHosts ?? []).map((h) => h.toLowerCase()));

  let results: SearchResult[];
  try {
    // Cache-first: `search()` only asserts the budget when it has to spend, so
    // an already-cached topic still answers after the budget is gone.
    results = await search(topic, count);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      logger.warn('search budget exhausted; research skipped', { topic });
      return { topic, results: [], pages: [], budgetExhausted: true };
    }
    throw err;
  }

  const usable = results.filter((r) => {
    const host = hostOf(r.url);
    return host !== null && !excluded.has(host);
  });

  const pages: ResearchPage[] = [];
  for (const result of usable.slice(0, fetchPages)) {
    try {
      const res = await politeFetch(result.url);
      const text = htmlToText(res.body, maxChars);
      const stored = await storeSourceDocument({
        url: result.url,
        sourceType: opts.sourceType ?? 'COMMUNITY',
        text,
        opportunityId: opts.opportunityId ?? null,
        httpStatus: res.status,
        metadata: { topic, title: result.title },
      });
      pages.push({ url: result.url, title: result.title, text, status: res.status, isNew: stored.isNew });
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      const level = err instanceof FetchError ? 'warn' : 'error';
      logger[level]('research page fetch failed; continuing', { url: result.url, err: String(err) });
    }
  }

  logger.info('research complete', { topic, results: results.length, pages: pages.length });
  return { topic, results, pages, budgetExhausted: false };
}
