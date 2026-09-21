/**
 * Generic multi-ecosystem exploration.
 *
 * The research layer is no longer conceptually Shopify-only. Any ecosystem —
 * Atlassian, WooCommerce/WordPress, HubSpot, QuickBooks/Xero, Chrome
 * extensions, Webflow, Wix, Squarespace, Slack, or something nobody has named
 * yet — can be probed with ORDINARY web search and polite fetching. No bespoke
 * integration, no per-marketplace parser, no new credentials.
 *
 * THE SYSTEM MUST NOT MODIFY ITS OWN SOURCE CODE.
 *
 * When an ecosystem keeps looking productive this module raises
 * `adapterCandidate` and records an internal ADAPTER_CANDIDATE audit event.
 * That is a RECOMMENDATION TO A HUMAN and nothing more. It does not write a
 * file, generate an adapter, or register anything in `getAdapters()`. Generic
 * web research is sufficient until a person decides a dedicated adapter is
 * justified and writes one by hand; an autonomous system that edits its own
 * code has no reviewable boundary left.
 */
import { recordAudit } from '../../lib/audit';
import { getConfig } from '../../lib/config';
import { getDb } from '../../lib/db';
import { createLogger } from '../../lib/logger';
import { getAdapter, research } from '../../pipeline/discovery/index';
import { extractMonthlyPrices } from '../../pipeline/discovery/parse';
import { proposeSource } from './sources';

const logger = createLogger('autonomy:ecosystems');

// --- the catalog ----------------------------------------------------------------

export interface EcosystemDescriptor {
  /** Human-facing name used verbatim in search text. */
  label: string;
  /** Best-known marketplace home, proposed as an UNVERIFIED source when useful. */
  marketplaceUrl: string | null;
}

/**
 * Starting points, not a closed list. `exploreEcosystem()` accepts any name;
 * an unknown one simply gets the generic probe.
 */
export const ECOSYSTEM_CATALOG: Readonly<Record<string, EcosystemDescriptor>> = {
  shopify: { label: 'Shopify', marketplaceUrl: 'https://apps.shopify.com' },
  atlassian: { label: 'Atlassian Jira Confluence', marketplaceUrl: 'https://marketplace.atlassian.com' },
  woocommerce: { label: 'WooCommerce', marketplaceUrl: 'https://woocommerce.com/products' },
  wordpress: { label: 'WordPress', marketplaceUrl: 'https://wordpress.org/plugins' },
  hubspot: { label: 'HubSpot', marketplaceUrl: 'https://ecosystem.hubspot.com/marketplace/apps' },
  quickbooks: { label: 'QuickBooks', marketplaceUrl: 'https://apps.intuit.com' },
  xero: { label: 'Xero', marketplaceUrl: 'https://apps.xero.com' },
  chrome: { label: 'Chrome extension', marketplaceUrl: 'https://chromewebstore.google.com' },
  webflow: { label: 'Webflow', marketplaceUrl: 'https://webflow.com/apps' },
  wix: { label: 'Wix', marketplaceUrl: 'https://www.wix.com/app-market' },
  squarespace: { label: 'Squarespace', marketplaceUrl: 'https://www.squarespace.com/extensions' },
  slack: { label: 'Slack', marketplaceUrl: 'https://slack.com/marketplace' },
};

export const KNOWN_ECOSYSTEMS: readonly string[] = Object.keys(ECOSYSTEM_CATALOG);

export function describeEcosystem(ecosystem: string): EcosystemDescriptor {
  const key = ecosystem.trim().toLowerCase();
  return (
    ECOSYSTEM_CATALOG[key] ?? {
      label: ecosystem.trim() || 'unknown platform',
      marketplaceUrl: null,
    }
  );
}

// --- probe parameters -------------------------------------------------------------

/** Search topics per probe. Two is enough to tell "market" from "nothing". */
export const TOPICS_PER_PROBE = 2;
/** Pages fetched per topic. Every fetch is polite and content-hashed. */
export const PAGES_PER_TOPIC = 2;
/** Pages showing real commercial evidence before an ecosystem looks worth it. */
export const MIN_CANDIDATES_FOR_PROMISING = 2;
/** Distinct monthly prices seen before we believe money changes hands. */
export const MIN_DISTINCT_PRICES_FOR_PROMISING = 2;
/** Promising probes before a human is told an adapter might be justified. */
export const ADAPTER_CANDIDATE_THRESHOLD = 3;

const REVIEW_MARKER = /(\breviews?\b|\bratings?\b|\d+(?:\.\d)?\s*out of 5|\binstalls?\b|\bcustomers\b)/i;
const SUBSCRIPTION_MARKER = /(\/month\b|\bper month\b|\bmonthly\b|\bsubscription\b|\bbilled annually\b)/i;

export function probeTopics(descriptor: EcosystemDescriptor): string[] {
  return [
    `${descriptor.label} app marketplace paid apps pricing per month`,
    `${descriptor.label} plugin pricing plans for businesses`,
  ].slice(0, TOPICS_PER_PROBE);
}

// --- evidence ----------------------------------------------------------------------

export interface EcosystemEvidence {
  pagesFetched: number;
  candidateUrls: string[];
  distinctPrices: number;
  pagesWithReviews: number;
}

/**
 * PURE. Decides, from cleaned page text alone, whether a page is evidence
 * that somebody already sells recurring software into this ecosystem.
 */
