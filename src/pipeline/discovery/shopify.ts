/**
 * Shopify App Store adapter.
 *
 * Discovery budget discipline:
 *   - `search()` is used ONLY to turn a seed topic into URLs. Once a URL is
 *     known it is fetched directly with `politeFetch`; we never search for a
 *     URL we already hold.
 *   - Every fetched page lands in `source_documents` keyed by content hash.
 *     Unchanged content is never analyzed again.
 *   - Extraction is deterministic Cheerio + regex. The fast LLM tier is only
 *     reached when a pricing region exists but yields no parseable plan AND no
 *     free-tier verdict, and then only on a short extracted snippet.
 */
import { z } from 'zod';
import { AppError, BudgetExceededError, FetchError } from '../../lib/errors.js';
import { politeFetch } from '../../lib/fetch.js';
import { llmComplete } from '../../lib/llm/index.js';
import { createLogger } from '../../lib/logger.js';
import { search } from '../../lib/search/index.js';
import type {
  DiscoveredCandidate,
  EvidenceExtractor,
  ExtractContext,
  ExtractedCompetitor,
  MarketplaceAdapter,
  OpportunitySource,
  ProspectCandidate,
  ProspectFinder,
} from '../../lib/contracts.js';
import {
  classifyCompetitorEvidence,
  CompetitorEvidenceJson,
  type CompetitorFacts,
} from '../verification/evidence.js';
import { htmlToText, parseAppListing, parseReviews, pricingSnippet, type ParsedListing } from './parse.js';
import { storeSourceDocument } from './source-documents.js';

const logger = createLogger('discovery:shopify');

export const SHOPIFY_ECOSYSTEM = 'shopify';
const APP_STORE_HOST = 'apps.shopify.com';

// --- seed categories ---------------------------------------------------------

export interface SeedCategory {
  /** Stable slug. Becomes part of `opportunities.dedupe_key`. */
  slug: string;
  name: string;
  /** The search query. Narrow on purpose — broad queries find broad markets. */
  query: string;
  description: string;
}

/**
 * Curated NARROW categories. Each one is a single recurring merchant job that
 * a very small app can do completely. Breadth here is a bug, not a feature.
 */
