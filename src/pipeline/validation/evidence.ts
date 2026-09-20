/**
 * Real prospect evidence, read out of the database.
 *
 * Nothing in this file writes prose. Every string it returns is a verbatim
 * (whitespace-collapsed, possibly truncated) slice of a row a real business
 * created: a commitment's evidence_text, or an inbound reply's body/extraction.
 * The owner email and the build spec quote ONLY what comes back from here, so a
 * fabricated quotation is structurally impossible.
 */
import { getDb, toNumber } from '../../lib/db.js';
import {
  ACTION_COMMITMENT_TYPES,
  PRICE_ACCEPTANCE_TYPES,
  type CommitmentType,
} from '../../lib/contracts.js';

export const MAX_QUOTE_CHARS = 220;

export type EvidenceOrigin = 'commitments' | 'messages';

export interface ProspectEvidenceItem {
  /** Row this quote came from. Lets any reader verify it against the database. */
  origin: EvidenceOrigin;
  rowId: string;
  companyKey: string;
  companyName: string | null;
  /** Commitment type, or reply classification for a message. */
  kind: string;
  source: string;
  occurredAt: string;
  priceMonthly: number | null;
  /** Verbatim slice of the source row. Never paraphrased, never invented. */
  quote: string;
  truncated: boolean;
  evidenceUrl: string | null;
}

export interface CustomerRequirement {
  /** Verbatim text a prospect asked for. */
  requirement: string;
  /** How many distinct companies asked for it. */
  companies: number;
  /** Message ids that say it, so the claim is auditable. */
  sourceRowIds: string[];
}