export function pageLooksCommercial(text: string): { commercial: boolean; prices: number[] } {
  const prices = extractMonthlyPrices(text)
    .map((p) => p.amount)
    .filter((amount) => amount > 0);
  const commercial = prices.length > 0 && SUBSCRIPTION_MARKER.test(text);
  return { commercial, prices };
}

// --- audit history ------------------------------------------------------------------

const PROBE_ACTOR = 'explore_ecosystem';
const ADAPTER_CANDIDATE_REASON = 'ADAPTER_CANDIDATE';

async function priorPromisingProbes(ecosystem: string): Promise<number> {
  const db = await getDb();
  const res = await db.query<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM audit_events
      WHERE actor = $1
        AND detail_json->>'ecosystem' = $2
        AND detail_json->>'promising' = 'true'`,
    [PROBE_ACTOR, ecosystem],
  );
  return Number(res.rows[0]?.n ?? 0);
}

// --- the probe --------------------------------------------------------------------------

export interface EcosystemProbeResult {
  ecosystem: string;
  supported: boolean;
  candidatesFound: number;
  promising: boolean;
  adapterCandidate: boolean;
}

/**
 * Probes one ecosystem with generic search + fetch and reports what it found.
 *
 * `supported: false` means "no dedicated adapter exists" — which is the normal
 * case and not a failure. Everything this function learns is learned the
 * generic way.
 */
export async function exploreEcosystem(ecosystem: string): Promise<EcosystemProbeResult> {
  const name = ecosystem.trim().toLowerCase();
  const descriptor = describeEcosystem(name);
  const supported = getAdapter(name) !== null;

  const result: EcosystemProbeResult = {
    ecosystem: name,
    supported,
    candidatesFound: 0,
    promising: false,
    adapterCandidate: false,
  };

  if (getConfig().killSwitch) {
    logger.warn('KILL_SWITCH is on; ecosystem exploration skipped', { ecosystem: name });
    return result;
  }

  const evidence: EcosystemEvidence = {
    pagesFetched: 0,
    candidateUrls: [],
    distinctPrices: 0,
    pagesWithReviews: 0,
  };
  const prices = new Set<number>();

  for (const topic of probeTopics(descriptor)) {
    const found = await research(topic, {
      count: 8,
      fetchPages: PAGES_PER_TOPIC,
      sourceType: 'SEARCH_RESULT',
    });
    if (found.budgetExhausted) {
      logger.warn('search budget exhausted; ecosystem probe truncated', { ecosystem: name, topic });
      break;
    }
    for (const page of found.pages) {
      evidence.pagesFetched += 1;
      const { commercial, prices: pagePrices } = pageLooksCommercial(page.text);
      for (const price of pagePrices) prices.add(price);
      if (REVIEW_MARKER.test(page.text)) evidence.pagesWithReviews += 1;
      if (commercial && !evidence.candidateUrls.includes(page.url)) {
        evidence.candidateUrls.push(page.url);
      }
    }
  }

  evidence.distinctPrices = prices.size;
  result.candidatesFound = evidence.candidateUrls.length;
  result.promising =
    result.candidatesFound >= MIN_CANDIDATES_FOR_PROMISING &&
    evidence.distinctPrices >= MIN_DISTINCT_PRICES_FOR_PROMISING;

  const promisingSoFar = (await priorPromisingProbes(name)) + (result.promising ? 1 : 0);
  result.adapterCandidate = !supported && promisingSoFar >= ADAPTER_CANDIDATE_THRESHOLD;

  await recordAudit({
    entityType: 'system',
    eventType: 'DECISION',
    actor: PROBE_ACTOR,
    reason: result.promising
      ? `${name} shows recurring commercial software`
      : `${name} shows no clear recurring commercial software`,
    detail: {
      ecosystem: name,
      supported,
      promising: result.promising,
      candidatesFound: result.candidatesFound,
      pagesFetched: evidence.pagesFetched,
      distinctPrices: evidence.distinctPrices,
      pagesWithReviews: evidence.pagesWithReviews,
      candidateUrls: evidence.candidateUrls.slice(0, 10),
    },
  });

  // A promising unsupported marketplace becomes a source CANDIDATE, not a
  // trusted source: it lands UNVERIFIED and must pass evaluateSource().
  if (result.promising && descriptor.marketplaceUrl) {
    try {
      await proposeSource({
        name: `${descriptor.label} marketplace`,
        kind: 'MARKETPLACE',
        baseUrl: descriptor.marketplaceUrl,
        ecosystem: name,
        reason: `generic exploration found ${result.candidatesFound} commercial pages`,
      });
    } catch (err) {
      logger.warn('could not register the probed marketplace as a source', {
        ecosystem: name,
        err: String(err),
      });
    }
  }

  if (result.adapterCandidate) {
    // Advisory only. A human reads this and decides. Nothing downstream of
    // here writes code, and `getAdapters()` is untouched.
    await recordAudit({
      entityType: 'system',
      eventType: 'DECISION',
      actor: PROBE_ACTOR,
      reason: ADAPTER_CANDIDATE_REASON,
      detail: {
        kind: ADAPTER_CANDIDATE_REASON,
        ecosystem: name,
        promisingProbes: promisingSoFar,
        threshold: ADAPTER_CANDIDATE_THRESHOLD,
        note: 'a human must decide whether to write an adapter; the system never writes one',
      },
    });
  }

  logger.info('ecosystem explored', {
    ecosystem: name,
    supported,
    candidatesFound: result.candidatesFound,
    promising: result.promising,
    adapterCandidate: result.adapterCandidate,
  });
  return result;
}
