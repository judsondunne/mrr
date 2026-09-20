/**
 * PAYMENT EVIDENCE RULES — PURE CODE.
 *
 * RESEARCH IS NOT VALIDATION. This module answers exactly one question:
 * "is there proof in a source document that businesses ALREADY PAY for this?"
 *
 * Hard invariants, enforced below and covered by unit tests:
 *   1. HIGH requires at least one STRONG direct payment signal.
 *   2. HIGH additionally requires an INDEPENDENT second signal of sustained
 *      demand — a different source URL, not a second reading of the same page.
 *   3. Weak-only evidence (a pricing page existing, a Product Hunt launch,
 *      download counts, generic reviews, an AI estimate) can never exceed LOW.
 *   4. No number is ever invented. Every EvidenceItem carries the source URL
 *      and a quote/paraphrase taken from that source.
 *
 * There is no LLM call in this file and there must never be one.
 */
import { z } from 'zod';
import {
  EvidenceItem,
  STRONG_EVIDENCE_TYPES,
  SUPPORTING_EVIDENCE_TYPES,
  type EvidenceConfidence,
  type EvidenceType,
  type ExtractedReview,
} from '../../lib/contracts';
import { createLogger } from '../../lib/logger';

const logger = createLogger('verification:evidence');

// --- inputs ------------------------------------------------------------------

/**
 * The facts a marketplace listing yielded. Deliberately primitive so it can be
 * built either from a freshly parsed page or from persisted database rows,
 * without the verification layer having to import the discovery parser.
 */
export interface CompetitorFacts {
  name: string;
  url: string;
  currentPricing: string | null;
  freePlanDetails: string | null;
  hasPermanentFreeTier: boolean | null;
  reviewCount: number | null;
  rating: number | null;
  launchAge: string | null;
  /** Monthly-normalized prices stated on the listing. Empty when unstated. */
  paidPlanPrices: number[];
  /** Marketing/description text from the listing, used for disclosure claims. */
  disclosureText?: string;
  /** ISO date the page was observed. Null when unknown — never guessed. */
  observedAt?: string | null;
  reviews: ExtractedReview[];
}

/**
 * The structured facts the discovery layer persists on
 * `competitors.evidence_json`. Declared here — rather than in the adapter — so
 * the verification layer can rebuild `CompetitorFacts` straight from the
 * database without importing any marketplace-specific parser.
 */
export const CompetitorEvidenceJson = z.object({
  paidPlanPrices: z.array(z.number()).default([]),
  planNames: z.array(z.string()).default([]),
  freeTrialDays: z.number().int().nullable().default(null),
  freeToInstall: z.boolean().default(false),
  description: z.string().default(''),
  observedAt: z.string().nullable().default(null),
  parseWarnings: z.array(z.string()).default([]),
});
export type CompetitorEvidenceJson = z.infer<typeof CompetitorEvidenceJson>;

const EMPTY_EVIDENCE_JSON: CompetitorEvidenceJson = CompetitorEvidenceJson.parse({});

/**
 * Always succeeds. A row written by an older adapter version degrades to
 * defaults instead of throwing in the middle of a verification run.
 */
export function readCompetitorEvidenceJson(value: unknown): CompetitorEvidenceJson {
  let raw = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return EMPTY_EVIDENCE_JSON;
    }
  }
  if (!raw || typeof raw !== 'object') return EMPTY_EVIDENCE_JSON;
  const parsed = CompetitorEvidenceJson.safeParse(raw);
  if (parsed.success) return parsed.data;
  logger.warn('competitor evidence_json did not match schema; using defaults', {
    issues: parsed.error.issues.slice(0, 3).map((i) => i.path.join('.')),
  });
  return EMPTY_EVIDENCE_JSON;
}

export interface EvidenceAssessment {
  confidence: EvidenceConfidence;
  strong: EvidenceItem[];
  supporting: EvidenceItem[];
  weak: EvidenceItem[];
  all: EvidenceItem[];
  competitorCount: number;
  paidCompetitorCount: number;
  /** Human-readable trace of why this confidence was chosen. */
  reasons: string[];
}

// --- helpers -----------------------------------------------------------------

