/**
 * DETERMINISTIC EXTRACTION.
 *
 * Everything in this file is plain code: Cheerio selectors with multiple
 * fallbacks, then regex over the visible text. No LLM call may appear here.
 *
 * Marketplace markup changes without notice, so every field is parsed
 * independently, every failure is recorded in `parseWarnings` instead of
 * thrown, and a totally unparseable page yields an empty-but-valid result.
 */
import { load, type CheerioAPI } from 'cheerio';
import { createLogger } from '../../lib/logger';
import type { ExtractedReview } from '../../lib/contracts';

const logger = createLogger('discovery:parse');

// --- shapes ------------------------------------------------------------------

export interface ParsedPlan {
  name: string;
  /** Normalized to a monthly figure. Null when the page did not state one. */
  priceMonthly: number | null;
  rawPrice: string;
  isFree: boolean;
  features: string[];
}

export interface ParsedListing {
  url: string;
  name: string | null;
  developer: string | null;
  description: string;
  plans: ParsedPlan[];
  /** The raw text of the pricing region, trimmed. Used for LLM fallback only. */
  pricingText: string;
  currentPricing: string | null;
  freePlanDetails: string | null;
  hasPermanentFreeTier: boolean | null;
  freeTrialDays: number | null;
  /** "Free to install" = usage-based billing, NOT a permanent free tier. */
  freeToInstall: boolean;
  reviewCount: number | null;
  rating: number | null;
  launchAge: string | null;
  reviews: ExtractedReview[];
  parseWarnings: string[];
  /**
   * True when a pricing region exists but produced no usable plan and no
   * free-tier verdict. This is the ONLY condition that may escalate to an LLM.
   */
  ambiguous: boolean;
}

// --- low level helpers -------------------------------------------------------

const BOILERPLATE_SELECTORS =
  'script, style, noscript, svg, iframe, template, nav, header, footer, form, ' +
  '[role="navigation"], [role="banner"], [role="contentinfo"], [aria-hidden="true"]';