export const SHOPIFY_SEED_CATEGORIES: readonly SeedCategory[] = [
  {
    slug: 'checkout-validation-rules',
    name: 'Checkout validation rules',
    query: 'shopify app checkout validation rules block orders',
    description: 'Block or warn on carts that break a merchant-defined rule before checkout completes.',
  },
  {
    slug: 'minimum-maximum-order-rules',
    name: 'Minimum and maximum order rules',
    query: 'shopify app minimum order amount quantity limits',
    description: 'Enforce minimum/maximum order value, quantity, or weight per cart, product, or customer group.',
  },
  {
    slug: 'order-tagging-automation',
    name: 'Order tagging automation',
    query: 'shopify app automatic order tagging rules',
    description: 'Tag orders automatically from order attributes so downstream tooling can route them.',
  },
  {
    slug: 'customer-tagging-rules',
    name: 'Customer tagging rules',
    query: 'shopify app customer tagging automation rules',
    description: 'Tag customers by order history, location, or signup source to drive segmentation.',
  },
  {
    slug: 'shipping-rate-rules',
    name: 'Shipping rate rules',
    query: 'shopify app custom shipping rates rules by zip postcode',
    description: 'Custom shipping rates driven by postcode, weight, product tag, or order value.',
  },
  {
    slug: 'delivery-date-estimates',
    name: 'Delivery date estimates',
    query: 'shopify app estimated delivery date product page',
    description: 'Show an accurate estimated delivery date on product and cart pages.',
  },
  {
    slug: 'local-pickup-and-delivery',
    name: 'Local pickup and delivery scheduling',
    query: 'shopify app local pickup delivery date picker',
    description: 'Let customers pick a local pickup slot or delivery window at checkout.',
  },
  {
    slug: 'store-locator',
    name: 'Store locator',
    query: 'shopify app store locator stockist map',
    description: 'A searchable map of physical stockists or branches.',
  },
  {
    slug: 'product-options-rules',
    name: 'Product option rules',
    query: 'shopify app product options conditional logic rules',
    description: 'Conditional product options and dependency rules on the product page.',
  },
  {
    slug: 'b2b-wholesale-pricing',
    name: 'B2B wholesale pricing rules',
    query: 'shopify app wholesale b2b pricing customer group',
    description: 'Per-customer-group price lists, net terms display, and wholesale-only catalogues.',
  },
  {
    slug: 'b2b-quote-requests',
    name: 'B2B quote requests',
    query: 'shopify app request a quote b2b wholesale',
    description: 'Replace add-to-cart with a request-for-quote flow for trade customers.',
  },
  {
    slug: 'inventory-low-stock-alerts',
    name: 'Low stock alerts',
    query: 'shopify app low stock alert email inventory',
    description: 'Email or Slack alerts when a variant crosses a stock threshold.',
  },
  {
    slug: 'inventory-sync',
    name: 'Inventory synchronization',
    query: 'shopify app inventory sync between stores locations',
    description: 'Keep inventory in step across stores, locations, or bundled SKUs.',
  },
  {
    slug: 'product-data-import-export',
    name: 'Product data import and export',
    query: 'shopify app bulk product csv import export',
    description: 'Scheduled or one-off bulk product/metafield CSV import and export.',
  },
  {
    slug: 'order-export-automation',
    name: 'Order export automation',
    query: 'shopify app automatic order export csv ftp email',
    description: 'Scheduled order exports to CSV/FTP/email in a fulfilment partner layout.',
  },
  {
    slug: 'metafield-management',
    name: 'Metafield management',
    query: 'shopify app metafields bulk editor',
    description: 'Bulk edit, template, and validate metafields across a catalogue.',
  },
  {
    slug: 'url-redirect-management',
    name: 'URL redirect management',
    query: 'shopify app bulk 301 redirect manager broken links',
    description: 'Bulk 301 redirects and broken-link detection after a migration or re-platform.',
  },
  {
    slug: 'invoice-and-packing-slips',
    name: 'Invoices and packing slips',
    query: 'shopify app invoice packing slip pdf generator',
    description: 'Branded PDF invoices, packing slips, and credit notes with per-market layouts.',
  },
  {
    slug: 'back-in-stock-alerts',
    name: 'Back-in-stock alerts',
    query: 'shopify app back in stock notification email',
    description: 'Capture demand for out-of-stock variants and notify on restock.',
  },
  {
    slug: 'simple-workflow-automation',
    name: 'Simple workflow automation',
    query: 'shopify app workflow automation if this then that orders',
    description: 'Single-trigger, single-action automations over orders, customers, and inventory.',
  },
  {
    slug: 'address-validation',
    name: 'Shipping address validation',
    query: 'shopify app address validation checkout typo',
    description: 'Catch undeliverable or mistyped shipping addresses before fulfilment.',
  },
  {
    slug: 'product-bundle-rules',
    name: 'Product bundle rules',
    query: 'shopify app product bundles rules discount',
    description: 'Rule-driven bundles and kits with correct inventory decrement.',
  },
];

// --- URL handling ------------------------------------------------------------

const RESERVED_PATH_SEGMENTS = new Set([
  'categories', 'search', 'collections', 'partners', 'stories', 'blog', 'browse',
  'pricing', 'login', 'plus', 'sitemap', 'trending', 'best', 'about', 'help',
  'developers', 'services', 'apps', 'compare',
]);

