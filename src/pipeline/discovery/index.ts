/**
 * PUBLIC API — DISCOVERY LAYER. Owned by the discovery agent.
 * Signatures here are the integration contract; callers depend on them.
 */
import { getConfig } from '../../lib/config.js';
import { getDb } from '../../lib/db.js';
import { BudgetExceededError } from '../../lib/errors.js';
import { contentHash, newId, slugify } from '../../lib/hash.js';
import { createLogger } from '../../lib/logger.js';
import { recordAudit } from '../../lib/audit.js';
import type {
  DiscoveredCandidate,
  EvidenceExtractor,
  ExtractedCompetitor,
  ExtractedReview,
  MarketplaceAdapter,
} from '../../lib/contracts.js';
import { readCompetitorEvidenceJson } from '../verification/evidence.js';
import { shopifyAdapter, type ExtractContext } from './shopify.js';
import { linkSourceDocuments } from './source-documents.js';

const logger = createLogger('discovery');

export interface DiscoverResult {
  candidatesFound: number;
  opportunitiesCreated: number;
  duplicatesSkipped: number;
  opportunityIds: string[];
}

const ADAPTERS: readonly MarketplaceAdapter[] = [shopifyAdapter];

/** Registry of ecosystem adapters. Shopify is the only MVP entry. */
export function getAdapters(): MarketplaceAdapter[] {
  return [...ADAPTERS];
}

export function getAdapter(ecosystem: string): MarketplaceAdapter | null {
  const key = ecosystem.trim().toLowerCase();
  return ADAPTERS.find((a) => a.ecosystem.toLowerCase() === key) ?? null;
}

// --- persistence -------------------------------------------------------------

export function dedupeKeyFor(ecosystem: string, category: string): string {
  return `${ecosystem.trim().toLowerCase()}:${slugify(category)}`;
}

interface UpsertedOpportunity {
  id: string;
  created: boolean;
}

/**
 * Idempotent by `opportunities.dedupe_key` (UNIQUE). Re-running discovery
 * creates zero duplicates: the conflicting insert returns no row and we read
 * back the existing id.
 */