export function isStrong(type: EvidenceType): boolean {
  return STRONG_EVIDENCE_TYPES.has(type);
}
export function isSupporting(type: EvidenceType): boolean {
  return SUPPORTING_EVIDENCE_TYPES.has(type);
}
export function isWeak(type: EvidenceType): boolean {
  return !isStrong(type) && !isSupporting(type);
}

/** Per-item confidence follows directly from the type. No judgement calls. */
export function confidenceForType(type: EvidenceType): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (isStrong(type)) return 'HIGH';
  if (isSupporting(type)) return 'MEDIUM';
  return 'LOW';
}

function clip(text: string, max = 480): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

export function makeEvidence(params: {
  type: EvidenceType;
  sourceUrl: string;
  quote: string;
  date?: string | null;
  note?: string;
}): EvidenceItem {
  return EvidenceItem.parse({
    type: params.type,
    sourceUrl: params.sourceUrl,
    quote: clip(params.quote),
    date: params.date ?? null,
    confidence: confidenceForType(params.type),
    note: clip(params.note ?? '', 280),
  });
}

/** "over 3 years" -> 36. Null when the phrase states no number. */
export function usageDurationMonths(duration: string | null | undefined): number | null {
  if (!duration) return null;
  const m = /(\d{1,3})\s*(year|month|day)s?/i.exec(duration);
  const n = m?.[1] ? Number(m[1]) : null;
  const unit = m?.[2]?.toLowerCase();
  if (n === null || !Number.isFinite(n) || !unit) return null;
  if (unit === 'year') return n * 12;
  if (unit === 'month') return n;
  return Math.round(n / 30);
}

export function hasPaidPlan(facts: CompetitorFacts): boolean {
  if (facts.paidPlanPrices.some((p) => p > 0)) return true;
  // No parsed price, but a pricing summary exists and no free tier was found.
  return facts.hasPermanentFreeTier === false && Boolean(facts.currentPricing);
}

/** Months of usage that count as sustained, not a trial. */
export const SUSTAINED_USAGE_MONTHS = 12;

/** Reviews below this count are not treated as a demand signal at all. */
export const MIN_REVIEWS_FOR_GENERIC_SIGNAL = 5;

// --- disclosure patterns -----------------------------------------------------

const CUSTOMER_COUNT_RE =
  /\b([\d][\d,]{2,})\+?\s+(?:merchants|stores|shops|customers|businesses|brands)\b/i;
const REVENUE_RE = /\$\s?[\d][\d.,]*\s?(?:k|m|million|billion)?\s+(?:in\s+)?(?:mrr|arr|annual\s+revenue|monthly\s+revenue)/i;
const ACQUISITION_RE =
  /\b(?:listed\s+(?:for\s+sale|on)\s+(?:flippa|acquire\.com|microacquire)|for\s+sale\s+on\s+(?:flippa|acquire|microacquire)|acquired\s+by)\b/i;
const PRODUCT_HUNT_RE = /\bproduct\s*hunt\b/i;
const DOWNLOADS_RE = /\b([\d][\d,]{2,})\+?\s+(?:downloads|installs)\b/i;
const AI_ESTIMATE_RE = /\b(?:estimated|projected)\s+(?:market\s+size|tam|revenue)\b/i;

/**
 * Classifies a free-text research page. Used for corroborating signals only —
 * note that everything this can emit besides DISCLOSED_REVENUE_OR_CUSTOMERS is
 * supporting or weak, by design.
 */
export function classifyResearchEvidence(
  text: string,
  sourceUrl: string,
  date: string | null = null,
): EvidenceItem[] {
  const out: EvidenceItem[] = [];
  const push = (type: EvidenceType, match: RegExpExecArray | null, note: string) => {
    if (!match) return;
    out.push(makeEvidence({ type, sourceUrl, quote: quoteAround(text, match.index), date, note }));
  };

  push(
    'DISCLOSED_REVENUE_OR_CUSTOMERS',
    CUSTOMER_COUNT_RE.exec(text) ?? REVENUE_RE.exec(text),
    'paying-customer or revenue figure disclosed by the source',
  );
  push('ACQUISITION_LISTING', ACQUISITION_RE.exec(text), 'business changed hands or is listed for sale');
  push('PRODUCT_HUNT_LAUNCH', PRODUCT_HUNT_RE.exec(text), 'launch publicity only — proves attention, not payment');
  push('DOWNLOADS_NO_PAID_PROOF', DOWNLOADS_RE.exec(text), 'install volume with no payment proof');
  push('AI_MARKET_ESTIMATE', AI_ESTIMATE_RE.exec(text), 'market estimate — never counts as payment proof');
  return out;
}

