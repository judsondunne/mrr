/**
 * PUBLIC API — EVIDENCE PROVENANCE + STALENESS. Owned by the evidence agent.
 *
 * Every material factual claim that reaches an owner notification or a build
 * spec must be traceable to a stored source. Inferred facts stay marked as
 * inferred; they never silently become confirmed facts.
 *
 * Three rules are enforced here and nowhere else:
 *
 *   1. TRACEABILITY. A claim is usable only when it carries the exact text it
 *      was read from (`evidence_excerpt`) and a hash of that text
 *      (`content_hash`), so any reader can re-check it against the row or page
 *      it came from. `source_url` is recorded whenever the fact came from the
 *      web; its absence does not make a first-party row untraceable, because
 *      the excerpt plus the hash IS the trace for a row we wrote ourselves.
 *
 *   2. STALENESS. Evidence expires. TTLs come from `config.evidence` and are
 *      applied per claim type: competitor pricing must be refreshed before
 *      final validation, platform capability before a build recommendation,
 *      prospect evidence before outreach if it is old. A COMMITMENT never
 *      expires — "this company said this on this date" is a historical event,
 *      not a fact about the present.
 *
 *   3. INFERENCE. `inferred = true` means nobody observed this; we concluded
 *      it. An inferred claim can never satisfy a requirement that asks for a
 *      confirmed one, and every renderer that shows it must show the flag.
 *
 * Refresh honesty: `refreshStaleEvidence` does not re-stamp a claim just
 * because it is old. It re-derives from the current database rows and accepts
 * the refresh ONLY when the underlying source was observed AFTER the stale
 * claim was last checked. Otherwise nothing was actually re-fetched, and the
 * claim stays stale.
 */
import { getConfig } from '../lib/config';
import { getDb, toNumber } from '../lib/db';
import { contentHash, newId } from '../lib/hash';
import { createLogger } from '../lib/logger';

const logger = createLogger('autonomy:provenance');

export type ClaimType =
  | 'COMPETITOR_PRICING'
  | 'MERCHANT_BEHAVIOUR'
  | 'CUSTOMER_COMPLAINT'
  | 'PLATFORM_CAPABILITY'
  | 'PROSPECT_IDENTITY'
  | 'COMMITMENT';

export interface EvidenceClaim {
  id: string;
  opportunityId: string | null;
  claimType: ClaimType;
  claimText: string;
  sourceUrl: string | null;
  fetchedAt: Date | null;
  contentHash: string | null;
  evidenceExcerpt: string | null;
  extractionModel: string | null;
  promptVersion: number | null;
  confidence: number | null;
  expiresAt: Date | null;
  inferred: boolean;
}

export const CLAIM_TYPES: readonly ClaimType[] = [
  'COMPETITOR_PRICING',
  'MERCHANT_BEHAVIOUR',
  'CUSTOMER_COMPLAINT',
  'PLATFORM_CAPABILITY',
  'PROSPECT_IDENTITY',
  'COMMITMENT',
];

/**
 * The claim types a build recommendation cannot be made without.
 *
 * Deliberately short. These two are the facts the owner would act on and could
 * not check for themselves: what the incumbents charge today, and whether the
 * platform can still do the thing the wedge depends on.
 */
export const REQUIRED_FOR_BUILD_RECOMMENDATION: readonly ClaimType[] = [
  'COMPETITOR_PRICING',
  'PLATFORM_CAPABILITY',
];

export const MAX_EXCERPT_CHARS = 600;

