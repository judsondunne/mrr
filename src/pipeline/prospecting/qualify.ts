/**
 * ICP qualification against the REAL site.
 *
 * Non-negotiable: a prospect is never qualified from a search snippet when the
 * underlying site can be fetched. We fetch the page, read the actual text, and
 * only then decide. Deterministic signal matching decides most cases; the
 * cheap/fast tier is consulted only for the genuinely ambiguous ones, on
 * extracted text, with a schema — and its answer is discarded unless the quote
 * it cites is really on the page.
 */
import { z } from 'zod';
import type { Wedge } from '../../lib/contracts';
import { getDb } from '../../lib/db';
import { politeFetch } from '../../lib/fetch';
import { createLogger } from '../../lib/logger';
import { llmComplete } from '../../lib/llm/index';
import { BudgetExceededError } from '../../lib/errors';
import { extractText, looksLikeAuthWall } from './html';
import { findPublicContact, preferredRolesForWedge, type FetchedPage } from './contact';

const logger = createLogger('prospecting:qualify');

export type SignalKind = 'ICP' | 'WORKFLOW' | 'ECOSYSTEM' | 'COMMERCE';

export interface IcpSignal {
  phrase: string;
  weight: number;
  kind: SignalKind;
}

const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'with', 'that', 'who', 'they', 'their', 'from', 'this', 'have', 'has',
  'are', 'was', 'were', 'but', 'not', 'only', 'need', 'needs', 'want', 'wants', 'use', 'uses',
  'using', 'one', 'two', 'all', 'any', 'more', 'than', 'then', 'them', 'into', 'out', 'own',
  'you', 'your', 'our', 'its', 'can', 'will', 'just', 'each', 'per', 'every', 'when', 'where',
  'what', 'how', 'also', 'very', 'such', 'some', 'most', 'many', 'about', 'after', 'before',
  'while', 'which', 'there', 'here', 'over', 'under', 'been', 'being', 'both', 'other',
  'a', 'an', 'of', 'on', 'in', 'to', 'by', 'or', 'is', 'it', 'as', 'at', 'be', 'do',
]);

export function keywordsFrom(text: string, max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9-]+/)) {
    const word = raw.trim();
    if (word.length < 4 || STOPWORDS.has(word)) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    out.push(word);
    if (out.length >= max) break;
  }
  return out;
}

const ECOSYSTEM_SIGNALS: Readonly<Record<string, readonly string[]>> = {
  shopify: ['powered by shopify', 'cdn.shopify.com', 'myshopify.com', 'shopify'],
  woocommerce: ['woocommerce', 'wp-content/plugins/woocommerce'],
  bigcommerce: ['bigcommerce'],
  squarespace: ['squarespace'],
};

const COMMERCE_SIGNALS: readonly string[] = [
  'add to cart',
  'shopping cart',
  'checkout',
  'shipping',
  'my account',
  'our products',
  'shop all',
  'order now',
];

/** Pages that sell TO merchants are not merchants. */
const VENDOR_SIGNALS: readonly string[] = [
  'shopify app store',
  'install our app',
  'install the app',
  'book a demo',
  'start your free trial today',
  'trusted by thousands of merchants',
  'for merchants',
  'our customers include',
  'request a demo',
];

export function buildIcpSignals(wedge: Wedge, ecosystem: string): IcpSignal[] {
  const signals: IcpSignal[] = [];
  const push = (phrase: string, weight: number, kind: SignalKind): void => {
    const p = phrase.toLowerCase().trim();
    if (p.length < 3) return;
    if (signals.some((s) => s.phrase === p)) return;
    signals.push({ phrase: p, weight, kind });
  };

  for (const word of keywordsFrom(`${wedge.targetCustomer} ${wedge.whoItIsFor}`, 8)) {
    push(word, 3, 'ICP');
  }
  for (const word of keywordsFrom(`${wedge.coreWorkflow} ${wedge.v1Features.join(' ')}`, 8)) {
    push(word, 1, 'WORKFLOW');
  }
  for (const marker of ECOSYSTEM_SIGNALS[ecosystem.toLowerCase()] ?? []) {
    push(marker, 2, 'ECOSYSTEM');
  }
  for (const marker of COMMERCE_SIGNALS) push(marker, 1, 'COMMERCE');
  return signals;
}

