/**
 * Web search. Cached aggressively — search is for DISCOVERY, not for every
 * fetch. Once a URL is known, fetch it directly instead of searching again.
 */
import { getConfig } from '../config.js';
import { getDb } from '../db.js';
import { sha256 } from '../hash.js';
import { createLogger } from '../logger.js';
import { assertBudget, recordCost } from '../cost.js';
import { ProviderError } from '../errors.js';

const logger = createLogger('search');

export interface SearchResult {
  title: string;
  url: string;
  description: string;
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, count: number): Promise<SearchResult[]>;
}

export class BraveSearchProvider implements SearchProvider {
  readonly name = 'brave';

  async search(query: string, count: number): Promise<SearchResult[]> {
    const cfg = getConfig();
    if (!cfg.braveSearchApiKey) {
      throw new ProviderError('brave', 'BRAVE_SEARCH_API_KEY is not set', false);
    }
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(Math.min(count, 20)));
    url.searchParams.set('result_filter', 'web');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.fetchTimeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': cfg.braveSearchApiKey,
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        throw new ProviderError('brave', `HTTP ${res.status}`, retryable);
      }
      const body = (await res.json()) as {
        web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
      };
      const results: SearchResult[] = [];
      for (const r of body.web?.results ?? []) {
        if (typeof r.url !== 'string') continue;
        results.push({
          title: stripTags(r.title ?? ''),
          url: r.url,
          description: stripTags(r.description ?? ''),
        });
      }
      return results;
    } finally {
      clearTimeout(timer);
    }
  }
}

export class MockSearchProvider implements SearchProvider {
  readonly name = 'mock';
  private fixtures = new Map<string, SearchResult[]>();
  readonly queries: string[] = [];

  register(queryContains: string, results: SearchResult[]): this {
    this.fixtures.set(queryContains.toLowerCase(), results);
    return this;
  }

  async search(query: string, count: number): Promise<SearchResult[]> {
    this.queries.push(query);
    const q = query.toLowerCase();
    for (const [needle, results] of this.fixtures) {
      if (q.includes(needle)) return results.slice(0, count);
    }
    return [];
  }
}

/** Brave descriptions contain highlight markup. */
function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '').trim();
}

let provider: SearchProvider | null = null;

export function getSearchProvider(): SearchProvider {
  if (!provider) {
    const cfg = getConfig();
    provider = cfg.searchProvider === 'mock' || !cfg.braveSearchApiKey
      ? new MockSearchProvider()
      : new BraveSearchProvider();
    if (cfg.searchProvider !== 'mock' && !cfg.braveSearchApiKey) {
      logger.warn('BRAVE_SEARCH_API_KEY missing — falling back to mock search provider');
    }
  }
  return provider;
}

export function setSearchProvider(p: SearchProvider | null): void {
  provider = p;
}

/**
 * Cached search. Never issues the same query twice inside the TTL, and never
 * issues any query once the monthly search budget is gone.
 */
export async function search(query: string, count = 10): Promise<SearchResult[]> {
  const cfg = getConfig();
  const key = sha256(JSON.stringify([cfg.searchProvider, query, count]));
  const db = await getDb();

  const cached = await db.query<{ results_json: unknown }>(
    'SELECT results_json FROM search_cache WHERE cache_key = $1 AND expires_at > now()',
    [key],
  );
  const hit = cached.rows[0];
  if (hit) {
    const raw = typeof hit.results_json === 'string' ? JSON.parse(hit.results_json) : hit.results_json;
    logger.debug('search cache hit', { query });
    return raw as SearchResult[];
  }

  await assertBudget('SEARCH', cfg.braveSearchCostPerCall);

  const p = getSearchProvider();
  const results = await p.search(query, count);

  await recordCost({
    provider: p.name === 'mock' ? 'mock' : 'brave',
    resourceType: 'SEARCH_CALL',
    quantity: 1,
    estimatedCost: p.name === 'mock' ? 0 : cfg.braveSearchCostPerCall,
    metadata: { query, resultCount: results.length },
  });

  const expires = new Date(Date.now() + cfg.searchCacheTtlHours * 3600_000);
  await db.query(
    `INSERT INTO search_cache (cache_key, expires_at, query, results_json)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (cache_key) DO UPDATE
       SET results_json = EXCLUDED.results_json, expires_at = EXCLUDED.expires_at`,
    [key, expires.toISOString(), query, JSON.stringify(results)],
  );

  logger.info('search executed', { query, results: results.length });
  return results;
}
