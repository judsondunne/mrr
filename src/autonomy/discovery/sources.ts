/**
 * The source registry.
 *
 * Discovery is allowed to find NEW places to look. It is not allowed to
 * believe them. Anything discovered arrives UNVERIFIED and only a real probe
 * — accessibility, stability, usefulness, evidence quality, cost — can promote
 * it to VERIFIED.
 *
 * The load-bearing rule is `SOURCE_TRUST_CEILING`: trust is capped BY KIND, so
 * a scraped SEO listicle (OTHER) can never outrank a marketplace listing
 * (MARKETPLACE) no matter how well it probes. Primary commercial evidence wins
 * by construction, not by tuning.
 */
import { recordAudit } from '../../lib/audit';
import { getDb, toNumber, type Db } from '../../lib/db';
import { AppError, BudgetExceededError, FetchError } from '../../lib/errors';
import { politeFetch } from '../../lib/fetch';
import { newId } from '../../lib/hash';
import { createLogger } from '../../lib/logger';
import { htmlToText } from '../../pipeline/discovery/parse';
import { storeSourceDocument } from '../../pipeline/discovery/source-documents';
import type { SourceKind, SourceRecord, SourceStatus } from '../types';

const logger = createLogger('autonomy:sources');

// --- the trust ceiling -------------------------------------------------------

/**
 * Hard upper bound on `source_registry.trust_level`, by kind.
 *
 * MARKETPLACE is the only kind that may reach 1.0 because a marketplace
 * listing is primary commercial evidence: a price the vendor publishes and a
 * review count the platform counts. Everything else is secondary at best.
 * SEARCH sits mid-table on purpose — a search engine is a pointer to evidence,
 * never the evidence.
 */
export const SOURCE_TRUST_CEILING: Readonly<Record<SourceKind, number>> = {
  MARKETPLACE: 1.0,
  REVIEW_SITE: 0.8,
  MERCHANT_SITE: 0.7,
  SEARCH: 0.6,
  COMMUNITY: 0.5,
  OTHER: 0.35,
};

/** Where a proposed source starts. Below every ceiling, on purpose. */
export const UNVERIFIED_TRUST = 0.1;

/**
 * Probe quality required to be VERIFIED. Applied to the UNCAPPED probe score,
 * so a low-ceiling kind can still be a legitimate (if lowly trusted) source.
 */
export const MIN_PROBE_SCORE_FOR_VERIFIED = 0.4;

/** Cost per call at which a source scores zero on the cost dimension. */
export const MAX_ACCEPTABLE_COST_PER_CALL_USD = 0.05;

/** Cleaned text shorter than this means the page told us nothing. */
export const MIN_USEFUL_TEXT_CHARS = 400;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
function round(value: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}

/** PURE. Applies the per-kind ceiling. The only way trust is ever written. */
export function cappedTrust(kind: SourceKind, rawTrust: number): number {
  return round(Math.min(clamp(rawTrust, 0, 1), SOURCE_TRUST_CEILING[kind]), 3);
}

// --- rows --------------------------------------------------------------------

interface SourceRow {
  id: string;
  name: string;
  kind: string;
  base_url: string | null;
  ecosystem: string | null;
  status: string;
  trust_level: string | number;
  structured: boolean;
  cost_per_call: string | number;
  enabled: boolean;
}

const SOURCE_KINDS: readonly SourceKind[] = [
  'MARKETPLACE',
  'SEARCH',
  'MERCHANT_SITE',
  'REVIEW_SITE',
  'COMMUNITY',
  'OTHER',
];

export function isSourceKind(value: string): value is SourceKind {
  return (SOURCE_KINDS as readonly string[]).includes(value);
}

function readKind(value: string): SourceKind {
  return isSourceKind(value) ? value : 'OTHER';
}

function readStatus(value: string): SourceStatus {
  return value === 'VERIFIED' || value === 'REJECTED' || value === 'DISABLED' ? value : 'UNVERIFIED';
}

function toRecord(row: SourceRow): SourceRecord {
  return {
    id: row.id,
    name: row.name,
    kind: readKind(row.kind),
    baseUrl: row.base_url,
    ecosystem: row.ecosystem,
    status: readStatus(row.status),
    trustLevel: toNumber(row.trust_level, 0),
    structured: row.structured === true,
    enabled: row.enabled === true,
  };
}