/** Collapse whitespace so a quote renders on one line; never rewrite words. */
export function normalizeQuote(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function clipQuote(text: string, max = MAX_QUOTE_CHARS): { quote: string; truncated: boolean } {
  const normalized = normalizeQuote(text);
  if (normalized.length <= max) return { quote: normalized, truncated: false };
  return { quote: normalized.slice(0, max), truncated: true };
}

/** Price acceptance first, then action, then everything else. */
function commitmentRank(type: string): number {
  if (PRICE_ACCEPTANCE_TYPES.has(type as CommitmentType)) return 0;
  if (ACTION_COMMITMENT_TYPES.has(type as CommitmentType)) return 1;
  return 2;
}

interface CommitmentEvidenceRow {
  id: string;
  company_key: string;
  company_name: string | null;
  type: string;
  source: string;
  created_at: string | Date;
  price_monthly: string | number | null;
  evidence_text: string;
  evidence_url: string | null;
}

interface MessageEvidenceRow {
  id: string;
  company_name: string | null;
  domain: string | null;
  classification: string | null;
  received_at: string | Date | null;
  created_at: string | Date;
  body: string;
}

function iso(value: string | Date | null): string {
  if (!value) return '';
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * The strongest REAL evidence for a campaign, best first.
 * Commitments outrank replies because a commitment required an action.
 */
export async function getStrongestEvidence(
  campaignId: string,
  limit = 8,
): Promise<ProspectEvidenceItem[]> {
  const db = await getDb();

  const commitments = await db.query<CommitmentEvidenceRow>(
    `SELECT c.id, c.company_key, p.company_name, c.type, c.source, c.created_at,
            c.price_monthly, c.evidence_text, c.evidence_url
       FROM commitments c
       LEFT JOIN prospects p ON p.id = c.prospect_id
      WHERE c.campaign_id = $1 AND length(trim(c.evidence_text)) > 0
      ORDER BY c.created_at ASC, c.id ASC`,
    [campaignId],
  );

  const replies = await db.query<MessageEvidenceRow>(
    `SELECT m.id, p.company_name, p.domain, m.classification, m.received_at, m.created_at, m.body
       FROM messages m
       LEFT JOIN prospects p ON p.id = m.prospect_id
      WHERE m.campaign_id = $1
        AND m.direction = 'INBOUND'
        AND m.classification IN ('INTERESTED_STRONG','PRICE_ACCEPTED','WANTS_PILOT','FEATURE_REQUIREMENT')
        AND length(trim(m.body)) > 0
      ORDER BY m.created_at ASC, m.id ASC`,
    [campaignId],
  );

  const items: ProspectEvidenceItem[] = [];

  for (const row of commitments.rows) {
    const { quote, truncated } = clipQuote(row.evidence_text);
    if (!quote) continue;
    items.push({
      origin: 'commitments',
      rowId: row.id,
      companyKey: row.company_key,
      companyName: row.company_name,
      kind: row.type,
      source: row.source,
      occurredAt: iso(row.created_at),
      priceMonthly: row.price_monthly === null ? null : toNumber(row.price_monthly, 0),
      quote,
      truncated,
      evidenceUrl: row.evidence_url,
    });
  }

  for (const row of replies.rows) {
    const { quote, truncated } = clipQuote(row.body);
    if (!quote) continue;
    items.push({
      origin: 'messages',
      rowId: row.id,
      companyKey: row.domain ?? row.id,
      companyName: row.company_name,
      kind: row.classification ?? 'REPLY',
      source: 'EMAIL_REPLY',
      occurredAt: iso(row.received_at ?? row.created_at),
      priceMonthly: null,
      quote,
      truncated,
      evidenceUrl: null,
    });
  }

  items.sort((a, b) => {
    const aRank = a.origin === 'commitments' ? commitmentRank(a.kind) : 3;
    const bRank = b.origin === 'commitments' ? commitmentRank(b.kind) : 3;
    if (aRank !== bRank) return aRank - bRank;
    if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
    return a.rowId < b.rowId ? -1 : 1;
  });

  return items.slice(0, limit);
}

interface RequirementRow {
  id: string;
  requested_feature: string | null;
  body: string;
  classification: string | null;
  domain: string | null;
}

/**
 * Capabilities real prospects asked for, most-requested first.
 *
 * Two sources, both real rows:
 *   1. extraction_json.requestedFeature on an inbound reply
 *   2. the body of a reply the outreach layer classified FEATURE_REQUIREMENT
 */
export async function getCustomerDerivedRequirements(
  campaignId: string,
  limit = 10,
): Promise<CustomerRequirement[]> {
  const db = await getDb();
  const res = await db.query<RequirementRow>(
    `SELECT m.id,
            m.extraction_json->>'requestedFeature' AS requested_feature,
            m.body,
            m.classification,
            p.domain
       FROM messages m
       LEFT JOIN prospects p ON p.id = m.prospect_id
      WHERE m.campaign_id = $1
        AND m.direction = 'INBOUND'
        AND (
          COALESCE(length(trim(m.extraction_json->>'requestedFeature')), 0) > 0
          OR (m.classification = 'FEATURE_REQUIREMENT' AND length(trim(m.body)) > 0)
        )
      ORDER BY m.created_at ASC, m.id ASC`,
    [campaignId],
  );

  const grouped = new Map<string, { requirement: string; companies: Set<string>; rowIds: string[] }>();

  for (const row of res.rows) {
    const raw = row.requested_feature && row.requested_feature.trim().length > 0
      ? row.requested_feature
      : firstSentence(row.body);
    const { quote } = clipQuote(raw);
    if (!quote) continue;
    const key = quote.toLowerCase();
    const existing = grouped.get(key);
    const company = row.domain ?? row.id;
    if (existing) {
      existing.companies.add(company);
      existing.rowIds.push(row.id);
    } else {
      grouped.set(key, { requirement: quote, companies: new Set([company]), rowIds: [row.id] });
    }
  }

  return [...grouped.values()]
    .map((g) => ({ requirement: g.requirement, companies: g.companies.size, sourceRowIds: g.rowIds }))
    .sort((a, b) => (b.companies - a.companies) || (a.requirement < b.requirement ? -1 : 1))
    .slice(0, limit);
}

/** First sentence of a real reply body. Still verbatim — only the tail is dropped. */
function firstSentence(body: string): string {
  const normalized = normalizeQuote(body);
  const end = normalized.search(/[.!?](\s|$)/);
  return end > 0 ? normalized.slice(0, end + 1) : normalized;
}

export interface CompetitorPaymentEvidence {
  type: string;
  sourceUrl: string;
  quote: string;
  confidence: string;
  date: string | null;
}

export interface CompetitorEvidence {
  name: string;
  url: string;
  currentPricing: string | null;
  freePlanDetails: string | null;
  hasPermanentFreeTier: boolean | null;
  reviewCount: number | null;
  rating: number | null;
  launchAge: string | null;
  paymentEvidence: CompetitorPaymentEvidence[];
}

interface CompetitorRow {
  name: string;
  url: string;
  current_pricing: string | null;
  free_plan_details: string | null;
  has_permanent_free_tier: boolean | null;
  review_count: number | null;
  rating: string | number | null;
  launch_age: string | null;
  payment_evidence_json: unknown;
}

function parseEvidenceArray(value: unknown): CompetitorPaymentEvidence[] {
  const raw = typeof value === 'string' ? safeJson(value) : value;
  if (!Array.isArray(raw)) return [];
  const out: CompetitorPaymentEvidence[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;
    const type = typeof obj.type === 'string' ? obj.type : null;
    const sourceUrl = typeof obj.sourceUrl === 'string' ? obj.sourceUrl : null;
    if (!type || !sourceUrl) continue;
    out.push({
      type,
      sourceUrl,
      quote: typeof obj.quote === 'string' ? normalizeQuote(obj.quote) : '',
      confidence: typeof obj.confidence === 'string' ? obj.confidence : 'UNKNOWN',
      date: typeof obj.date === 'string' ? obj.date : null,
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

/** Competitor payment evidence: why this category is already monetized. */
export async function getCompetitorEvidence(opportunityId: string): Promise<CompetitorEvidence[]> {
  const db = await getDb();
  const res = await db.query<CompetitorRow>(
    `SELECT name, url, current_pricing, free_plan_details, has_permanent_free_tier,
            review_count, rating, launch_age, payment_evidence_json
       FROM competitors
      WHERE opportunity_id = $1
      ORDER BY created_at ASC, name ASC`,
    [opportunityId],
  );
  return res.rows.map((row) => ({
    name: row.name,
    url: row.url,
    currentPricing: row.current_pricing,
    freePlanDetails: row.free_plan_details,
    hasPermanentFreeTier: row.has_permanent_free_tier,
    reviewCount: row.review_count === null ? null : toNumber(row.review_count, 0),
    rating: row.rating === null ? null : toNumber(row.rating, 0),
    launchAge: row.launch_age,
    paymentEvidence: parseEvidenceArray(row.payment_evidence_json),
  }));
}

export interface WaitingCompany {
  companyKey: string;
  companyName: string | null;
  domain: string | null;
  commitmentTypes: string[];
  priceMonthly: number | null;
}

/** Companies that committed, i.e. the pilot list the owner can email on day one. */
export async function getWaitingCompanies(campaignId: string): Promise<WaitingCompany[]> {
  const db = await getDb();
  const res = await db.query<{
    company_key: string;
    company_name: string | null;
    domain: string | null;
    types: string;
    price_monthly: string | number | null;
  }>(
    `SELECT c.company_key,
            MIN(p.company_name) AS company_name,
            MIN(p.domain) AS domain,
            string_agg(DISTINCT c.type, ',' ORDER BY c.type) AS types,
            MAX(c.price_monthly) AS price_monthly
       FROM commitments c
       LEFT JOIN prospects p ON p.id = c.prospect_id
      WHERE c.campaign_id = $1
      GROUP BY c.company_key
      ORDER BY c.company_key ASC`,
    [campaignId],
  );
  return res.rows.map((row) => ({
    companyKey: row.company_key,
    companyName: row.company_name,
    domain: row.domain,
    commitmentTypes: row.types ? row.types.split(',') : [],
    priceMonthly: row.price_monthly === null ? null : toNumber(row.price_monthly, 0),
  }));
}