/** Canonical `https://apps.shopify.com/<handle>` or null when not a listing. */
export function normalizeListingUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  if (host !== APP_STORE_HOST) return null;

  const segments = u.pathname.split('/').filter(Boolean);
  const handle = segments[0];
  if (!handle) return null;
  if (RESERVED_PATH_SEGMENTS.has(handle.toLowerCase())) return null;
  if (!/^[a-z0-9][a-z0-9._-]{1,80}$/i.test(handle)) return null;
  // Allow .../reviews and .../pricing to resolve back to the listing itself.
  if (segments.length > 1 && !['reviews', 'pricing', 'privacy'].includes(segments[1] ?? '')) {
    return null;
  }
  return `https://${APP_STORE_HOST}/${handle.toLowerCase()}`;
}

export function isCategoryUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.hostname.replace(/^www\./, '') === APP_STORE_HOST && u.pathname.startsWith('/categories/');
  } catch {
    return false;
  }
}

export function reviewsUrl(listingUrl: string): string {
  return `${listingUrl.replace(/\/+$/, '')}/reviews`;
}

// --- fetch + persist ---------------------------------------------------------

// Defined once in contracts.ts so every ecosystem adapter shares one shape.
export type { ExtractContext } from '../../lib/contracts.js';

interface FetchedPage {
  url: string;
  html: string;
  text: string;
  status: number;
  /** False when this exact content is already in source_documents. */
  isNew: boolean;
}

/** Fetches and persists one page. Returns null on any non-fatal failure. */
async function fetchAndStore(
  url: string,
  sourceType: 'APP_LISTING' | 'REVIEWS' | 'SEARCH_RESULT' | 'COMMUNITY' | 'MERCHANT_SITE',
  opportunityId: string | null,
): Promise<FetchedPage | null> {
  try {
    const res = await politeFetch(url);
    const text = htmlToText(res.body);
    const stored = await storeSourceDocument({
      url,
      sourceType,
      text,
      opportunityId,
      httpStatus: res.status,
      metadata: { finalUrl: res.finalUrl, contentType: res.contentType },
    });
    return { url, html: res.body, text, status: res.status, isNew: stored.isNew };
  } catch (err) {
    if (err instanceof BudgetExceededError) throw err;
    const level = err instanceof FetchError ? 'warn' : 'error';
    logger[level]('page fetch failed; continuing', { url, err: String(err) });
    return null;
  }
}

// --- LLM fallback (last resort only) -----------------------------------------

const PricingDisambiguation = z.object({
  hasPermanentFreeTier: z.boolean().nullable(),
  monthlyPrices: z.array(z.number().min(0).max(10_000)).max(8),
  planNames: z.array(z.string().max(60)).max(8),
  freeTrialDays: z.number().int().min(0).max(365).nullable(),
});
type PricingDisambiguation = z.infer<typeof PricingDisambiguation>;

const PRICING_SYSTEM = [
  'You read one short pricing snippet copied from a marketplace app listing.',
  'Return ONLY what the snippet literally states. Never estimate, never infer a',
  'price that is not written down. A time-limited free trial is NOT a permanent',
  'free tier. "Free to install" with usage charges is NOT a permanent free tier.',
  'If the snippet does not say, use null or an empty array.',
].join(' ');

async function disambiguatePricing(listing: ParsedListing): Promise<PricingDisambiguation | null> {
  const snippet = pricingSnippet(listing);
  if (snippet.length < 20) return null;
  try {
    const res = await llmComplete({
      tier: 'fast',
      task: 'shopify_pricing_disambiguation',
      schemaName: 'PricingDisambiguation',
      schema: PricingDisambiguation,
      maxTokens: 400,
      system: PRICING_SYSTEM,
      user: `Listing: ${listing.name ?? listing.url}\nPricing snippet:\n"""\n${snippet}\n"""`,
    });
    logger.info('pricing disambiguated by fast tier', { url: listing.url, cached: res.cached });
    return res.data;
  } catch (err) {
    if (err instanceof BudgetExceededError) throw err;
    logger.warn('pricing disambiguation failed; keeping deterministic result', {
      url: listing.url,
      err: String(err),
    });
    return null;
  }
}