const SELECT_SOURCE = `SELECT id, name, kind, base_url, ecosystem, status, trust_level,
         structured, cost_per_call, enabled
    FROM source_registry`;

export async function listSources(opts: { enabledOnly?: boolean } = {}): Promise<SourceRecord[]> {
  const db = await getDb();
  const where = opts.enabledOnly ? ' WHERE enabled' : '';
  const res = await db.query<SourceRow>(
    `${SELECT_SOURCE}${where} ORDER BY trust_level DESC, name ASC`,
  );
  return res.rows.map(toRecord);
}

async function readSource(db: Db, id: string): Promise<{ record: SourceRecord; costPerCall: number } | null> {
  const res = await db.query<SourceRow>(`${SELECT_SOURCE} WHERE id = $1`, [id]);
  const row = res.rows[0];
  if (!row) return null;
  return { record: toRecord(row), costPerCall: toNumber(row.cost_per_call, 0) };
}

export async function getSourceByName(name: string): Promise<SourceRecord | null> {
  const db = await getDb();
  const res = await db.query<SourceRow>(`${SELECT_SOURCE} WHERE name = $1`, [name]);
  const row = res.rows[0];
  return row ? toRecord(row) : null;
}

// --- seeding ------------------------------------------------------------------

interface SeedSource {
  name: string;
  kind: SourceKind;
  baseUrl: string | null;
  ecosystem: string | null;
  structured: boolean;
  costPerCall: number;
  notes: string;
}

/**
 * The sources the system already uses. These are declared in typed code by a
 * human, not proposed by a model, so they are VERIFIED at seed time — that is
 * exactly the distinction `proposeSource()` exists to preserve.
 *
 * Two of them are CLASSES of source rather than one site (any merchant's own
 * website, any public review page). They carry no base URL and are scored from
 * recorded performance instead of a probe.
 */
export const SEED_SOURCES: readonly SeedSource[] = [
  {
    name: 'Shopify App Store',
    kind: 'MARKETPLACE',
    baseUrl: 'https://apps.shopify.com',
    ecosystem: 'shopify',
    structured: true,
    costPerCall: 0,
    notes: 'Primary commercial evidence: published prices and platform-counted reviews.',
  },
  {
    name: 'Brave Search',
    kind: 'SEARCH',
    baseUrl: 'https://search.brave.com',
    ecosystem: null,
    structured: true,
    costPerCall: 0.005,
    notes: 'Discovery only. A pointer to evidence, never the evidence itself.',
  },
  {
    name: 'Public merchant websites',
    kind: 'MERCHANT_SITE',
    baseUrl: null,
    ecosystem: null,
    structured: false,
    costPerCall: 0,
    notes: 'A business stating in public what it does. Prospect evidence, not pricing proof.',
  },
  {
    name: 'Public review pages',
    kind: 'REVIEW_SITE',
    baseUrl: null,
    ecosystem: null,
    structured: false,
    costPerCall: 0,
    notes: 'Customers describing what they pay for. Corroborating, not primary.',
  },
  {
    name: 'Public competitor pages',
    kind: 'MERCHANT_SITE',
    baseUrl: null,
    ecosystem: null,
    structured: false,
    costPerCall: 0,
    notes: 'A vendor\'s own pricing and feature pages, outside a marketplace listing.',
  },
];

/** Idempotent: `source_registry.name` is UNIQUE. */
export async function seedSources(): Promise<{ created: number }> {
  const db = await getDb();
  let created = 0;

  for (const seed of SEED_SOURCES) {
    const res = await db.query<{ id: string }>(
      `INSERT INTO source_registry
         (id, name, kind, base_url, ecosystem, status, trust_level, structured,
          cost_per_call, notes)
       VALUES ($1,$2,$3,$4,$5,'VERIFIED',$6,$7,$8,$9)
       ON CONFLICT (name) DO NOTHING
       RETURNING id`,
      [
        newId('src'),
        seed.name,
        seed.kind,
        seed.baseUrl,
        seed.ecosystem,
        // A seeded source is trusted to its kind's ceiling and no further.
        cappedTrust(seed.kind, 1),
        seed.structured,
        seed.costPerCall,
        seed.notes,
      ],
    );
    if (res.rows[0]) created += 1;
  }

  if (created > 0) {
    await recordAudit({
      entityType: 'system',
      eventType: 'DECISION',
      actor: 'seed_sources',
      reason: 'registered the code-declared sources',
      detail: { created, names: SEED_SOURCES.map((s) => s.name) },
    });
  }
  logger.info('sources seeded', { created });
  return { created };
}