export interface IcpVerdict {
  decision: 'FIT' | 'NOT_FIT' | 'UNDECIDED';
  score: number;
  matched: string[];
  reason: string;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Code decides whenever code can. Only a genuinely ambiguous page — some ICP
 * evidence but not enough to be sure — is escalated.
 */
export function deterministicIcpCheck(text: string, signals: readonly IcpSignal[]): IcpVerdict {
  const haystack = text.toLowerCase();
  if (haystack.trim() === '') {
    return { decision: 'NOT_FIT', score: 0, matched: [], reason: 'page had no readable text' };
  }

  const matched: string[] = [];
  let earned = 0;
  let possible = 0;
  const byKind: Record<SignalKind, number> = { ICP: 0, WORKFLOW: 0, ECOSYSTEM: 0, COMMERCE: 0 };

  for (const signal of signals) {
    possible += signal.weight;
    if (!haystack.includes(signal.phrase)) continue;
    matched.push(signal.phrase);
    earned += signal.weight;
    byKind[signal.kind] += 1;
  }

  const vendorHits = VENDOR_SIGNALS.filter((v) => haystack.includes(v));
  const score = possible > 0 ? round3(Math.min(1, earned / possible)) : 0;

  // Vendor prose plus no storefront evidence at all: this page sells TO the
  // ICP, it is not the ICP. Merchants' own pages carry cart/checkout signals.
  if (vendorHits.length >= 2 && byKind.ECOSYSTEM + byKind.COMMERCE === 0) {
    return {
      decision: 'NOT_FIT',
      score,
      matched,
      reason: `page sells to merchants rather than being one (${vendorHits.slice(0, 2).join(', ')})`,
    };
  }
  if (matched.length === 0) {
    return { decision: 'NOT_FIT', score: 0, matched, reason: 'no ICP, workflow or commerce signal on the page' };
  }
  if (byKind.ICP >= 2 && byKind.ECOSYSTEM + byKind.COMMERCE >= 1) {
    return {
      decision: 'FIT',
      score,
      matched,
      reason: `page shows ${byKind.ICP} ICP signals and a live storefront (${matched.slice(0, 4).join(', ')})`,
    };
  }
  if (byKind.ICP === 0 && byKind.COMMERCE + byKind.ECOSYSTEM <= 1) {
    return { decision: 'NOT_FIT', score, matched, reason: 'no ICP signal and no storefront evidence' };
  }
  return {
    decision: 'UNDECIDED',
    score,
    matched,
    reason: `ambiguous: ${matched.slice(0, 5).join(', ')}`,
  };
}

const IcpJudgement = z.object({
  fitsIcp: z.boolean(),
  reason: z.string().max(240),
  /** Must be copied verbatim from the supplied page text. Verified in code. */
  evidenceQuote: z.string().max(200),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
});

const JUDGEMENT_SYSTEM = [
  'You decide whether ONE business matches a described ideal customer profile.',
  'You are given text extracted from that business\'s own public web page.',
  'Rules:',
  '- Judge only from the supplied text. If the text does not show it, the answer is false.',
  '- evidenceQuote must be copied VERBATIM from the supplied text. Do not paraphrase.',
  '- A company that sells software/services to this kind of business is NOT a match.',
  '- Be strict. A weak maybe is a false.',
].join('\n');

export const MAX_JUDGEMENT_TEXT = 6000;

function normalizeForQuoteCheck(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

async function judgeWithFastTier(
  wedge: Wedge,
  pageUrl: string,
  text: string,
): Promise<{ fit: boolean; reason: string; quote: string | null }> {
  const excerpt = text.slice(0, MAX_JUDGEMENT_TEXT);
  const res = await llmComplete({
    tier: 'fast',
    task: 'prospect.icp_judgement',
    schemaName: 'IcpJudgement',
    system: JUDGEMENT_SYSTEM,
    schema: IcpJudgement,
    maxTokens: 400,
    user: [
      `Ideal customer profile: ${wedge.targetCustomer}`,
      `They repeatedly need to: ${wedge.coreWorkflow}`,
      `Page URL: ${pageUrl}`,
      '',
      'Page text:',
      excerpt,
    ].join('\n'),
  });

  const quote = res.data.evidenceQuote.trim();
  const quoteIsReal = quote !== '' && normalizeForQuoteCheck(text).includes(normalizeForQuoteCheck(quote));
  if (res.data.fitsIcp && !quoteIsReal) {
    logger.warn('discarding qualification: cited evidence is not on the page', { pageUrl });
    return { fit: false, reason: 'model cited evidence that is not on the page', quote: null };
  }
  return {
    fit: res.data.fitsIcp,
    reason: res.data.reason.slice(0, 240),
    quote: quoteIsReal ? quote : null,
  };
}

// --- per-prospect qualification ---------------------------------------------

export interface ProspectToQualify {
  id: string;
  domain: string;
  company_name: string;
  public_evidence_url: string | null;
}

export interface QualificationOutcome {
  prospectId: string;
  domain: string;
  status: 'QUALIFIED' | 'DISQUALIFIED';
  icpFit: boolean;
  reachable: boolean;
  score: number;
  reason: string;
  evidenceUrl: string | null;
  evidenceQuote: string | null;
  contactEmail: string | null;
  contactSourceUrl: string | null;
  country: string | null;
  usedLlm: boolean;
}

async function fetchPublicPage(url: string): Promise<FetchedPage | null> {
  try {
    const res = await politeFetch(url);
    if (res.contentType !== '' && !res.contentType.includes('html')) return null;
    if (looksLikeAuthWall(res.body, res.finalUrl)) {
      logger.debug('refusing to read a page behind auth', { url });
      return null;
    }
    return { url: res.finalUrl || url, html: res.body, text: extractText(res.body) };
  } catch (err) {
    logger.debug('prospect page fetch failed', { url, err: String(err) });
    return null;
  }
}

export interface QualifyOptions {
  /** Default true. False keeps the pass strictly deterministic. */
  allowLlm?: boolean;
  maxContactPages?: number;
}

/**
 * Fetches the prospect's real site, verifies ICP fit against page content, and
 * looks for a published business address. Persists the verdict.
 */
export async function qualifyProspect(params: {
  prospect: ProspectToQualify;
  wedge: Wedge;
  ecosystem: string;
  signals?: readonly IcpSignal[];
  options?: QualifyOptions;
}): Promise<QualificationOutcome> {
  const { prospect, wedge, ecosystem } = params;
  const options = params.options ?? {};
  const signals = params.signals ?? buildIcpSignals(wedge, ecosystem);

  const candidateUrls = [prospect.public_evidence_url, `https://${prospect.domain}/`].filter(
    (u): u is string => typeof u === 'string' && u.trim() !== '',
  );
  const pages: FetchedPage[] = [];
  for (const url of candidateUrls) {
    if (pages.some((p) => p.url === url)) continue;
    const page = await fetchPublicPage(url);
    if (page) pages.push(page);
    if (pages.length >= 2) break;
  }

  if (pages.length === 0) {
    // Refusing to qualify from the search snippet is the entire point.
    return finish({
      prospect,
      status: 'DISQUALIFIED',
      icpFit: false,
      reachable: false,
      score: 0,
      reason: 'site could not be fetched publicly; refusing to qualify from a search snippet',
      evidenceUrl: null,
      evidenceQuote: null,
      contact: null,
      usedLlm: false,
      pages,
    });
  }

  const combinedText = pages.map((p) => p.text).join(' \n ');
  const evidencePage = pages[0];
  const verdict = deterministicIcpCheck(combinedText, signals);

  let icpFit = verdict.decision === 'FIT';
  let reason = verdict.reason;
  let score = verdict.score;
  let quote: string | null = null;
  let usedLlm = false;

  if (verdict.decision === 'UNDECIDED' && options.allowLlm !== false) {
    usedLlm = true;
    try {
      const judged = await judgeWithFastTier(wedge, evidencePage?.url ?? prospect.domain, combinedText);
      icpFit = judged.fit;
      reason = judged.reason;
      quote = judged.quote;
      if (judged.fit) score = Math.max(score, 0.5);
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      logger.warn('icp judgement failed; treating as not qualified', {
        domain: prospect.domain,
        err: String(err),
      });
      icpFit = false;
      reason = `could not decide ICP fit: ${String(err)}`.slice(0, 240);
    }
  } else if (verdict.decision === 'UNDECIDED') {
    icpFit = false;
    reason = `ambiguous and LLM judgement disabled (${verdict.reason})`;
  }

  if (!icpFit) {
    return finish({
      prospect,
      status: 'DISQUALIFIED',
      icpFit: false,
      reachable: false,
      score,
      reason,
      evidenceUrl: evidencePage?.url ?? null,
      evidenceQuote: quote,
      contact: null,
      usedLlm,
      pages,
    });
  }

  const contact = await findPublicContact({
    domain: prospect.domain,
    seedUrls: [],
    prefetched: pages,
    maxPages: options.maxContactPages ?? 3,
    // A wholesale offer should reach wholesale@, not the support queue.
    preferredRoles: preferredRolesForWedge(
      `${wedge.targetCustomer} ${wedge.whoItIsFor} ${wedge.coreWorkflow} ${wedge.statement}`,
    ),
  });

  return finish({
    prospect,
    status: contact ? 'QUALIFIED' : 'DISQUALIFIED',
    icpFit: true,
    reachable: contact !== null,
    score: contact ? Math.min(1, round3(score + (contact.isRole ? 0.2 : 0.1))) : score,
    reason: contact
      ? `${reason}; public ${contact.isRole ? 'role' : 'business'} address published at ${contact.sourceUrl}`
      : `${reason}; no public business address found on the site`,
    evidenceUrl: evidencePage?.url ?? null,
    evidenceQuote: quote,
    contact,
    usedLlm,
    pages,
  });
}

async function finish(args: {
  prospect: ProspectToQualify;
  status: 'QUALIFIED' | 'DISQUALIFIED';
  icpFit: boolean;
  reachable: boolean;
  score: number;
  reason: string;
  evidenceUrl: string | null;
  evidenceQuote: string | null;
  contact: Awaited<ReturnType<typeof findPublicContact>>;
  usedLlm: boolean;
  pages: readonly FetchedPage[];
}): Promise<QualificationOutcome> {
  const { prospect, contact } = args;
  const reason = args.reason.slice(0, 500);
  const db = await getDb();
  await db.query(
    `UPDATE prospects
        SET status = $2,
            qualification_reason = $3,
            qualification_score = $4,
            public_evidence_url = COALESCE($5, public_evidence_url),
            contact_email = $6,
            contact_source_url = $7,
            email_is_public = $8,
            country = $9,
            evidence_json = $10,
            updated_at = now()
      WHERE id = $1`,
    [
      prospect.id,
      args.status,
      reason,
      args.score,
      args.evidenceUrl,
      contact?.email ?? null,
      contact?.sourceUrl ?? null,
      contact !== null,
      contact?.country ?? null,
      JSON.stringify({
        icpFit: args.icpFit,
        reachable: args.reachable,
        decidedBy: args.usedLlm ? 'FAST_LLM' : 'DETERMINISTIC',
        evidenceQuote: args.evidenceQuote,
        pagesFetched: args.pages.map((p) => p.url),
        contactPages: contact?.pagesFetched ?? [],
        checkedAt: new Date().toISOString(),
      }),
    ],
  );

  return {
    prospectId: prospect.id,
    domain: prospect.domain,
    status: args.status,
    icpFit: args.icpFit,
    reachable: args.reachable,
    score: args.score,
    reason,
    evidenceUrl: args.evidenceUrl,
    evidenceQuote: args.evidenceQuote,
    contactEmail: contact?.email ?? null,
    contactSourceUrl: contact?.sourceUrl ?? null,
    country: contact?.country ?? null,
    usedLlm: args.usedLlm,
  };
}