function applyDisambiguation(listing: ParsedListing, extra: PricingDisambiguation): ParsedListing {
  const plans = extra.monthlyPrices.map((price, i) => ({
    name: extra.planNames[i] ?? `Plan ${i + 1}`,
    priceMonthly: price,
    rawPrice: `$${price}/month`,
    isFree: price === 0,
    features: [],
  }));
  return {
    ...listing,
    plans: listing.plans.length > 0 ? listing.plans : plans,
    hasPermanentFreeTier: extra.hasPermanentFreeTier ?? listing.hasPermanentFreeTier,
    freeTrialDays: listing.freeTrialDays ?? extra.freeTrialDays,
    currentPricing:
      listing.currentPricing ??
      (plans.length > 0 ? plans.map((p) => `${p.name}: $${p.priceMonthly}/mo`).join('; ') : null),
    ambiguous: false,
  };
}

// --- opportunity source ------------------------------------------------------

const MAX_COMPETITOR_URLS_PER_CATEGORY = 6;

export class ShopifyOpportunitySource implements OpportunitySource {
  readonly ecosystem = SHOPIFY_ECOSYSTEM;

  constructor(private readonly seeds: readonly SeedCategory[] = SHOPIFY_SEED_CATEGORIES) {}

  async discover(limit: number): Promise<DiscoveredCandidate[]> {
    const out: DiscoveredCandidate[] = [];

    for (const seed of this.seeds) {
      if (out.length >= limit) break;

      let results;
      try {
        // DISCOVERY ONLY. Everything after this line is a direct fetch.
        // `search()` is cache-first and asserts the budget only on a miss, so
        // calling it is how we stay cheap AND still stop at the cap.
        results = await search(`site:${APP_STORE_HOST} ${seed.query}`, 10);
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          logger.warn('search budget exhausted; stopping discovery early', {
            seed: seed.slug,
            found: out.length,
          });
          break;
        }
        logger.error('search failed for seed category', { seed: seed.slug, err: String(err) });
        continue;
      }

      const listingUrls: string[] = [];
      const categoryUrls: string[] = [];
      for (const r of results) {
        if (isCategoryUrl(r.url)) {
          if (!categoryUrls.includes(r.url)) categoryUrls.push(r.url);
          continue;
        }
        const normalized = normalizeListingUrl(r.url);
        if (normalized && !listingUrls.includes(normalized)) listingUrls.push(normalized);
      }

      if (listingUrls.length === 0) {
        logger.info('no app listings found for seed', { seed: seed.slug });
        continue;
      }

      out.push({
        name: seed.name,
        ecosystem: this.ecosystem,
        category: seed.slug,
        description: seed.description,
        sourceUrl:
          categoryUrls[0] ?? `https://${APP_STORE_HOST}/search?q=${encodeURIComponent(seed.query)}`,
        competitorUrls: listingUrls.slice(0, MAX_COMPETITOR_URLS_PER_CATEGORY),
        metadata: {
          seedQuery: seed.query,
          categoryUrls,
          searchResultCount: results.length,
        },
      });
    }

    logger.info('shopify discovery pass complete', { candidates: out.length, limit });
    return out;
  }
}

// --- evidence extractor ------------------------------------------------------

export interface ShopifyExtractedCompetitor extends ExtractedCompetitor {
  /** Structured facts persisted to `competitors.evidence_json`. */
  evidenceJson: CompetitorEvidenceJson;
}

export class ShopifyEvidenceExtractor implements EvidenceExtractor {
  readonly ecosystem = SHOPIFY_ECOSYSTEM;