async function upsertOpportunity(candidate: DiscoveredCandidate): Promise<UpsertedOpportunity> {
  const db = await getDb();
  const key = dedupeKeyFor(candidate.ecosystem, candidate.category);

  const inserted = await db.query<{ id: string }>(
    `INSERT INTO opportunities
       (id, name, ecosystem, category, description, source_url, state, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,'DISCOVERED',$7)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [
      newId('opp'),
      candidate.name.slice(0, 200),
      candidate.ecosystem,
      candidate.category,
      candidate.description.slice(0, 2000),
      candidate.sourceUrl,
      key,
    ],
  );

  const row = inserted.rows[0];
  if (row) return { id: row.id, created: true };

  const existing = await db.query<{ id: string }>(
    'SELECT id FROM opportunities WHERE dedupe_key = $1',
    [key],
  );
  const found = existing.rows[0];
  if (!found) {
    // Should be unreachable: the insert conflicted, so the row exists.
    throw new Error(`opportunity with dedupe_key ${key} conflicted but could not be read back`);
  }
  return { id: found.id, created: false };
}

function normalizeDate(raw: string | null): string | null {
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

async function upsertCompetitor(
  opportunityId: string,
  competitor: ExtractedCompetitor,
): Promise<string | null> {
  const db = await getDb();
  const evidenceJson = readCompetitorEvidenceJson(
    (competitor as { evidenceJson?: unknown }).evidenceJson,
  );

  const res = await db.query<{ id: string }>(
    `INSERT INTO competitors
       (id, opportunity_id, name, url, current_pricing, free_plan_details,
        has_permanent_free_tier, review_count, rating, launch_age,
        evidence_json, payment_evidence_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (opportunity_id, url) DO UPDATE SET
       name = EXCLUDED.name,
       current_pricing = EXCLUDED.current_pricing,
       free_plan_details = EXCLUDED.free_plan_details,
       has_permanent_free_tier = EXCLUDED.has_permanent_free_tier,
       review_count = EXCLUDED.review_count,
       rating = EXCLUDED.rating,
       launch_age = EXCLUDED.launch_age,
       evidence_json = EXCLUDED.evidence_json,
       payment_evidence_json = EXCLUDED.payment_evidence_json
     RETURNING id`,
    [
      newId('cmp'),
      opportunityId,
      competitor.name.slice(0, 200),
      competitor.url,
      competitor.currentPricing,
      competitor.freePlanDetails,
      competitor.hasPermanentFreeTier,
      competitor.reviewCount,
      competitor.rating,
      competitor.launchAge,
      JSON.stringify(evidenceJson),
      JSON.stringify(competitor.evidence),
    ],
  );
  return res.rows[0]?.id ?? null;
}

/**
 * `EvidenceExtractor.extractCompetitor` is pinned to one argument by
 * `contracts.ts`, but an adapter may accept an optional context so its source
 * documents can be linked to the opportunity. Passing an extra argument to an
 * implementation that ignores it is harmless, so this is the one place we
 * widen the signature — deliberately, and in a single spot.
 */
type ContextualExtract = (url: string, ctx?: ExtractContext) => Promise<ExtractedCompetitor | null>;

function extractWithContext(
  extractor: EvidenceExtractor,
  url: string,
  ctx: ExtractContext,
): Promise<ExtractedCompetitor | null> {
  const fn = extractor.extractCompetitor.bind(extractor) as ContextualExtract;
  return fn(url, ctx);
}

async function insertReviews(competitorId: string, reviews: ExtractedReview[]): Promise<number> {
  if (reviews.length === 0) return 0;
  const db = await getDb();
  let inserted = 0;
  for (const review of reviews) {
    try {
      const res = await db.query<{ id: string }>(
        `INSERT INTO reviews
           (id, competitor_id, source_url, rating, review_date, merchant_name,
            merchant_domain_if_public, usage_duration, text, payment_signal,
            complaint_tags, content_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (competitor_id, content_hash) DO NOTHING
         RETURNING id`,
        [
          newId('rev'),
          competitorId,
          review.sourceUrl,
          review.rating,
          normalizeDate(review.reviewDate),
          review.merchantName,
          review.merchantDomainIfPublic,
          review.usageDuration,
          review.text.slice(0, 4000),
          review.paymentSignal,
          JSON.stringify(review.complaintTags),
          contentHash(review.text),
        ],
      );
      if (res.rows[0]) inserted += 1;
    } catch (err) {
      logger.warn('skipping unstorable review', { competitorId, err: String(err) });
    }
  }
  return inserted;
}

async function competitorCount(opportunityId: string): Promise<number> {
  const db = await getDb();
  const res = await db.query<{ n: string | number }>(
    'SELECT COUNT(*) AS n FROM competitors WHERE opportunity_id = $1',
    [opportunityId],
  );
  return Number(res.rows[0]?.n ?? 0);
}

// --- the pass ----------------------------------------------------------------

/**
 * Runs one discovery pass. Idempotent: re-running creates no duplicates.
 *
 * An opportunity that already exists AND already has competitor rows is not
 * re-enriched here — refreshing competitor data is a separate concern, and
 * re-fetching every listing on every pass would burn the fetch budget for
 * nothing.
 *
 * KILL_SWITCH is treated as "skip", not "fail": it is a deliberate stop, so
 * the pass returns zeros instead of raising.
 */
export async function discoverOpportunities(limit: number): Promise<DiscoverResult> {
  const cfg = getConfig();
  const result: DiscoverResult = {
    candidatesFound: 0,
    opportunitiesCreated: 0,
    duplicatesSkipped: 0,
    opportunityIds: [],
  };

  if (cfg.killSwitch) {
    logger.warn('KILL_SWITCH is on; discovery skipped');
    return result;
  }

  const cap = Math.max(0, Math.min(limit, cfg.discoveryCandidatesPerDay));
  if (cap === 0) return result;

  for (const adapter of ADAPTERS) {
    if (result.candidatesFound >= cap) break;

    let candidates: DiscoveredCandidate[];
    try {
      candidates = await adapter.source.discover(cap - result.candidatesFound);
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        logger.warn('budget exhausted during discovery', { ecosystem: adapter.ecosystem });
        break;
      }
      logger.error('adapter discovery failed', { ecosystem: adapter.ecosystem, err: String(err) });
      continue;
    }

    for (const candidate of candidates) {
      if (result.candidatesFound >= cap) break;
      result.candidatesFound += 1;

      let upserted: UpsertedOpportunity;
      try {
        upserted = await upsertOpportunity(candidate);
      } catch (err) {
        logger.error('failed to persist opportunity', { category: candidate.category, err: String(err) });
        continue;
      }

      result.opportunityIds.push(upserted.id);
      if (upserted.created) result.opportunitiesCreated += 1;
      else result.duplicatesSkipped += 1;

      await linkSourceDocuments([candidate.sourceUrl], upserted.id);

      const existingCompetitors = await competitorCount(upserted.id);
      if (!upserted.created && existingCompetitors > 0) {
        logger.debug('opportunity already enriched; skipping re-extraction', {
          opportunityId: upserted.id,
          category: candidate.category,
        });
        continue;
      }

      const ctx: ExtractContext = { opportunityId: upserted.id };
      let competitorsStored = 0;
      let reviewsStored = 0;

      for (const url of candidate.competitorUrls) {
        let extracted: ExtractedCompetitor | null;
        try {
          extracted = await extractWithContext(adapter.extractor, url, ctx);
        } catch (err) {
          // Deliberate asymmetry: a spent SEARCH budget just ends the pass
          // early (nothing was lost), but a spent LLM budget propagates so the
          // job halts loudly and the COST_LIMIT notification fires.
          if (err instanceof BudgetExceededError) throw err;
          logger.error('competitor extraction failed', { url, err: String(err) });
          continue;
        }
        if (!extracted) continue;

        const competitorId = await upsertCompetitor(upserted.id, extracted);
        if (!competitorId) continue;
        competitorsStored += 1;
        reviewsStored += await insertReviews(competitorId, extracted.reviews);
      }

      await recordAudit({
        entityType: 'opportunity',
        entityId: upserted.id,
        eventType: 'DECISION',
        actor: 'discover_opportunities',
        reason: upserted.created ? 'discovered' : 'already known',
        detail: {
          ecosystem: candidate.ecosystem,
          category: candidate.category,
          sourceUrl: candidate.sourceUrl,
          competitorUrls: candidate.competitorUrls,
          competitorsStored,
          reviewsStored,
        },
      });
    }
  }

  logger.info('discovery pass complete', {
    candidatesFound: result.candidatesFound,
    created: result.opportunitiesCreated,
    duplicates: result.duplicatesSkipped,
  });
  return result;
}

export type { DiscoveredCandidate };

// Re-exported so other layers use the budgeted, cached research path.
export { research } from './brave-research.js';
export type { ResearchOptions, ResearchPage, ResearchResult } from './brave-research.js';
export { storeSourceDocument, isKnownContent, linkSourceDocuments } from './source-documents.js';
export type { SourceType, StoredSourceDocument } from './source-documents.js';
export {
  shopifyAdapter,
  ShopifyOpportunitySource,
  ShopifyEvidenceExtractor,
  ShopifyProspectFinder,
  SHOPIFY_SEED_CATEGORIES,
  normalizeListingUrl,
  reviewsUrl,
} from './shopify.js';
export type { SeedCategory, ExtractContext } from './shopify.js';
export { parseAppListing, parseReviews, htmlToText } from './parse.js';