export function collapse(text: string): string {
  return text.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

/** Strips boilerplate and returns inert visible text. Never throws. */
export function htmlToText(html: string, maxChars = 20_000): string {
  try {
    const $ = load(html);
    $(BOILERPLATE_SELECTORS).remove();
    return collapse($('body').text() || $.root().text()).slice(0, maxChars);
  } catch (err) {
    logger.warn('htmlToText failed; falling back to tag stripping', { err: String(err) });
    return collapse(html.replace(/<[^>]*>/g, ' ')).slice(0, maxChars);
  }
}

function firstText($: CheerioAPI, selectors: string[]): string | null {
  for (const sel of selectors) {
    try {
      const el = $(sel).first();
      if (el.length === 0) continue;
      const raw = sel.startsWith('meta') ? (el.attr('content') ?? '') : el.text();
      const text = collapse(raw);
      if (text) return text;
    } catch {
      // A selector unsupported by this Cheerio build must not kill the parse.
      continue;
    }
  }
  return null;
}

/** First non-empty value of `attrs` on the first element matching `selectors`. */
function firstAttr($: CheerioAPI, selectors: string[], attrs: string[]): string | null {
  for (const sel of selectors) {
    let found: string | null = null;
    try {
      $(sel).each((_i, el) => {
        if (found !== null) return;
        for (const attr of attrs) {
          const value = $(el).attr(attr);
          if (value && value.trim()) {
            found = collapse(value);
            return;
          }
        }
      });
    } catch {
      continue;
    }
    if (found !== null) return found;
  }
  return null;
}

function toInt(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const n = Number(raw.replace(/[, ]/g, ''));
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toFloat(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const n = Number(raw.replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// --- money -------------------------------------------------------------------

/** "$14.99 / month", "$180 per year", "USD 29 a month". */
const MONEY_PER_PERIOD_SOURCE =
  '(?:\\$|usd\\s*)\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)\\s*(?:usd)?\\s*(?:\\/|per\\s+|a\\s+|\\s+)\\s*' +
  '(months?|mo\\b|years?|yr\\b|annually|annum)';

/** A bare amount, used only inside an already-identified plan card. */
const BARE_MONEY_SOURCE = '(?:\\$|usd\\s*)\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)';

function normalizeToMonthly(amount: number, period: string): number | null {
  const p = period.toLowerCase();
  if (p.startsWith('mo')) return round2(amount);
  if (p.startsWith('year') || p.startsWith('yr') || p.startsWith('annu')) return round2(amount / 12);
  return null;
}

/** Every monthly-normalized price stated in `text`, in document order. */
export function extractMonthlyPrices(text: string): Array<{ amount: number; raw: string }> {
  const out: Array<{ amount: number; raw: string }> = [];
  const re = new RegExp(MONEY_PER_PERIOD_SOURCE, 'gi');
  for (const m of text.matchAll(re)) {
    const amount = toFloat(m[1]);
    const period = m[2];
    if (amount === null || !period) continue;
    const monthly = normalizeToMonthly(amount, period);
    if (monthly === null) continue;
    out.push({ amount: monthly, raw: collapse(m[0]) });
  }
  return out;
}

// --- free tier language ------------------------------------------------------

const FREE_PLAN_AVAILABLE = /\bfree\s+(?:plan|tier)\s+(?:available|included)\b|\bhas\s+a\s+free\s+plan\b/i;
const FREE_TO_INSTALL = /\bfree\s+to\s+install\b/i;
const FREE_TRIAL = /(\d{1,3})[-\s]?day\s+free\s+trial|\bfree\s+trial\b/i;
const PRICE_IS_FREE = /^\s*(free|\$?0(?:\.00)?(?:\s*\/\s*\w+)?)\s*$/i;

export function extractFreeTrialDays(text: string): number | null {
  const m = /(\d{1,3})[-\s]?day\s+free\s+trial/i.exec(text);
  return m ? toInt(m[1]) : null;
}

/**
 * A permanent free tier is a plan a merchant can stay on forever.
 * A time-boxed trial is NOT one, and neither is "free to install" (which means
 * usage-based charges apply).
 */
export function decideFreeTier(
  plans: ParsedPlan[],
  pageText: string,
): { hasPermanentFreeTier: boolean | null; freeToInstall: boolean; freePlanDetails: string | null } {
  const freeToInstall = FREE_TO_INSTALL.test(pageText);
  const freePlan = plans.find((p) => p.isFree);
  if (freePlan) {
    return {
      hasPermanentFreeTier: true,
      freeToInstall,
      freePlanDetails: collapse(`${freePlan.name}: ${freePlan.features.join('; ')}`).slice(0, 400) || freePlan.name,
    };
  }
  const availableMatch = FREE_PLAN_AVAILABLE.exec(pageText);
  if (availableMatch) {
    return {
      hasPermanentFreeTier: true,
      freeToInstall,
      freePlanDetails: collapse(sentenceAround(pageText, availableMatch.index)).slice(0, 400),
    };
  }
  if (plans.length > 0) {
    return { hasPermanentFreeTier: false, freeToInstall, freePlanDetails: null };
  }
  if (freeToInstall) {
    // Usage-based billing with no stated plan: explicitly not a free tier.
    return { hasPermanentFreeTier: false, freeToInstall, freePlanDetails: null };
  }
  return { hasPermanentFreeTier: null, freeToInstall, freePlanDetails: null };
}

function sentenceAround(text: string, index: number): string {
  const start = Math.max(0, text.lastIndexOf('.', index) + 1);
  const dot = text.indexOf('.', index);
  const end = dot === -1 ? Math.min(text.length, index + 160) : dot + 1;
  return text.slice(start, end).trim();
}

// --- ratings and review counts ----------------------------------------------

interface JsonLdRating {
  ratingValue?: string | number;
  reviewCount?: string | number;
  ratingCount?: string | number;
}

function readJsonLd($: CheerioAPI): Array<Record<string, unknown>> {
  const nodes: Array<Record<string, unknown>> = [];
  $('script[type="application/ld+json"]').each((_i, el) => {
    const raw = $(el).text();
    if (!raw.trim()) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (item && typeof item === 'object') nodes.push(item as Record<string, unknown>);
      }
    } catch {
      // Malformed JSON-LD is common; ignore it and fall through to selectors.
    }
  });
  return nodes;
}

function jsonLdRating(nodes: Array<Record<string, unknown>>): JsonLdRating | null {
  for (const node of nodes) {
    const agg = node['aggregateRating'];
    if (agg && typeof agg === 'object') return agg as JsonLdRating;
  }
  return null;
}

export function parseReviewCount($: CheerioAPI, pageText: string): number | null {
  const agg = jsonLdRating(readJsonLd($));
  const fromLd = toInt(String(agg?.reviewCount ?? agg?.ratingCount ?? ''));
  if (fromLd !== null && fromLd >= 0) return fromLd;

  for (const attr of ['data-reviews-count', 'data-review-count', 'data-total-reviews']) {
    const val = toInt($(`[${attr}]`).first().attr(attr));
    if (val !== null) return val;
  }

  const labelled =
    firstAttr($, ['[aria-label*="review" i]', '[title*="review" i]'], ['aria-label', 'title']) ??
    firstText($, ['[aria-label*="review" i]', 'a[href*="review" i]']);
  const fromLabel = labelled ? /([\d,]+)\s*(?:total\s+)?reviews?/i.exec(labelled) : null;
  if (fromLabel) {
    const n = toInt(fromLabel[1]);
    if (n !== null) return n;
  }

  const m = /([\d,]{1,12})\s*(?:total\s+)?reviews?\b/i.exec(pageText);
  if (m) {
    const n = toInt(m[1]);
    if (n !== null) return n;
  }
  return null;
}

export function parseRating($: CheerioAPI, pageText: string): number | null {
  const agg = jsonLdRating(readJsonLd($));
  const fromLd = toFloat(String(agg?.ratingValue ?? ''));
  if (fromLd !== null && fromLd > 0 && fromLd <= 5) return fromLd;

  const label = firstAttr(
    $,
    ['[aria-label*="out of 5" i]', '[title*="out of 5" i]', '[data-rating]'],
    ['aria-label', 'title', 'data-rating'],
  );
  const candidates = [label, firstText($, ['[class*="star-rating" i]']), pageText].filter(
    (s): s is string => Boolean(s),
  );
  for (const text of candidates) {
    const m = /([0-5](?:\.\d{1,2})?)\s*(?:out of|\/)\s*5\b/i.exec(text);
    const n = m ? toFloat(m[1]) : null;
    if (n !== null && n > 0 && n <= 5) return n;
  }
  const bare = toFloat(label);
  if (bare !== null && bare > 0 && bare <= 5) return bare;
  return null;
}

const LAUNCH_PATTERNS: RegExp[] = [
  /\blaunched\b[^.]{0,20}?((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4})/i,
  /\blaunched\b[^.]{0,20}?(\d{4})/i,
  /\b(?:on the app store|in the app store)\s+since\s+(\d{4})/i,
  /\bserving merchants since\s+(\d{4})/i,
  /\bbuilt\s+(?:in|since)\s+(\d{4})/i,
];

export function parseLaunchAge(pageText: string): string | null {
  for (const re of LAUNCH_PATTERNS) {
    const m = re.exec(pageText);
    if (m?.[1]) return collapse(m[1]);
  }
  return null;
}

// --- plans -------------------------------------------------------------------

const PRICING_REGION_SELECTORS = [
  '[data-testid="pricing-plans"]',
  '#pricing-plans',
  '#pricing',
  '[id*="pricing" i]',
  '[class*="pricing-plan" i]',
  '[class*="pricing" i]',
  'section[aria-label*="pricing" i]',
];

const PLAN_CARD_SELECTORS = [
  '[data-testid="pricing-plan-card"]',
  '[data-pricing-plan]',
  '.app-details-pricing-plan-card',
  '.pricing-plan-card',
  '[class*="pricing-plan-card" i]',
  '[class*="plan-card" i]',
  'li[class*="pricing" i]',
];

const PLAN_NAME_SELECTORS = [
  '[data-testid="plan-name"]',
  '[class*="plan-card__name" i]',
  '[class*="plan-name" i]',
  'h2',
  'h3',
  'h4',
  'strong',
];

const PLAN_PRICE_SELECTORS = [
  '[data-testid="plan-price"]',
  '[class*="plan-card__price" i]',
  '[class*="price" i]',
];

function scopedFirstText($: CheerioAPI, scope: ReturnType<CheerioAPI>, selectors: string[]): string | null {
  for (const sel of selectors) {
    try {
      const el = scope.find(sel).first();
      if (el.length === 0) continue;
      const text = collapse(el.text());
      if (text) return text;
    } catch {
      continue;
    }
  }
  return null;
}

function parsePlanCards($: CheerioAPI): ParsedPlan[] {
  for (const cardSel of PLAN_CARD_SELECTORS) {
    let cards;
    try {
      cards = $(cardSel);
    } catch {
      continue;
    }
    if (cards.length === 0) continue;

    const plans: ParsedPlan[] = [];
    cards.each((_i, el) => {
      const card = $(el);
      const name = scopedFirstText($, card, PLAN_NAME_SELECTORS);
      if (!name || name.length > 60) return;

      const rawPrice = scopedFirstText($, card, PLAN_PRICE_SELECTORS) ?? '';
      const cardText = collapse(card.text());
      const priced = extractMonthlyPrices(rawPrice || cardText);
      let priceMonthly = priced[0]?.amount ?? null;

      if (priceMonthly === null && rawPrice) {
        const bare = new RegExp(BARE_MONEY_SOURCE, 'i').exec(rawPrice);
        const amount = bare ? toFloat(bare[1]) : null;
        if (amount !== null) priceMonthly = round2(amount);
      }

      const isFree =
        PRICE_IS_FREE.test(rawPrice) ||
        priceMonthly === 0 ||
        (/^free\b/i.test(name) && !/trial/i.test(name));
      if (isFree) priceMonthly = 0;

      const features: string[] = [];
      card.find('li').each((_j, li) => {
        const t = collapse($(li).text());
        if (t && t.length <= 160) features.push(t);
      });

      plans.push({
        name,
        priceMonthly,
        rawPrice: rawPrice || (priced[0]?.raw ?? ''),
        isFree,
        features: features.slice(0, 8),
      });
    });

    const usable = plans.filter((p) => p.isFree || p.priceMonthly !== null || p.features.length > 0);
    if (usable.length > 0) return usable;
  }
  return [];
}

function pricingRegionText($: CheerioAPI): string {
  for (const sel of PRICING_REGION_SELECTORS) {
    try {
      const el = $(sel).first();
      if (el.length === 0) continue;
      const text = collapse(el.text());
      if (text.length > 20) return text.slice(0, 4000);
    } catch {
      continue;
    }
  }
  return '';
}

/** Falls back to plain text when there are no recognizable plan cards. */
function plansFromText(pricingText: string): ParsedPlan[] {
  const priced = extractMonthlyPrices(pricingText);
  if (priced.length === 0) return [];
  return priced.slice(0, 6).map((p, i) => ({
    name: `Plan ${i + 1}`,
    priceMonthly: p.amount,
    rawPrice: p.raw,
    isFree: p.amount === 0,
    features: [],
  }));
}

function summarizePricing(plans: ParsedPlan[]): string | null {
  if (plans.length === 0) return null;
  return plans
    .map((p) => (p.isFree ? `${p.name}: free` : `${p.name}: ${p.priceMonthly === null ? p.rawPrice || 'unstated' : `$${p.priceMonthly}/mo`}`))
    .join('; ')
    .slice(0, 400);
}

// --- reviews -----------------------------------------------------------------

const REVIEW_CARD_SELECTORS = [
  '[data-merchant-review]',
  '[data-review-content-id]',
  '[data-testid="review-card"]',
  '.review-listing',
  '[class*="review-listing" i]',
  'article[class*="review" i]',
  'li[class*="review" i]',
];

const REVIEW_BODY_SELECTORS = [
  '[data-truncated-content]',
  '[class*="review-content" i]',
  '[class*="review-listing__review" i]',
  '[class*="review-body" i]',
  'p',
];

const REVIEW_AUTHOR_SELECTORS = [
  '[data-merchant-name]',
  '[class*="review-listing__author" i]',
  '[class*="merchant-name" i]',
  '[class*="author" i]',
  'h3',
  'h4',
];

const USAGE_DURATION_PATTERNS: RegExp[] = [
  /\b((?:about|over|almost|nearly|more than)?\s*\d{1,3}\s*(?:year|month|day)s?)\s+using the app\b/i,
  /\busing (?:the|this) app (?:for )?((?:about|over|almost|nearly|more than)?\s*\d{1,3}\s*(?:year|month|day)s?)/i,
  /\b(?:customer|merchant|user) for ((?:about|over|almost|nearly|more than)?\s*\d{1,3}\s*(?:year|month)s?)/i,
];

export function extractUsageDuration(text: string): string | null {
  for (const re of USAGE_DURATION_PATTERNS) {
    const m = re.exec(text);
    if (m?.[1]) return collapse(m[1]);
  }
  return null;
}

const PAID_PLAN_PATTERNS: RegExp[] = [
  /\bwe (?:pay|are paying|have paid|happily pay)\b/i,
  /\bpaying\s*\$\s*\d/i,
  /\bworth\s+(?:every\s+penny|the\s+(?:money|price|cost))\b/i,
  /\b(?:on|upgraded to|switched to|bought|purchased|subscribed to)\s+(?:the\s+)?[a-z]{3,20}\s+(?:plan|tier|subscription)\b/i,
  /\b(?:the\s+)?(?:paid|premium|pro|advanced|unlimited)\s+(?:plan|tier|version)\b/i,
  /\bour\s+(?:monthly\s+)?subscription\b/i,
  /\bmonthly\s+fee\b/i,
  /\$\s*\d+(?:\.\d{2})?\s*(?:\/|per\s+|a\s+)\s*month\b/i,
  /\bfor\s*\$\s*\d+\s*(?:a|per)\s*month\b/i,
];

const EXCEEDS_FREE_PATTERNS: RegExp[] = [
  /\boutgrew\s+the\s+free\b/i,
  /\bfree\s+(?:plan|tier)\s+(?:was(?:n't| not)|is(?:n't| not)|no longer)\s+enough\b/i,
  /\b(?:hit|reached|exceeded)\s+(?:the\s+)?(?:free\s+)?(?:plan\s+)?(?:limit|cap|quota|ceiling)s?\b/i,
  /\bneeded?\s+more\s+than\s+the\s+free\b/i,
  /\bhad\s+to\s+upgrade\b/i,
  /\bran\s+out\s+of\s+(?:free\s+)?(?:credits|quota|orders)\b/i,
];

export function classifyReviewPaymentSignal(text: string): ExtractedReview['paymentSignal'] {
  if (EXCEEDS_FREE_PATTERNS.some((re) => re.test(text))) return 'EXCEEDS_FREE_TIER';
  if (PAID_PLAN_PATTERNS.some((re) => re.test(text))) return 'PAID_PLAN_REFERENCED';
  return 'NONE';
}

const COMPLAINT_TAG_PATTERNS: ReadonlyArray<{ tag: string; re: RegExp }> = [
  { tag: 'pricing', re: /\b(too expensive|overpriced|price (?:hike|increase)|pricey|cost too much)\b/i },
  { tag: 'support', re: /\b(no (?:response|reply)|support (?:is|was) (?:slow|terrible|unresponsive)|never heard back)\b/i },
  { tag: 'bugs', re: /\b(bug|broken|glitch|error message|stopped working|doesn'?t work)\b/i },
  { tag: 'performance', re: /\b(slow|sluggish|lag|timeout|takes forever)\b/i },
  { tag: 'missing-feature', re: /\b(wish it (?:could|had)|missing|no way to|can'?t (?:set|do|configure)|would love (?:if|to see))\b/i },
  { tag: 'setup-complexity', re: /\b(hard to (?:set ?up|configure)|confusing|complicated|steep learning curve)\b/i },
  { tag: 'integration', re: /\b(doesn'?t (?:work|sync) with|integration (?:broke|failed)|no api)\b/i },
  { tag: 'reliability', re: /\b(went down|outage|unreliable|data loss|lost (?:our|my) )\b/i },
  { tag: 'billing', re: /\b(charged (?:me|us) (?:twice|again)|billing (?:issue|problem)|refund)\b/i },
];

export function tagComplaints(text: string): string[] {
  return COMPLAINT_TAG_PATTERNS.filter(({ re }) => re.test(text)).map(({ tag }) => tag);
}

const DATE_PATTERNS: RegExp[] = [
  /\b(\d{4}-\d{2}-\d{2})\b/,
  /\b((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4})\b/i,
  /\b((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})\b/i,
];

function parseReviewDate(card: string, datetimeAttr: string | undefined): string | null {
  if (datetimeAttr) {
    const iso = datetimeAttr.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  }
  for (const re of DATE_PATTERNS) {
    const m = re.exec(card);
    if (m?.[1]) {
      const d = new Date(m[1]);
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
      return m[1];
    }
  }
  return null;
}

function parseReviewRating($: CheerioAPI, card: ReturnType<CheerioAPI>, cardText: string): number | null {
  const label =
    card.find('[aria-label*="out of 5" i]').first().attr('aria-label') ??
    card.attr('aria-label') ??
    card.find('[data-rating]').first().attr('data-rating') ??
    '';
  const fromLabel = /([0-5](?:\.\d)?)\s*(?:out of|\/)\s*5/i.exec(label);
  if (fromLabel) {
    const n = toFloat(fromLabel[1]);
    if (n !== null) return Math.round(n);
  }
  const bare = toFloat(label);
  if (bare !== null && bare >= 1 && bare <= 5) return Math.round(bare);

  try {
    const filled = card.find('[class*="star--filled" i], [class*="star-filled" i], [data-star="filled"]').length;
    if (filled >= 1 && filled <= 5) return filled;
  } catch {
    // selector unsupported; fall through
  }

  const fromText = /([0-5](?:\.\d)?)\s*(?:out of|\/)\s*5/i.exec(cardText);
  const n = fromText ? toFloat(fromText[1]) : null;
  return n === null ? null : Math.round(n);
}

function externalDomain($: CheerioAPI, card: ReturnType<CheerioAPI>): string | null {
  let found: string | null = null;
  card.find('a[href^="http"]').each((_i, el) => {
    if (found) return;
    const href = $(el).attr('href') ?? '';
    try {
      const host = new URL(href).hostname.replace(/^www\./, '');
      if (!host.endsWith('shopify.com') && !host.endsWith('shopifycdn.com')) found = host;
    } catch {
      // ignore unparseable hrefs
    }
  });
  return found;
}

export function parseReviews(html: string, sourceUrl: string): ExtractedReview[] {
  let $: CheerioAPI;
  try {
    $ = load(html);
  } catch (err) {
    logger.warn('review page would not parse', { sourceUrl, err: String(err) });
    return [];
  }
  try {
    $('script, style, noscript, svg, iframe').remove();
  } catch {
    // non-fatal
  }

  for (const sel of REVIEW_CARD_SELECTORS) {
    let cards;
    try {
      cards = $(sel);
    } catch {
      continue;
    }
    if (cards.length === 0) continue;

    const reviews: ExtractedReview[] = [];
    cards.each((_i, el) => {
      try {
        const card = $(el);
        const cardText = collapse(card.text());
        if (cardText.length < 12) return;

        const body = scopedFirstText($, card, REVIEW_BODY_SELECTORS) ?? cardText;
        const merchantName = scopedFirstText($, card, REVIEW_AUTHOR_SELECTORS);
        const datetimeAttr = card.find('time[datetime]').first().attr('datetime');

        reviews.push({
          sourceUrl,
          rating: parseReviewRating($, card, cardText),
          reviewDate: parseReviewDate(cardText, datetimeAttr),
          merchantName: merchantName && merchantName.length <= 120 ? merchantName : null,
          merchantDomainIfPublic: externalDomain($, card),
          usageDuration: extractUsageDuration(cardText),
          text: body.slice(0, 2000),
          paymentSignal: classifyReviewPaymentSignal(cardText),
          complaintTags: tagComplaints(cardText),
        });
      } catch (err) {
        logger.warn('skipping unparseable review card', { sourceUrl, err: String(err) });
      }
    });

    if (reviews.length > 0) return reviews;
  }
  return [];
}

// --- listing -----------------------------------------------------------------

const TITLE_SELECTORS = [
  '[data-testid="app-name"]',
  'h1.ui-app-store-hero__heading',
  '[class*="app-name" i]',
  'h1',
  'meta[property="og:title"]',
];

const DEVELOPER_SELECTORS = [
  '[data-testid="app-developer"]',
  '[class*="developer-name" i]',
  '[class*="app-developer" i]',
  'a[href*="/partners/"]',
];

const DESCRIPTION_SELECTORS = [
  'meta[name="description"]',
  'meta[property="og:description"]',
  '[data-testid="app-description"]',
  '[class*="app-description" i]',
  'main p',
  'p',
];

/**
 * Parses one marketplace app listing. NEVER throws: a page that cannot be
 * parsed at all returns an empty listing with a warning recorded.
 */
export function parseAppListing(html: string, url: string): ParsedListing {
  const warnings: string[] = [];
  const empty: ParsedListing = {
    url,
    name: null,
    developer: null,
    description: '',
    plans: [],
    pricingText: '',
    currentPricing: null,
    freePlanDetails: null,
    hasPermanentFreeTier: null,
    freeTrialDays: null,
    freeToInstall: false,
    reviewCount: null,
    rating: null,
    launchAge: null,
    reviews: [],
    parseWarnings: warnings,
    ambiguous: false,
  };

  let $: CheerioAPI;
  try {
    $ = load(html ?? '');
  } catch (err) {
    warnings.push(`document would not parse: ${String(err)}`);
    logger.warn('listing would not parse', { url, err: String(err) });
    return empty;
  }

  const safe = <T>(field: string, fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (err) {
      warnings.push(`${field}: ${String(err)}`);
      logger.warn('field parse failed', { url, field, err: String(err) });
      return fallback;
    }
  };

  const name = safe('name', () => firstText($, TITLE_SELECTORS), null);
  const developer = safe('developer', () => firstText($, DEVELOPER_SELECTORS), null);
  const description = safe('description', () => firstText($, DESCRIPTION_SELECTORS) ?? '', '');
  const reviews = safe('reviews', () => parseReviews(html, url), []);

  // Compute text AFTER the review pass so boilerplate removal cannot affect it.
  const pageText = safe('pageText', () => htmlToText(html), '');
  const pricingText = safe('pricingText', () => pricingRegionText($), '');

  let plans = safe('plans', () => parsePlanCards($), []);
  if (plans.length === 0 && pricingText) {
    plans = safe('plansFromText', () => plansFromText(pricingText), []);
  }

  const freeTier = safe(
    'freeTier',
    () => decideFreeTier(plans, pricingText || pageText),
    { hasPermanentFreeTier: null, freeToInstall: false, freePlanDetails: null },
  );

  const reviewCount = safe('reviewCount', () => parseReviewCount($, pageText), null);
  const rating = safe('rating', () => parseRating($, pageText), null);
  const launchAge = safe('launchAge', () => parseLaunchAge(pageText), null);
  const freeTrialDays = safe('freeTrialDays', () => extractFreeTrialDays(pricingText || pageText), null);

  const pricedPlans = plans.filter((p) => p.priceMonthly !== null);
  const ambiguous =
    pricedPlans.length === 0 &&
    freeTier.hasPermanentFreeTier === null &&
    (pricingText.length > 0 || FREE_TRIAL.test(pageText));

  return {
    url,
    name,
    developer,
    description: description.slice(0, 1000),
    plans,
    pricingText,
    currentPricing: summarizePricing(plans),
    freePlanDetails: freeTier.freePlanDetails,
    hasPermanentFreeTier: freeTier.hasPermanentFreeTier,
    freeTrialDays,
    freeToInstall: freeTier.freeToInstall,
    reviewCount,
    rating,
    launchAge,
    reviews,
    parseWarnings: warnings,
    ambiguous,
  };
}

/** Short, boilerplate-free snippet. The ONLY text ever sent to an LLM. */
export function pricingSnippet(listing: ParsedListing, maxChars = 1200): string {
  const base = listing.pricingText || listing.description;
  return collapse(base).slice(0, maxChars);
}