  /**
   * `ctx` is optional so this still satisfies `EvidenceExtractor`, but the
   * discovery runner passes the opportunity id so source documents are linked.
   */
  async extractCompetitor(
    url: string,
    ctx: ExtractContext = {},
  ): Promise<ShopifyExtractedCompetitor | null> {
    const listingUrl = normalizeListingUrl(url) ?? url;
    const opportunityId = ctx.opportunityId ?? null;

    const page = await fetchAndStore(listingUrl, 'APP_LISTING', opportunityId);
    if (!page) return null;

    let listing = parseAppListing(page.html, listingUrl);
    if (listing.parseWarnings.length > 0) {
      logger.warn('listing parsed with warnings', {
        url: listingUrl,
        warnings: listing.parseWarnings.slice(0, 3),
      });
    }

    // Deterministic first. The LLM is reached only when the page genuinely
    // states pricing we cannot parse, and only for content we have not seen.
    if (listing.ambiguous && page.isNew) {
      const extra = await disambiguatePricing(listing);
      if (extra) listing = applyDisambiguation(listing, extra);
    } else if (listing.ambiguous) {
      logger.debug('ambiguous pricing but content unchanged; not re-analyzing', { url: listingUrl });
    }

    const reviewsPage = await fetchAndStore(reviewsUrl(listingUrl), 'REVIEWS', opportunityId);
    const reviews = reviewsPage
      ? parseReviews(reviewsPage.html, reviewsPage.url)
      : listing.reviews;

    const observedAt = new Date().toISOString().slice(0, 10);
    const facts: CompetitorFacts = {
      name: listing.name ?? handleOf(listingUrl),
      url: listingUrl,
      currentPricing: listing.currentPricing,
      freePlanDetails: listing.freePlanDetails,
      hasPermanentFreeTier: listing.hasPermanentFreeTier,
      reviewCount: listing.reviewCount,
      rating: listing.rating,
      launchAge: listing.launchAge,
      paidPlanPrices: listing.plans
        .map((p) => p.priceMonthly)
        .filter((p): p is number => p !== null && p > 0),
      disclosureText: listing.description,
      observedAt,
      reviews,
    };

    return {
      name: facts.name,
      url: listingUrl,
      currentPricing: facts.currentPricing,
      freePlanDetails: facts.freePlanDetails,
      hasPermanentFreeTier: facts.hasPermanentFreeTier,
      reviewCount: facts.reviewCount,
      rating: facts.rating,
      launchAge: facts.launchAge,
      evidence: classifyCompetitorEvidence(facts),
      reviews,
      evidenceJson: CompetitorEvidenceJson.parse({
        paidPlanPrices: facts.paidPlanPrices,
        planNames: listing.plans.map((p) => p.name),
        freeTrialDays: listing.freeTrialDays,
        freeToInstall: listing.freeToInstall,
        description: listing.description.slice(0, 2000),
        observedAt,
        parseWarnings: listing.parseWarnings.slice(0, 10),
      }),
    };
  }
}

function handleOf(listingUrl: string): string {
  try {
    const seg = new URL(listingUrl).pathname.split('/').filter(Boolean)[0] ?? listingUrl;
    return seg.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  } catch {
    return listingUrl;
  }
}

// --- prospect finder ---------------------------------------------------------

/**
 * NOT IMPLEMENTED HERE ON PURPOSE.
 *
 * Prospect discovery is owned by the prospecting layer
 * (`src/pipeline/prospecting/**`). This stub exists only so the adapter
 * satisfies `MarketplaceAdapter`; the prospecting agent replaces it with a real
 * finder. Calling it throws a typed error rather than returning empty results,
 * so a wiring mistake fails loudly instead of silently finding no prospects.
 */
export class ShopifyProspectFinder implements ProspectFinder {
  readonly ecosystem = SHOPIFY_ECOSYSTEM;

  async find(): Promise<ProspectCandidate[]> {
    throw new AppError(
      'ShopifyProspectFinder is owned by src/pipeline/prospecting and is not implemented in the discovery layer',
      'NOT_IMPLEMENTED',
    );
  }
}

// --- adapter -----------------------------------------------------------------

export const shopifyAdapter: MarketplaceAdapter = {
  ecosystem: SHOPIFY_ECOSYSTEM,
  source: new ShopifyOpportunitySource(),
  extractor: new ShopifyEvidenceExtractor(),
  prospectFinder: new ShopifyProspectFinder(),
};