/** TTL per claim type, in hours. `null` means the fact is historical and never expires. */
export function ttlHoursFor(claimType: ClaimType): number | null {
  const evidence = getConfig().evidence;
  switch (claimType) {
    case 'COMPETITOR_PRICING':
      return evidence.pricingTtlHours;
    case 'PLATFORM_CAPABILITY':
      return evidence.platformCapabilityTtlHours;
    case 'PROSPECT_IDENTITY':
    case 'MERCHANT_BEHAVIOUR':
      return evidence.prospectTtlHours;
    case 'CUSTOMER_COMPLAINT':
      return evidence.platformCapabilityTtlHours;
    case 'COMMITMENT':
      return null;
  }
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function excerptOf(text: string): string {
  const normalized = normalize(text);
  return normalized.length <= MAX_EXCERPT_CHARS ? normalized : normalized.slice(0, MAX_EXCERPT_CHARS);
}

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

interface ClaimRow {
  id: string;
  opportunity_id: string | null;
  claim_type: string;
  claim_text: string;
  source_url: string | null;
  fetched_at: string | Date | null;
  content_hash: string | null;
  evidence_excerpt: string | null;
  extraction_model: string | null;
  prompt_version: number | null;
  confidence: string | number | null;
  expires_at: string | Date | null;
  inferred: boolean;
}

function mapClaim(row: ClaimRow): EvidenceClaim {
  return {
    id: row.id,
    opportunityId: row.opportunity_id,
    claimType: row.claim_type as ClaimType,
    claimText: row.claim_text,
    sourceUrl: row.source_url,
    fetchedAt: toDate(row.fetched_at),
    contentHash: row.content_hash,
    evidenceExcerpt: row.evidence_excerpt,
    extractionModel: row.extraction_model,
    promptVersion: row.prompt_version === null ? null : Number(row.prompt_version),
    confidence: row.confidence === null ? null : toNumber(row.confidence, 0),
    expiresAt: toDate(row.expires_at),
    inferred: row.inferred === true,
  };
}

const SELECT_CLAIM = `SELECT id, opportunity_id, claim_type, claim_text, source_url, fetched_at,
                             content_hash, evidence_excerpt, extraction_model, prompt_version,
                             confidence, expires_at, inferred
                        FROM evidence_claims`;

// --- recording ---------------------------------------------------------------

export interface RecordClaimParams {
  opportunityId: string | null;
  claimType: ClaimType;
  claimText: string;
  sourceUrl?: string | null;
  sourceDocumentId?: string | null;
  evidenceExcerpt?: string | null;
  extractionModel?: string | null;
  promptVersion?: number | null;
  confidence?: number | null;
  inferred?: boolean;
}

/**
 * Stores one traceable claim.
 *
 * Idempotent by content: re-observing the same (opportunity, type, text,
 * source, inferred-flag) updates the existing row's fetch time and expiry
 * rather than growing a duplicate. That is exactly what "we checked again and
 * it still says this" means, and it makes every caller safe to re-run.
 */
export async function recordClaim(params: {
  opportunityId: string | null;
  claimType: ClaimType;
  claimText: string;
  sourceUrl?: string | null;
  sourceDocumentId?: string | null;
  evidenceExcerpt?: string | null;
  extractionModel?: string | null;
  promptVersion?: number | null;
  confidence?: number | null;
  inferred?: boolean;
}): Promise<EvidenceClaim> {
  const db = await getDb();
  const claimText = normalize(params.claimText);
  const excerpt = excerptOf(params.evidenceExcerpt ?? params.claimText);
  const hash = contentHash(excerpt.length > 0 ? excerpt : claimText);
  const inferred = params.inferred === true;
  const sourceUrl = params.sourceUrl ?? null;
  const ttl = ttlHoursFor(params.claimType);
  const expiresAt = ttl === null ? null : new Date(Date.now() + ttl * 3600_000).toISOString();

  const existing = await db.query<ClaimRow>(
    `${SELECT_CLAIM}
      WHERE opportunity_id IS NOT DISTINCT FROM $1
        AND claim_type = $2
        AND claim_text = $3
        AND source_url IS NOT DISTINCT FROM $4
        AND inferred = $5
        AND superseded_by IS NULL
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [params.opportunityId, params.claimType, claimText, sourceUrl, inferred],
  );

  const prior = existing.rows[0];
  if (prior) {
    const updated = await db.query<ClaimRow>(
      `UPDATE evidence_claims
          SET fetched_at = now(),
              expires_at = $2,
              content_hash = $3,
              evidence_excerpt = $4,
              extraction_model = COALESCE($5, extraction_model),
              prompt_version = COALESCE($6, prompt_version),
              confidence = COALESCE($7, confidence),
              source_document_id = COALESCE($8, source_document_id)
        WHERE id = $1
        RETURNING id, opportunity_id, claim_type, claim_text, source_url, fetched_at,
                  content_hash, evidence_excerpt, extraction_model, prompt_version,
                  confidence, expires_at, inferred`,
      [
        prior.id,
        expiresAt,
        hash,
        excerpt,
        params.extractionModel ?? null,
        params.promptVersion ?? null,
        params.confidence ?? null,
        params.sourceDocumentId ?? null,
      ],
    );
    const row = updated.rows[0];
    if (row) return mapClaim(row);
  }

  const id = newId('clm');
  const inserted = await db.query<ClaimRow>(
    `INSERT INTO evidence_claims
       (id, opportunity_id, claim_type, claim_text, source_url, source_document_id,
        fetched_at, content_hash, evidence_excerpt, extraction_model, prompt_version,
        confidence, expires_at, inferred)
     VALUES ($1,$2,$3,$4,$5,$6, now(), $7,$8,$9,$10,$11,$12,$13)
     RETURNING id, opportunity_id, claim_type, claim_text, source_url, fetched_at,
               content_hash, evidence_excerpt, extraction_model, prompt_version,
               confidence, expires_at, inferred`,
    [
      id,
      params.opportunityId,
      params.claimType,
      claimText,
      sourceUrl,
      params.sourceDocumentId ?? null,
      hash,
      excerpt,
      params.extractionModel ?? null,
      params.promptVersion ?? null,
      params.confidence ?? null,
      expiresAt,
      inferred,
    ],
  );

  const row = inserted.rows[0];
  if (!row) throw new Error(`failed to record ${params.claimType} claim`);
  return mapClaim(row);
}

// --- reading -----------------------------------------------------------------

export async function claimsFor(
  opportunityId: string,
  claimType?: ClaimType,
): Promise<EvidenceClaim[]> {
  const db = await getDb();
  const res = claimType
    ? await db.query<ClaimRow>(
        `${SELECT_CLAIM}
          WHERE opportunity_id = $1 AND claim_type = $2 AND superseded_by IS NULL
          ORDER BY created_at ASC, id ASC`,
        [opportunityId, claimType],
      )
    : await db.query<ClaimRow>(
        `${SELECT_CLAIM}
          WHERE opportunity_id = $1 AND superseded_by IS NULL
          ORDER BY created_at ASC, id ASC`,
        [opportunityId],
      );
  return res.rows.map(mapClaim);
}

/** True when the claim carries the text it came from and a hash of that text. */
export function claimIsTraceable(claim: EvidenceClaim): boolean {
  return (
    typeof claim.evidenceExcerpt === 'string' &&
    claim.evidenceExcerpt.trim().length > 0 &&
    typeof claim.contentHash === 'string' &&
    claim.contentHash.length > 0
  );
}

export function claimIsExpired(claim: EvidenceClaim, now: Date = new Date()): boolean {
  return claim.expiresAt !== null && claim.expiresAt.getTime() <= now.getTime();
}

/**
 * A claim may be treated as an established fact only when it was observed
 * (not inferred), can be traced back to its source text, and has not expired.
 */
export function claimIsConfirmed(claim: EvidenceClaim, now: Date = new Date()): boolean {
  return !claim.inferred && claimIsTraceable(claim) && !claimIsExpired(claim, now);
}

/**
 * How a claim must be attributed wherever it is shown. An inferred claim is
 * always labelled INFERRED, so no renderer can present it as observed fact.
 */
export function claimAttribution(claim: EvidenceClaim, now: Date = new Date()): string {
  if (claim.inferred) return 'INFERRED (not confirmed)';
  if (!claimIsTraceable(claim)) return 'UNTRACEABLE (no stored source text)';
  if (claimIsExpired(claim, now)) return 'STALE (past its refresh window)';
  return 'CONFIRMED';
}

/** Claims past their TTL. Must be refreshed before a build recommendation. */
export async function staleClaims(opportunityId: string): Promise<EvidenceClaim[]> {
  const db = await getDb();
  const res = await db.query<ClaimRow>(
    `${SELECT_CLAIM}
      WHERE opportunity_id = $1
        AND superseded_by IS NULL
        AND expires_at IS NOT NULL
        AND expires_at <= now()
      ORDER BY expires_at ASC, id ASC`,
    [opportunityId],
  );
  return res.rows.map(mapClaim);
}

/**
 * Gate helper: true only when every claim required for a build recommendation
 * is present, traceable and unexpired.
 *
 * `missing` means there is no confirmed claim of that type at all — including
 * the case where the only claims we hold are inferred or untraceable, because
 * neither of those is evidence. `stale` means we did have one and it expired.
 */
export async function evidenceIsCurrent(opportunityId: string): Promise<{
  current: boolean;
  missing: ClaimType[];
  stale: ClaimType[];
}> {
  const claims = await claimsFor(opportunityId);
  const now = new Date();
  const missing: ClaimType[] = [];
  const stale: ClaimType[] = [];

  for (const claimType of REQUIRED_FOR_BUILD_RECOMMENDATION) {
    const ofType = claims.filter((c) => c.claimType === claimType);
    if (ofType.some((c) => claimIsConfirmed(c, now))) continue;
    const observedButExpired = ofType.filter(
      (c) => !c.inferred && claimIsTraceable(c) && claimIsExpired(c, now),
    );
    if (observedButExpired.length > 0) stale.push(claimType);
    else missing.push(claimType);
  }

  return { current: missing.length === 0 && stale.length === 0, missing, stale };
}

// --- derivation from the rows the rest of the system already wrote -----------

/**
 * A claim the current database rows support, with the moment the underlying
 * source was last observed. `observedAt` is what makes a refresh honest: the
 * source must have been re-read since we last checked.
 */
export interface DerivedClaim extends RecordClaimParams {
  observedAt: Date;
}

interface CompetitorRow {
  id: string;
  name: string;
  url: string;
  current_pricing: string | null;
  has_permanent_free_tier: boolean | null;
  payment_evidence_json: unknown;
  created_at: string | Date;
}

interface ReviewRow {
  id: string;
  source_url: string;
  text: string;
  payment_signal: string | null;
  merchant_name: string | null;
  created_at: string | Date;
}

interface CommitmentRow {
  id: string;
  company_key: string;
  type: string;
  evidence_text: string;
  evidence_url: string | null;
  price_monthly: string | number | null;
  created_at: string | Date;
}

interface DocRow {
  id: string;
  url: string;
  fetched_at: string | Date;
}

function parsePaymentEvidence(value: unknown): Array<{ type: string; sourceUrl: string; quote: string; confidence: string }> {
  const raw = typeof value === 'string' ? safeJson(value) : value;
  if (!Array.isArray(raw)) return [];
  const out: Array<{ type: string; sourceUrl: string; quote: string; confidence: string }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;
    const type = typeof obj.type === 'string' ? obj.type : null;
    const sourceUrl = typeof obj.sourceUrl === 'string' ? obj.sourceUrl : null;
    if (!type || !sourceUrl) continue;
    out.push({
      type,
      sourceUrl,
      quote: typeof obj.quote === 'string' ? normalize(obj.quote) : '',
      confidence: typeof obj.confidence === 'string' ? obj.confidence.toUpperCase() : 'UNKNOWN',
    });
  }
  return out;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function confidenceScore(label: string): number {
  if (label === 'HIGH') return 0.9;
  if (label === 'MEDIUM') return 0.6;
  if (label === 'LOW') return 0.3;
  return 0.5;
}

function readWedgeCapabilities(wedgeJson: unknown): string[] {
  const raw = typeof wedgeJson === 'string' ? safeJson(wedgeJson) : wedgeJson;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const value = (raw as Record<string, unknown>).capabilities;
  if (!Array.isArray(value)) return [];
  return value
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map((x) => x.trim());
}

/**
 * Every claim the CURRENT rows support, derived deterministically.
 *
 * This is the backfill: an opportunity created before provenance existed still
 * has competitors, reviews and commitments, and each of those rows is a source
 * in its own right. Nothing here invents a fact, and nothing here reaches the
 * network — it reads what has already been stored.
 */
export async function deriveClaims(opportunityId: string): Promise<DerivedClaim[]> {
  const db = await getDb();
  const out: DerivedClaim[] = [];

  const docs = await db.query<DocRow>(
    `SELECT id, url, fetched_at FROM source_documents
      WHERE opportunity_id = $1 ORDER BY fetched_at DESC, id DESC`,
    [opportunityId],
  );
  const docByUrl = new Map<string, DocRow>();
  for (const doc of docs.rows) if (!docByUrl.has(doc.url)) docByUrl.set(doc.url, doc);

  const observedFor = (url: string | null, fallback: Date): { at: Date; documentId: string | null } => {
    const doc = url ? docByUrl.get(url) : undefined;
    if (!doc) return { at: fallback, documentId: null };
    const at = toDate(doc.fetched_at) ?? fallback;
    return { at: at > fallback ? at : fallback, documentId: doc.id };
  };

  // 1. competitors -> COMPETITOR_PRICING
  const competitors = await db.query<CompetitorRow>(
    `SELECT id, name, url, current_pricing, has_permanent_free_tier, payment_evidence_json, created_at
       FROM competitors WHERE opportunity_id = $1 ORDER BY created_at ASC, id ASC`,
    [opportunityId],
  );
  for (const competitor of competitors.rows) {
    const createdAt = toDate(competitor.created_at) ?? new Date(0);
    if (competitor.current_pricing && competitor.current_pricing.trim().length > 0) {
      const seen = observedFor(competitor.url, createdAt);
      out.push({
        opportunityId,
        claimType: 'COMPETITOR_PRICING',
        claimText: `${competitor.name} lists pricing: ${normalize(competitor.current_pricing)}`,
        sourceUrl: competitor.url,
        sourceDocumentId: seen.documentId,
        evidenceExcerpt: normalize(competitor.current_pricing),
        confidence: 0.9,
        inferred: false,
        observedAt: seen.at,
      });
    }
    for (const evidence of parsePaymentEvidence(competitor.payment_evidence_json)) {
      if (evidence.quote.length === 0) continue;
      const seen = observedFor(evidence.sourceUrl, createdAt);
      out.push({
        opportunityId,
        claimType: 'COMPETITOR_PRICING',
        claimText: `${competitor.name}: ${evidence.type}`,
        sourceUrl: evidence.sourceUrl,
        sourceDocumentId: seen.documentId,
        evidenceExcerpt: evidence.quote,
        confidence: confidenceScore(evidence.confidence),
        inferred: false,
        observedAt: seen.at,
      });
    }
  }

  // 2. reviews -> CUSTOMER_COMPLAINT / MERCHANT_BEHAVIOUR
  const reviews = await db.query<ReviewRow>(
    `SELECT r.id, r.source_url, r.text, r.payment_signal, r.merchant_name, r.created_at
       FROM reviews r
       JOIN competitors c ON c.id = r.competitor_id
      WHERE c.opportunity_id = $1
      ORDER BY r.created_at ASC, r.id ASC`,
    [opportunityId],
  );
  for (const review of reviews.rows) {
    const text = normalize(review.text);
    if (text.length === 0) continue;
    const createdAt = toDate(review.created_at) ?? new Date(0);
    const seen = observedFor(review.source_url, createdAt);
    out.push({
      opportunityId,
      claimType: 'CUSTOMER_COMPLAINT',
      claimText: `review ${review.id}: ${text.slice(0, 160)}`,
      sourceUrl: review.source_url,
      sourceDocumentId: seen.documentId,
      evidenceExcerpt: text,
      confidence: 0.7,
      inferred: false,
      observedAt: seen.at,
    });
    if (review.payment_signal && review.payment_signal !== 'NONE') {
      out.push({
        opportunityId,
        claimType: 'MERCHANT_BEHAVIOUR',
        claimText: `${review.merchant_name ?? 'a reviewer'} shows ${review.payment_signal}`,
        sourceUrl: review.source_url,
        sourceDocumentId: seen.documentId,
        evidenceExcerpt: text,
        confidence: 0.7,
        inferred: false,
        observedAt: seen.at,
      });
    }
  }

  // 3. commitments -> COMMITMENT (a historical event; it never expires)
  const commitments = await db.query<CommitmentRow>(
    `SELECT cm.id, cm.company_key, cm.type, cm.evidence_text, cm.evidence_url,
            cm.price_monthly, cm.created_at
       FROM commitments cm
       JOIN campaigns ca ON ca.id = cm.campaign_id
      WHERE ca.opportunity_id = $1
      ORDER BY cm.created_at ASC, cm.id ASC`,
    [opportunityId],
  );
  for (const commitment of commitments.rows) {
    const text = normalize(commitment.evidence_text);
    if (text.length === 0) continue;
    const createdAt = toDate(commitment.created_at) ?? new Date(0);
    const price = commitment.price_monthly === null ? null : toNumber(commitment.price_monthly, 0);
    out.push({
      opportunityId,
      claimType: 'COMMITMENT',
      claimText:
        `${commitment.company_key} recorded ${commitment.type}` +
        (price === null ? '' : ` at ${price}/month`),
      sourceUrl: commitment.evidence_url,
      sourceDocumentId: null,
      evidenceExcerpt: text,
      confidence: 1,
      inferred: false,
      observedAt: createdAt,
    });
  }

  // 4. prospects -> PROSPECT_IDENTITY
  const prospects = await db.query<{
    id: string;
    company_name: string;
    domain: string;
    public_evidence_url: string | null;
    qualification_reason: string | null;
    evidence_fetched_at: string | Date | null;
    created_at: string | Date;
  }>(
    `SELECT id, company_name, domain, public_evidence_url, qualification_reason,
            evidence_fetched_at, created_at
       FROM prospects
      WHERE opportunity_id = $1 AND status IN ('QUALIFIED','CONTACTED','REPLIED','COMMITTED')
      ORDER BY created_at ASC, id ASC
      LIMIT 500`,
    [opportunityId],
  );
  for (const prospect of prospects.rows) {
    const reason = normalize(prospect.qualification_reason ?? '');
    if (reason.length === 0) continue;
    const createdAt = toDate(prospect.evidence_fetched_at) ?? toDate(prospect.created_at) ?? new Date(0);
    const seen = observedFor(prospect.public_evidence_url, createdAt);
    out.push({
      opportunityId,
      claimType: 'PROSPECT_IDENTITY',
      claimText: `${prospect.company_name} (${prospect.domain}) qualifies as an ICP member`,
      sourceUrl: prospect.public_evidence_url,
      sourceDocumentId: seen.documentId,
      evidenceExcerpt: reason,
      confidence: 0.8,
      inferred: false,
      observedAt: seen.at,
    });
  }

  // 5. wedge capabilities -> PLATFORM_CAPABILITY, INFERRED.
  //    Nobody read a platform document to produce these; the wedge generator
  //    asserted them. They stay marked inferred until a spike confirms one.
  const opportunity = await db.query<{ wedge_json: unknown; updated_at: string | Date }>(
    'SELECT wedge_json, updated_at FROM opportunities WHERE id = $1',
    [opportunityId],
  );
  const wedgeRow = opportunity.rows[0];
  if (wedgeRow) {
    const updatedAt = toDate(wedgeRow.updated_at) ?? new Date(0);
    for (const capability of readWedgeCapabilities(wedgeRow.wedge_json)) {
      out.push({
        opportunityId,
        claimType: 'PLATFORM_CAPABILITY',
        claimText: `the wedge assumes the platform supports: ${capability}`,
        sourceUrl: null,
        sourceDocumentId: null,
        evidenceExcerpt: capability,
        confidence: 0.4,
        inferred: true,
        observedAt: updatedAt,
      });
    }
  }

  return out;
}

/**
 * Records every claim the current rows support. Safe to re-run: `recordClaim`
 * is idempotent by content, so this refreshes rather than duplicates.
 */
export async function backfillEvidenceClaims(
  opportunityId: string,
): Promise<{ recorded: number; inferred: number }> {
  const derived = await deriveClaims(opportunityId);
  let inferred = 0;
  for (const claim of derived) {
    await recordClaim(claim);
    if (claim.inferred === true) inferred += 1;
  }
  logger.debug('evidence claims backfilled', {
    opportunityId,
    recorded: derived.length,
    inferred,
  });
  return { recorded: derived.length, inferred };
}

function claimKey(params: { claimType: ClaimType; claimText: string; sourceUrl?: string | null }): string {
  return `${params.claimType} ${normalize(params.claimText)} ${params.sourceUrl ?? ''}`;
}

/**
 * Re-checks every expired claim against the rows that produced it.
 *
 * A claim is refreshed ONLY when the underlying source has been observed again
 * since we last checked. Re-stamping a claim whose source nobody re-read would
 * be a lie with a fresh timestamp on it, so that case stays stale.
 */
export async function refreshStaleEvidence(opportunityId: string): Promise<{
  refreshed: number;
  stillStale: number;
}> {
  const stale = await staleClaims(opportunityId);
  if (stale.length === 0) return { refreshed: 0, stillStale: 0 };

  const derived = await deriveClaims(opportunityId);
  const byKey = new Map<string, DerivedClaim>();
  for (const candidate of derived) byKey.set(claimKey(candidate), candidate);

  let refreshed = 0;
  let stillStale = 0;

  for (const claim of stale) {
    const candidate = byKey.get(
      claimKey({ claimType: claim.claimType, claimText: claim.claimText, sourceUrl: claim.sourceUrl }),
    );
    const lastChecked = claim.fetchedAt ?? new Date(0);
    if (candidate && candidate.observedAt.getTime() > lastChecked.getTime()) {
      await recordClaim(candidate);
      refreshed += 1;
      continue;
    }
    stillStale += 1;
  }

  logger.info('stale evidence re-checked', { opportunityId, refreshed, stillStale });
  return { refreshed, stillStale };
}