function quoteAround(text: string, index: number, width = 200): string {
  const start = Math.max(0, index - Math.floor(width / 4));
  return clip(text.slice(start, start + width));
}

// --- per-competitor classification -------------------------------------------

const MAX_REVIEW_ITEMS_PER_TYPE = 3;

/** Deterministic evidence for one competitor listing. Pure function. */
export function classifyCompetitorEvidence(facts: CompetitorFacts): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  const date = facts.observedAt ?? null;
  const paid = hasPaidPlan(facts);

  if (paid && facts.hasPermanentFreeTier === false) {
    items.push(
      makeEvidence({
        type: 'INCUMBENT_NO_FREE_TIER',
        sourceUrl: facts.url,
        quote: facts.currentPricing ?? `${facts.name} lists only paid plans`,
        date,
        note: `${facts.name} has no permanent free tier; merchants must pay to keep using it`,
      }),
    );
  }

  if (facts.currentPricing) {
    items.push(
      makeEvidence({
        type: 'PRICING_PAGE_EXISTS',
        sourceUrl: facts.url,
        quote: facts.currentPricing,
        date,
        note: 'a published price proves intent to charge, not that anyone pays',
      }),
    );
  }

  const counts: Partial<Record<EvidenceType, number>> = {};
  const take = (type: EvidenceType): boolean => {
    const n = counts[type] ?? 0;
    if (n >= MAX_REVIEW_ITEMS_PER_TYPE) return false;
    counts[type] = n + 1;
    return true;
  };

  let paymentSignalReviews = 0;
  for (const review of facts.reviews) {
    if (review.paymentSignal === 'PAID_PLAN_REFERENCED' && take('CUSTOMER_REFERENCES_PAID_PLAN')) {
      paymentSignalReviews += 1;
      items.push(
        makeEvidence({
          type: 'CUSTOMER_REFERENCES_PAID_PLAN',
          sourceUrl: review.sourceUrl || facts.url,
          quote: review.text,
          date: review.reviewDate,
          note: `${review.merchantName ?? 'a merchant'} refers to paying for ${facts.name}`,
        }),
      );
    } else if (review.paymentSignal === 'EXCEEDS_FREE_TIER' && take('CUSTOMER_EXCEEDS_FREE_TIER')) {
      paymentSignalReviews += 1;
      items.push(
        makeEvidence({
          type: 'CUSTOMER_EXCEEDS_FREE_TIER',
          sourceUrl: review.sourceUrl || facts.url,
          quote: review.text,
          date: review.reviewDate,
          note: `${review.merchantName ?? 'a merchant'} outgrew the free tier`,
        }),
      );
    }

    const months = usageDurationMonths(review.usageDuration);
    if (months !== null && months >= SUSTAINED_USAGE_MONTHS && take('SUSTAINED_USAGE_DURATION')) {
      items.push(
        makeEvidence({
          type: 'SUSTAINED_USAGE_DURATION',
          sourceUrl: review.sourceUrl || facts.url,
          quote: `${review.merchantName ?? 'a merchant'}: ${review.usageDuration} using the app`,
          date: review.reviewDate,
          note: `${months} months of continuous use`,
        }),
      );
    }
  }

  const disclosure = facts.disclosureText ?? '';
  if (disclosure) {
    for (const item of classifyResearchEvidence(disclosure, facts.url, date)) {
      if (item.type === 'DISCLOSED_REVENUE_OR_CUSTOMERS' || item.type === 'ACQUISITION_LISTING') {
        items.push(item);
      }
    }
  }

  if (
    paymentSignalReviews === 0 &&
    (facts.reviewCount ?? 0) >= MIN_REVIEWS_FOR_GENERIC_SIGNAL
  ) {
    items.push(
      makeEvidence({
        type: 'GENERIC_REVIEWS',
        sourceUrl: facts.url,
        quote: `${facts.reviewCount} reviews, ${facts.rating ?? 'unrated'} average`,
        date,
        note: 'reviews with no reference to paying — attention, not revenue',
      }),
    );
  }

  return items;
}