// --- proposing ------------------------------------------------------------------

/** Registers a candidate source as UNVERIFIED. Never trusted on sight. */
export async function proposeSource(params: {
  name: string;
  kind: SourceKind;
  baseUrl: string;
  ecosystem?: string | null;
  reason: string;
}): Promise<{ id: string; created: boolean }> {
  const name = params.name.trim().slice(0, 200);
  if (name.length < 2) {
    throw new AppError('a proposed source needs a name', 'SOURCE_INVALID', false, { name });
  }
  let parsed: URL;
  try {
    parsed = new URL(params.baseUrl);
  } catch {
    throw new AppError(`proposed source has an invalid base URL: ${params.baseUrl}`, 'SOURCE_INVALID');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new AppError(`proposed source must be http(s): ${params.baseUrl}`, 'SOURCE_INVALID');
  }

  const db = await getDb();
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO source_registry
       (id, name, kind, base_url, ecosystem, status, trust_level, structured, notes)
     VALUES ($1,$2,$3,$4,$5,'UNVERIFIED',$6,false,$7)
     ON CONFLICT (name) DO NOTHING
     RETURNING id`,
    [
      newId('src'),
      name,
      params.kind,
      parsed.origin,
      params.ecosystem ?? null,
      UNVERIFIED_TRUST,
      params.reason.slice(0, 500),
    ],
  );

  const row = inserted.rows[0];
  if (row) {
    await recordAudit({
      entityType: 'system',
      eventType: 'DECISION',
      actor: 'propose_source',
      reason: params.reason.slice(0, 500),
      detail: { sourceId: row.id, name, kind: params.kind, baseUrl: parsed.origin, status: 'UNVERIFIED' },
    });
    logger.info('source proposed', { name, kind: params.kind, status: 'UNVERIFIED' });
    return { id: row.id, created: true };
  }

  const existing = await db.query<{ id: string }>('SELECT id FROM source_registry WHERE name = $1', [name]);
  const found = existing.rows[0];
  if (!found) throw new AppError(`source ${name} conflicted but could not be read back`, 'SOURCE_INVALID');
  return { id: found.id, created: false };
}

// --- evaluating --------------------------------------------------------------------

export interface SourceProbe {
  accessible: boolean;
  httpStatus: number | null;
  textChars: number;
  /** False when this exact content was already on file — evidence of stability. */
  contentChanged: boolean;
  pricingMarkers: number;
  reviewMarkers: number;
  vendorMarkers: number;
  costPerCall: number;
  /** Verified categories + commitments already attributable to this source. */
  provenValue: number;
  error: string | null;
}

const PRICING_MARKER = /(\$\s?\d|\bper month\b|\/mo\b|\/month\b|\bpricing\b|\bprice\b|\bplan\b|\bsubscription\b|\bfree trial\b)/gi;
const REVIEW_MARKER = /(\breviews?\b|\bratings?\b|\bstars?\b|\btestimonial\b|\d+(?:\.\d)?\s*out of 5)/gi;
const VENDOR_MARKER = /(\bby [A-Z][\w&. -]{2,}|\bdeveloper\b|\bvendor\b|\bpublisher\b|\binstalls?\b|\bcustomers?\b)/g;

function countMatches(text: string, re: RegExp): number {
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

/**
 * PURE. Turns a probe into an UNCAPPED 0..1 quality score.
 *
 * Five deterministic dimensions: useful, stable, evidence-bearing, affordable,
 * and already-proven. Nothing here asks a model anything.
 */
export function scoreProbe(probe: SourceProbe): { score: number; notes: string } {
  if (!probe.accessible) {
    return { score: 0, notes: `not accessible: ${probe.error ?? 'fetch failed'}` };
  }
  const reasons: string[] = ['accessible'];

  const usefulness = clamp(probe.textChars / (MIN_USEFUL_TEXT_CHARS * 5), 0, 1);
  if (probe.textChars < MIN_USEFUL_TEXT_CHARS) reasons.push(`thin page (${probe.textChars} chars)`);

  // Stability: content we have seen before is a page that holds still. A page
  // that differs on every visit cannot support a durable claim.
  const stability = probe.contentChanged ? 0.8 : 1;
  if (!probe.contentChanged) reasons.push('content unchanged since last visit');

  const evidence = clamp(
    clamp(probe.pricingMarkers / 6, 0, 1) * 0.6 +
      clamp(probe.reviewMarkers / 4, 0, 1) * 0.25 +
      clamp(probe.vendorMarkers / 4, 0, 1) * 0.15,
    0,
    1,
  );
  if (probe.pricingMarkers > 0) reasons.push(`${probe.pricingMarkers} pricing markers`);
  if (probe.reviewMarkers > 0) reasons.push(`${probe.reviewMarkers} review markers`);
  if (evidence === 0) reasons.push('no commercial evidence on the page');

  const affordability = 1 - clamp(probe.costPerCall / MAX_ACCEPTABLE_COST_PER_CALL_USD, 0, 1);

  // Anything the source has already produced downstream counts for more than
  // any page inspection can.
  const proven = clamp(probe.provenValue / 3, 0, 1);
  if (probe.provenValue > 0) reasons.push(`${probe.provenValue} proven downstream outcomes`);

  const score =
    0.2 * usefulness + 0.15 * stability + 0.4 * evidence + 0.1 * affordability + 0.15 * proven;

  return { score: round(clamp(score, 0, 1), 5), notes: reasons.join('; ') };
}

async function probeSource(
  record: SourceRecord & { baseUrl: string },
  costPerCall: number,
): Promise<SourceProbe> {
  const provenValue = await provenOutcomes(record.id);
  const base: SourceProbe = {
    accessible: false,
    httpStatus: null,
    textChars: 0,
    contentChanged: true,
    pricingMarkers: 0,
    reviewMarkers: 0,
    vendorMarkers: 0,
    costPerCall,
    provenValue,
    error: null,
  };

  try {
    const res = await politeFetch(record.baseUrl);
    const text = htmlToText(res.body);
    const stored = await storeSourceDocument({
      url: record.baseUrl,
      sourceType: 'SEARCH_RESULT',
      text,
      httpStatus: res.status,
      metadata: { probe: 'source_evaluation', sourceId: record.id, finalUrl: res.finalUrl },
    });
    return {
      ...base,
      accessible: true,
      httpStatus: res.status,
      textChars: text.length,
      contentChanged: stored.isNew,
      pricingMarkers: countMatches(text, PRICING_MARKER),
      reviewMarkers: countMatches(text, REVIEW_MARKER),
      vendorMarkers: countMatches(text, VENDOR_MARKER),
    };
  } catch (err) {
    if (err instanceof BudgetExceededError) throw err;
    const message = err instanceof FetchError ? err.message : String(err);
    return { ...base, accessible: false, error: message.slice(0, 300) };
  }
}

async function provenOutcomes(sourceId: string): Promise<number> {
  const db = await getDb();
  const res = await db.query<{ verified: string | number; commitments: string | number }>(
    `SELECT COALESCE(SUM(categories_verified),0) AS verified,
            COALESCE(SUM(commitments),0) AS commitments
       FROM source_performance WHERE source_id = $1`,
    [sourceId],
  );
  const row = res.rows[0];
  return toNumber(row?.verified, 0) + toNumber(row?.commitments, 0);
}

/**
 * Probes a source and promotes it to VERIFIED or marks it REJECTED.
 *
 * The verdict uses the UNCAPPED probe score, so a genuinely useful COMMUNITY
 * or OTHER source can still be admitted — it just can never carry marketplace
 * trust, because `cappedTrust()` clamps it by kind.
 */
export async function evaluateSource(sourceId: string): Promise<{
  status: SourceRecord['status'];
  trustLevel: number;
  notes: string;
}> {
  const db = await getDb();
  const loaded = await readSource(db, sourceId);
  if (!loaded) throw new AppError(`no source ${sourceId}`, 'SOURCE_NOT_FOUND');
  const { record, costPerCall } = loaded;

  if (!record.baseUrl) return evaluateClassSource(db, record);

  const probe = await probeSource({ ...record, baseUrl: record.baseUrl }, costPerCall);
  const { score, notes } = scoreProbe(probe);
  const status: SourceStatus = score >= MIN_PROBE_SCORE_FOR_VERIFIED ? 'VERIFIED' : 'REJECTED';
  const trustLevel = status === 'VERIFIED' ? cappedTrust(record.kind, score) : 0;
  const summary = `${status}: probe ${score} (ceiling ${SOURCE_TRUST_CEILING[record.kind]}) — ${notes}`;

  await db.query(
    `UPDATE source_registry
        SET status = $2, trust_level = $3, evaluation_json = $4, notes = $5,
            last_success_at = CASE WHEN $6::boolean THEN now() ELSE last_success_at END,
            last_error = $7, updated_at = now()
      WHERE id = $1`,
    [
      sourceId,
      status,
      trustLevel,
      JSON.stringify({ probe, probeScore: score, ceiling: SOURCE_TRUST_CEILING[record.kind] }),
      summary.slice(0, 1000),
      probe.accessible === true,
      probe.error,
    ],
  );

  await recordAudit({
    entityType: 'system',
    eventType: status === 'VERIFIED' ? 'DECISION' : 'REJECTION',
    actor: 'evaluate_source',
    reason: summary.slice(0, 500),
    detail: { sourceId, name: record.name, kind: record.kind, probeScore: score, trustLevel, status },
  });

  logger.info('source evaluated', { name: record.name, status, trustLevel, probeScore: score });
  return { status, trustLevel, notes: summary };
}

/**
 * Some registered sources are a CLASS of site — any merchant's own website,
 * any public review page — and have no single address to fetch. There is
 * nothing to probe, so the verdict rests entirely on what they have actually
 * produced. Crucially this never DEMOTES such a source on the strength of a
 * probe it was never possible to run.
 */
async function evaluateClassSource(
  db: Db,
  record: SourceRecord,
): Promise<{ status: SourceRecord['status']; trustLevel: number; notes: string }> {
  const proven = await provenOutcomes(record.id);
  const status: SourceStatus = proven > 0 ? 'VERIFIED' : record.status;
  const trustLevel = status === 'VERIFIED' ? cappedTrust(record.kind, 1) : record.trustLevel;
  const summary =
    `${status}: no single address to probe; judged on ${proven} recorded downstream outcome(s) ` +
    `(ceiling ${SOURCE_TRUST_CEILING[record.kind]})`;

  await db.query(
    `UPDATE source_registry
        SET status = $2, trust_level = $3, evaluation_json = $4, notes = $5, updated_at = now()
      WHERE id = $1`,
    [
      record.id,
      status,
      trustLevel,
      JSON.stringify({ probeable: false, provenValue: proven, ceiling: SOURCE_TRUST_CEILING[record.kind] }),
      summary.slice(0, 1000),
    ],
  );

  await recordAudit({
    entityType: 'system',
    eventType: 'DECISION',
    actor: 'evaluate_source',
    reason: summary.slice(0, 500),
    detail: { sourceId: record.id, name: record.name, kind: record.kind, provenValue: proven, status },
  });

  logger.info('class source evaluated', { name: record.name, status, trustLevel, proven });
  return { status, trustLevel, notes: summary };
}

// --- performance -----------------------------------------------------------------------

/** Value of one downstream outcome, in "useful things per dollar" terms. */
export const YIELD_WEIGHTS = {
  categoryVerified: 1,
  commitment: 3,
} as const;

/** Spend floor so a free source is not infinitely productive. */
export const MIN_COST_BASIS_USD = 0.01;

/** Yield cannot exceed this; the column is NUMERIC(8,5). */
export const MAX_YIELD_SCORE = 100;

export interface SourcePerformance {
  fetches: number;
  failures: number;
  candidatesFound: number;
  categoriesVerified: number;
  commitments: number;
  spendUsd: number;
}

/**
 * PURE. Verified categories and commitments per dollar, discounted by how
 * often the source simply fails.
 */
export function computeYieldScore(p: SourcePerformance): number {
  const value =
    YIELD_WEIGHTS.categoryVerified * Math.max(0, p.categoriesVerified) +
    YIELD_WEIGHTS.commitment * Math.max(0, p.commitments);
  const cost = Math.max(p.spendUsd, MIN_COST_BASIS_USD);
  const reliability = p.fetches > 0 ? clamp(1 - p.failures / p.fetches, 0, 1) : 1;
  return round(clamp((value / cost) * reliability, 0, MAX_YIELD_SCORE), 5);
}

interface PerformanceRow {
  id: string;
  fetches: number;
  failures: number;
  candidates_found: number;
  categories_verified: number;
  commitments: number;
  spend_usd: string | number;
}

/**
 * Accumulates into the source's rolling performance row and recomputes its
 * deterministic yield score, so the supervisor can prefer what actually works.
 */
export async function recordSourceOutcome(params: {
  sourceId: string;
  fetches?: number;
  failures?: number;
  candidatesFound?: number;
  categoriesVerified?: number;
  commitments?: number;
  spendUsd?: number;
}): Promise<void> {
  const db = await getDb();
  await db.transaction(async (tx) => {
    const exists = await tx.query<{ id: string }>('SELECT id FROM source_registry WHERE id = $1', [
      params.sourceId,
    ]);
    if (!exists.rows[0]) {
      logger.warn('outcome recorded for an unknown source', { sourceId: params.sourceId });
      return;
    }

    const current = await tx.query<PerformanceRow>(
      `SELECT id, fetches, failures, candidates_found, categories_verified, commitments, spend_usd
         FROM source_performance WHERE source_id = $1 ORDER BY captured_at DESC LIMIT 1`,
      [params.sourceId],
    );
    const row = current.rows[0];

    const next: SourcePerformance = {
      fetches: Number(row?.fetches ?? 0) + Math.max(0, Math.trunc(params.fetches ?? 0)),
      failures: Number(row?.failures ?? 0) + Math.max(0, Math.trunc(params.failures ?? 0)),
      candidatesFound:
        Number(row?.candidates_found ?? 0) + Math.max(0, Math.trunc(params.candidatesFound ?? 0)),
      categoriesVerified:
        Number(row?.categories_verified ?? 0) + Math.max(0, Math.trunc(params.categoriesVerified ?? 0)),
      commitments: Number(row?.commitments ?? 0) + Math.max(0, Math.trunc(params.commitments ?? 0)),
      spendUsd: toNumber(row?.spend_usd, 0) + Math.max(0, params.spendUsd ?? 0),
    };
    const yieldScore = computeYieldScore(next);

    if (row) {
      await tx.query(
        `UPDATE source_performance
            SET fetches = $2, failures = $3, candidates_found = $4, categories_verified = $5,
                commitments = $6, spend_usd = $7, yield_score = $8, captured_at = now()
          WHERE id = $1`,
        [
          row.id,
          next.fetches,
          next.failures,
          next.candidatesFound,
          next.categoriesVerified,
          next.commitments,
          next.spendUsd,
          yieldScore,
        ],
      );
    } else {
      await tx.query(
        `INSERT INTO source_performance
           (id, source_id, fetches, failures, candidates_found, categories_verified,
            commitments, spend_usd, yield_score)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          newId('sperf'),
          params.sourceId,
          next.fetches,
          next.failures,
          next.candidatesFound,
          next.categoriesVerified,
          next.commitments,
          next.spendUsd,
          yieldScore,
        ],
      );
    }

    if (next.fetches > next.failures) {
      await tx.query('UPDATE source_registry SET last_success_at = now() WHERE id = $1', [
        params.sourceId,
      ]);
    }
  });
}

/** Current yield score for a source, or 0 when it has produced nothing yet. */
export async function sourceYield(sourceId: string): Promise<number> {
  const db = await getDb();
  const res = await db.query<{ yield_score: string | number }>(
    'SELECT yield_score FROM source_performance WHERE source_id = $1 ORDER BY captured_at DESC LIMIT 1',
    [sourceId],
  );
  return toNumber(res.rows[0]?.yield_score, 0);
}