// --- category level assessment -----------------------------------------------

function dedupe(items: EvidenceItem[]): EvidenceItem[] {
  const seen = new Set<string>();
  const out: EvidenceItem[] = [];
  for (const item of items) {
    const key = `${item.type}|${item.sourceUrl}|${item.quote.slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * True when some additional signal comes from a DIFFERENT source URL than a
 * strong signal. Two readings of the same page are one signal, not two.
 */
function hasIndependentSecondSignal(strong: EvidenceItem[], supporting: EvidenceItem[]): boolean {
  const pool = [...strong, ...supporting];
  for (const s of strong) {
    for (const other of pool) {
      if (other === s) continue;
      if (other.sourceUrl !== s.sourceUrl) return true;
    }
  }
  return false;
}

/**
 * The category-level verdict. `extra` carries evidence gathered outside the
 * marketplace listings (research pages, acquisition listings).
 */
export function assessCategoryEvidence(
  competitors: CompetitorFacts[],
  extra: EvidenceItem[] = [],
): EvidenceAssessment {
  const paidCompetitors = competitors.filter(hasPaidPlan);
  const perCompetitor = competitors.flatMap(classifyCompetitorEvidence);
  const all = dedupe([...perCompetitor, ...extra]);

  if (paidCompetitors.length >= 2) {
    const second = paidCompetitors[1];
    const names = paidCompetitors.map((c) => c.name).join(', ');
    if (second) {
      all.push(
        makeEvidence({
          type: 'MULTIPLE_PAID_COMPETITORS',
          // Attributed to the second competitor: a genuinely different source.
          sourceUrl: second.url,
          quote: `${paidCompetitors.length} competing apps charge for this job: ${names}`,
          date: second.observedAt ?? null,
          note: 'multiple independent vendors sustain paid plans in this category',
        }),
      );
    }
  }

  const strong = all.filter((i) => isStrong(i.type));
  const supporting = all.filter((i) => isSupporting(i.type));
  const weak = all.filter((i) => isWeak(i.type));

  const reasons: string[] = [];
  const strongTypes = new Set(strong.map((i) => i.type));
  const independent = hasIndependentSecondSignal(strong, supporting);
  const established = paidCompetitors.length >= 2;

  let confidence: EvidenceConfidence;
  if (strong.length === 0) {
    confidence = all.length === 0 ? 'NONE' : 'LOW';
    reasons.push(
      all.length === 0
        ? 'no evidence of any kind was extracted'
        : `only weak evidence (${[...new Set(weak.map((i) => i.type))].join(', ')}) — weak evidence can never exceed LOW`,
    );
  } else if (independent && (established || strongTypes.size >= 2)) {
    confidence = 'HIGH';
    reasons.push(
      `${strong.length} strong payment signal(s) across ${new Set(strong.map((i) => i.sourceUrl)).size} independent source(s)`,
    );
    reasons.push(
      established
        ? `${paidCompetitors.length} established competitors sustain paid plans`
        : `${strongTypes.size} distinct kinds of direct payment proof`,
    );
  } else {
    confidence = 'MEDIUM';
    if (!independent) reasons.push('every strong signal comes from a single source — no independent corroboration');
    if (!established && strongTypes.size < 2) {
      reasons.push(`only ${paidCompetitors.length} competitor(s) with a paid plan and one kind of proof`);
    }
  }

  if (confidence === 'LOW' && supporting.length > 0 && paidCompetitors.length >= 1) {
    confidence = 'MEDIUM';
    reasons.push('supporting demand signal alongside at least one paid competitor');
  }

  // Invariant 1 & 3, restated as an assertion the tests can rely on.
  if (confidence === 'HIGH' && strong.length === 0) {
    throw new Error('unreachable: HIGH confidence without a strong payment signal');
  }

  return {
    confidence,
    strong,
    supporting,
    weak,
    all,
    competitorCount: competitors.length,
    paidCompetitorCount: paidCompetitors.length,
    reasons,
  };
}

const RANK: Record<EvidenceConfidence, number> = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };

export function meetsConfidence(actual: EvidenceConfidence, required: EvidenceConfidence): boolean {
  return RANK[actual] >= RANK[required];
}
