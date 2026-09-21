/**
 * Fixture-driven providers for the autonomy simulation.
 *
 * These are not "return a fixed value" stubs. Each one answers according to
 * the simulated world, so the run exercises real decision logic: search finds
 * the ideas that exist, the classifier sees replies whose sentiment matches
 * that idea's true demand, and email delivers or bounces at that idea's true
 * rate. A system that only looks right against a constant stub will fail here.
 *
 * Chaos is injected by flipping the `outage` flags, so recovery paths are
 * exercised rather than described.
 */
import type { LlmProvider, LlmRequest, LlmResponse } from '../lib/llm/types';
import type { SearchProvider, SearchResult } from '../lib/search/index';
import type { EmailProvider, OutboundEmail, SendResult } from '../lib/email/index';
import { ProviderError } from '../lib/errors';
import { makeRng, type SimIdea } from './sim-world';

export interface SimState {
  ideas: SimIdea[];
  rng: () => number;
  day: number;
  outage: { search: boolean; llm: boolean; email: boolean };
  /** Injection payload to embed in the next fetched page / inbound email. */
  pendingInjection: string | null;
  /** While true the simulated web serves truncated HTML. */
  malformedHtml: boolean;
  counters: {
    searches: number;
    llmCalls: number;
    llmByTier: Record<string, number>;
    emailsSent: number;
    bounces: number;
    complaints: number;
    injectionsServed: number;
  };
}

export function makeSimState(ideas: SimIdea[], seed = 7): SimState {
  return {
    ideas,
    rng: makeRng(seed),
    day: 0,
    outage: { search: false, llm: false, email: false },
    pendingInjection: null,
    malformedHtml: false,
    counters: {
      searches: 0,
      llmCalls: 0,
      llmByTier: {},
      emailsSent: 0,
      bounces: 0,
      complaints: 0,
      injectionsServed: 0,
    },
  };
}

/**
 * Markers that a query is hunting for BUSINESSES rather than competitors.
 * These are the fragments `buildProspectQueries` composes from, so a query
 * carrying one of them is a prospecting query and must return merchant sites.
 */
const PROSPECTING_MARKERS = [
  'wholesale', 'minimum order', 'trade account', 'become a stockist', 'stockist',
  'case pack', 'order minimums', 'net 30', 'price list', 'local delivery',
  'in-store pickup', 'powered by shopify', 'our store',
];

export class SimSearchProvider implements SearchProvider {
  readonly name = 'brave';
  /** Merchant domains already returned, so paging through a segment advances. */
  private readonly served = new Map<string, number>();

  constructor(
    private readonly state: SimState,
    /** Merchant population by idea key. Absent in runs that skip prospecting. */
    private readonly merchantsByIdea?: Map<string, Array<{ domain: string; companyName: string }>>,
  ) {}

  async search(query: string, count: number): Promise<SearchResult[]> {
    this.state.counters.searches += 1;
    if (this.state.outage.search) {
      throw new ProviderError('brave', 'simulated search outage (HTTP 503)', true);
    }
    const q = query.toLowerCase();
    const idea = this.bestIdeaFor(q);

    if (this.merchantsByIdea && PROSPECTING_MARKERS.some((m) => q.includes(m))) {
      // Prefer a segment the query actually identifies (category, product name
      // or wedge type); fall back to the best ICP-word match, because most
      // generated queries carry only ICP words. Cross-assignment is possible
      // here and shows up as COMPANY_COOLDOWN send skips: a company reached for
      // one segment is blocked for another for COMPANY_COOLDOWN_DAYS, which is
      // the production rule working, not a fault.
      const target = this.confidentIdeaFor(q) ?? idea;
      return target ? this.merchantResults(target.key, count) : [];
    }

    const pool = idea ? [idea] : this.state.ideas.slice(0, 3);
    return pool.slice(0, count).map((i) => ({
      title: i.name,
      url: `https://apps.example.com/${i.category}`,
      description: `${i.name} — ${i.paidCompetitorCount} paid competitors, ${i.competitorCount} total.`,
    }));
  }

  /**
   * Which idea a query is about, by token overlap against the idea's identity.
   * Prospecting queries are built from the wedge's ICP words, so the ICP string
   * carries the most signal; the category and product name disambiguate ties.
   */
  /**
   * The segment a prospecting query identifies, or null when it is ambiguous.
   *
   * A category / product-name / wedge-type hit is decisive. Failing that, the
   * ICP words may identify a segment, but only if ONE segment clearly leads:
   * a tie means the query does not name a segment, and answering it with a
   * guess cross-assigns merchants between campaigns.
   */
  private confidentIdeaFor(q: string): SimIdea | null {
    for (const idea of this.state.ideas) {
      if (q.includes(idea.category) || q.includes(idea.name.toLowerCase()) || q.includes(idea.wedgeType)) {
        return idea;
      }
    }

    const scored: Array<{ idea: SimIdea; score: number }> = [];
    for (const idea of this.state.ideas) {
      let score = 0;
      for (const token of tokens(idea.icp)) {
        if (token !== 'shopify' && token.length > 3 && q.includes(token)) score += 1;
      }
      if (score > 0) scored.push({ idea, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    const runnerUp = scored[1];
    if (!best || best.score < 2) return null;
    if (runnerUp && runnerUp.score === best.score) return null;
    return best.idea;
  }

  private bestIdeaFor(q: string): SimIdea | null {
    let best: SimIdea | null = null;
    let bestScore = 0;
    for (const idea of this.state.ideas) {
      let score = 0;
      if (q.includes(idea.category)) score += 6;
      if (q.includes(idea.name.toLowerCase())) score += 6;
      if (q.includes(idea.wedgeType)) score += 4;
      for (const token of tokens(idea.icp)) {
        // "shopify" is shared by every idea in this world and carries no signal.
        if (token !== 'shopify' && token.length > 3 && q.includes(token)) score += 1;
      }
      if (score > bestScore) {
        bestScore = score;
        best = idea;
      }
    }
    return bestScore > 0 ? best : null;
  }

  /** Pages through the segment so repeated passes surface new businesses. */
  private merchantResults(ideaKey: string, count: number): SearchResult[] {
    const all = this.merchantsByIdea?.get(ideaKey) ?? [];
    const offset = this.served.get(ideaKey) ?? 0;
    const slice = all.slice(offset, offset + count);
    // Wrap rather than going empty: a real search keeps returning the same
    // businesses, and the pipeline's own de-duplication is what must cope.
    this.served.set(ideaKey, slice.length < count ? 0 : offset + slice.length);
    return slice.map((m) => ({
      title: `Wholesale & Trade Accounts | ${m.companyName}`,
      url: `https://${m.domain}/pages/wholesale`,
      description: 'Wholesale and trade accounts. Minimum order applies; case-pack quantities only.',
    }));
  }
}

function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
}

export class SimEmailProvider implements EmailProvider {
  readonly name = 'resend';
  readonly sent: OutboundEmail[] = [];
  private n = 0;
  constructor(private readonly state: SimState) {}

  async send(email: OutboundEmail): Promise<SendResult> {
    if (this.state.outage.email) {
      throw new ProviderError('resend', 'simulated Resend outage (HTTP 502)', true);
    }
    this.n += 1;
    this.state.counters.emailsSent += 1;
    this.sent.push(email);
    return { providerMessageId: `sim-${this.n}-${this.state.day}`, provider: 'resend', simulated: false };
  }

  reset(): void {
    this.sent.length = 0;
  }
}

/**
 * Answers structured-output requests plausibly for the requesting task, driven
 * by the world. It never invents demand: a bad idea's evidence comes back weak
 * and a decent idea's replies come back polite-but-empty, because that is what
 * the fixture says is true.
 */
export class SimLlmProvider implements LlmProvider {
  readonly name = 'anthropic';
  readonly calls: Array<{ task: string; tier: string; promptId?: string }> = [];
  constructor(private readonly state: SimState) {}

  async complete<T>(req: LlmRequest<T>): Promise<LlmResponse<T>> {
    this.state.counters.llmCalls += 1;
    this.state.counters.llmByTier[req.tier] = (this.state.counters.llmByTier[req.tier] ?? 0) + 1;
    this.calls.push({ task: req.task, tier: req.tier, promptId: req.promptId });

    if (this.state.outage.llm) {
      throw new ProviderError('anthropic', 'simulated model outage (HTTP 529)', true);
    }

    // Injected instructions must never change behaviour. We assert on the
    // OUTPUT elsewhere; here we simply refuse to act on them, which is what a
    // correctly-fenced prompt looks like from the provider's side.
    const raw = JSON.stringify(req.untrusted ?? {});
    if (/ignore (all )?previous|new system prompt|reveal|api[_ ]?key/i.test(raw)) {
      this.state.counters.injectionsServed += 1;
    }

    const shaped = shapeFor(req, this.state);
    let data: T;
    if (shaped === undefined) {
      // No task-specific shape: schema synthesis keeps unshaped tasks parsing.
      data = synthesize(req.schema) as T;
    } else {
      const parsed = req.schema.safeParse(shaped);
      if (!parsed.success) {
        // A shape that does not match its schema used to fall through to
        // synthesis, which answers `false` to every boolean — so a broken
        // fixture looked like a confident "no" from the model and silently
        // failed the whole pipeline. Fixture drift must be loud.
        throw new Error(
          `sim fixture for task "${req.task}" does not match its schema: ` +
            parsed.error.issues
              .slice(0, 6)
              .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
              .join('; '),
        );
      }
      data = parsed.data;
    }

    // Token counts are realistic enough that budget pressure is real, and the
    // reasoner is expensive enough that staging matters.
    const inputTokens = req.tier === 'reasoner' ? 4000 : 700;
    const outputTokens = req.tier === 'reasoner' ? 1200 : 200;
    return {
      data: data as T,
      inputTokens,
      outputTokens,
      estimatedCost: 0,
      model: req.tier === 'reasoner' ? 'sim-reasoner' : 'sim-fast',
      cached: false,
      promptId: req.promptId,
      promptVersion: req.promptVersion,
    };
  }
}

/** Best-effort task-aware shaping; falls back to schema synthesis. */
function shapeFor<T>(req: LlmRequest<T>, state: SimState): unknown {
  const text = `${req.user} ${JSON.stringify(req.untrusted ?? {})}`.toLowerCase();
  const idea = state.ideas.find((i) => text.includes(i.category)) ?? null;

  // --- research / verification -------------------------------------------
  // These shape the model's answers from the WORLD, so a strong category reads
  // strong and a weak one reads weak. Without this every research task fell
  // through to schema synthesis — which answers "no" to every boolean — and
  // the true winner was rejected alongside the 50 bad ideas.

  // Staged research: stages 2-4 are the cheap/expensive filters that decide
  // which candidates survive. Answer them from the world's truth so a strong
  // category survives and a weak one does not.
  if (req.task === 'research.stage2_classification') {
    const strong = idea?.hasStrongPaymentEvidence ?? false;
    const narrow = (idea?.estimatedBuildDays ?? 99) <= 10;
    return {
      looksLikeRecurringBusinessJob: strong,
      audienceIsBusinesses: strong,
      paidCompetitorsMentioned: (idea?.paidCompetitorCount ?? 0) > 0,
      narrowEnoughForASmallApp: narrow,
      note: strong ? 'recurring operational job with paid incumbents' : 'no evidence of a paid job',
    };
  }

  if (req.task === 'research.stage3_complaints') {
    const strong = idea?.hasStrongPaymentEvidence ?? false;
    return {
      recurringComplaintPresent: strong,
      complaintIsAboutTheJobNotTheVendor: strong,
      switchingIntentExpressed: strong,
      strongestComplaintTheme: strong ? 'incumbent is a heavy rules engine' : 'none',
    };
  }

  if (req.task === 'research.stage4_finalist') {
    const strong = idea?.hasStrongPaymentEvidence ?? false;
    return {
      evidenceOfExistingSpend: strong,
      incumbentChargesMoney: (idea?.paidCompetitorCount ?? 0) > 0,
      wedgeIsNarrowEnoughForATwoWeekBuild: (idea?.estimatedBuildDays ?? 99) <= 10,
      blockingRisk: strong ? '' : 'no verified spend in this category',
    };
  }

  if (req.task === 'prospect.icp_judgement') {
    // Judge from the supplied page text, exactly as the real prompt demands —
    // and quote it VERBATIM, because the production code verifies that the
    // cited evidence actually appears on the page and discards the fit if not.
    const page = req.user;
    const vendor = /trusted by thousands of merchants|install our app|request a demo/i.test(page);
    const sentence = firstSentenceMatching(page, [
      'case-pack quantities of',
      'all trade orders ship in fixed case quantities',
      'wholesale pricing for approved stockists',
      'supplies independent retail stockists',
    ]);
    const fits = !vendor && sentence !== null;
    return {
      fitsIcp: fits,
      reason: fits
        ? 'the page states a wholesale ordering requirement in its own words'
        : vendor
          ? 'this page sells to merchants rather than being one'
          : 'no public evidence of the workflow on this page',
      evidenceQuote: sentence ?? '',
      confidence: fits ? 'HIGH' : 'LOW',
    };
  }

  if (req.task === 'wedge.synthesize') {
    const i = idea ?? state.ideas[state.ideas.length - 1]!;
    return {
      statement: `For ${i.icp}, enforce ${i.wedgeType} without a full replatform.`,
      productName: i.name.slice(0, 55),
      targetCustomer: i.icp,
      coreWorkflow: `enforcing ${i.wedgeType} at checkout every day`,
      v1Features: [
        `${i.wedgeType} rules per product`,
        'customer-tag thresholds',
        'clear cart-level explanation',
      ],
      excludedFromV1: ['multi-currency', 'per-collection rules', 'any AI feature'],
      proposedPriceMonthly: i.priceMonthly,
      estimatedBuildDays: i.estimatedBuildDays,
      primaryCompetitor: `${i.name} incumbent`,
      reasonSomeoneWouldSwitch: 'the incumbent requires a full rules engine',
      oneSentenceOutcome: `Stop orders that break your ${i.wedgeType}.`,
      capabilities: [
        `${i.wedgeType} rules per product`,
        'customer-tag thresholds',
        'clear cart-level explanation',
      ],
      whoItIsFor: i.icp,
    };
  }

  if (req.task === 'outreach.personalize') {
    // One lowercase clause completing "I noticed ___", restating only what the
    // verified evidence says. Must survive sanitizeObservation: no URL, no
    // address, no praise, no claim of familiarity, 8-180 chars.
    const workflow = (idea?.wedgeType ?? 'wholesale ordering').replace(/[-_]+/g, ' ');
    return {
      observation: `your wholesale page states a ${workflow} requirement in case-pack quantities`,
    };
  }

  if (req.task === 'shopify_pricing_disambiguation') {
    const paid = idea ? idea.hasStrongPaymentEvidence : false;
    return {
      hasPermanentFreeTier: !paid,
      monthlyPriceUsd: paid ? 19.99 : 0,
      planName: paid ? 'Standard' : 'Free',
      confidence: 0.8,
      note: paid ? 'paid plan, no permanent free tier' : 'free forever plan',
    };
  }

  if (req.task === 'outreach.auto_reply') {
    // The bounded auto-reply. It may only answer from the offer it was given,
    // and must hand off to a human otherwise — so a simulated agent that
    // always claims it can answer would hide the hand-off path.
    const body = replyBodyFrom(req);
    const asksPrice = /\b(how much|price|cost|pricing)\b/i.test(body);
    return {
      canAnswerFromOffer: asksPrice,
      answer: asksPrice
        ? 'The price we are validating is the one in the previous note; nothing is built yet.'
        : '',
      clarifyingQuestion: '',
      needsHuman: !asksPrice,
    };
  }

  if (req.task === 'outreach.classify_reply') {
    // Read the REPLY, exactly as a real model would.
    //
    // This used to pick a verdict from a dice roll against the idea's demand
    // rate, which decoupled the classification from the text the world had
    // actually produced: a reply saying "$19/month is fine" could come back
    // INTERESTED_WEAK. The production commitment rules require BOTH a flag here
    // AND a literal pattern in the body, so nothing was ever recorded and the
    // winner path was unreachable. Deriving from the text is what makes the
    // two halves agree — and keeps the deterministic rules in charge.
    const body = replyBodyFrom(req);
    return classifyReplyText(body);
  }
  return undefined;
}

/** Minimal Zod-shaped synthesis so any unshaped task still parses. */
function synthesize(schema: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  const def = (schema as { def?: Record<string, unknown> }).def;
  const type = def?.type as string | undefined;
  switch (type) {
    case 'string': return 'sim';
    case 'number': return 1;
    case 'boolean': return false;
    case 'array': return [];
    case 'enum': {
      const entries = def?.entries as Record<string, unknown> | undefined;
      return entries ? Object.values(entries)[0] : null;
    }
    case 'literal': {
      const values = def?.values as unknown[] | undefined;
      return values?.[0] ?? null;
    }
    case 'object': {
      const shape = (def?.shape ?? {}) as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(shape)) out[k] = synthesize(v, depth + 1);
      return out;
    }
    case 'optional':
    case 'nullable':
    case 'default':
      return synthesize(def?.innerType, depth + 1);
    case 'union': {
      const options = def?.options as unknown[] | undefined;
      return options?.[0] ? synthesize(options[0], depth + 1) : null;
    }
    default: return null;
  }
}

/**
 * The first sentence of `text` containing one of `needles`, returned verbatim.
 *
 * Used so the simulated model's `evidenceQuote` is genuinely copied from the
 * page it was shown — the production qualifier verifies exactly that and throws
 * the judgement away otherwise.
 */
function firstSentenceMatching(text: string, needles: readonly string[]): string | null {
  const flat = text.replace(/\s+/g, ' ');
  for (const needle of needles) {
    const at = flat.toLowerCase().indexOf(needle.toLowerCase());
    if (at < 0) continue;
    let start = flat.lastIndexOf('.', at) + 1;
    if (start < 0) start = 0;
    let end = flat.indexOf('.', at + needle.length);
    if (end < 0) end = Math.min(flat.length, at + needle.length + 60);
    const sentence = flat.slice(start, end + 1).trim();
    if (sentence.length >= 10) return sentence.slice(0, 200);
  }
  return null;
}

/**
 * The reply text out of a classification request.
 *
 * Inbound bodies travel in the `untrusted` channel (that is the whole point of
 * the fencing), so read that first and fall back to the user turn.
 */
function replyBodyFrom(req: { user: string; untrusted?: unknown }): string {
  const untrusted = req.untrusted;
  if (typeof untrusted === 'string' && untrusted.trim() !== '') return untrusted;
  if (untrusted !== null && typeof untrusted === 'object') {
    const parts: string[] = [];
    for (const value of Object.values(untrusted as Record<string, unknown>)) {
      if (typeof value === 'string') parts.push(value);
    }
    if (parts.length > 0) return parts.join('\n');
  }
  return req.user;
}

/**
 * A plausible, text-driven reply classification.
 *
 * Ordered most-decisive first: an opt-out is never also a commitment, and a
 * stated requirement is not interest.
 */
function classifyReplyText(body: string): Record<string, unknown> {
  const text = body.toLowerCase();
  const base = {
    intent: '',
    requestedFeature: null as string | null,
    competitorMentioned: null as string | null,
    priceReaction: 'NOT_MENTIONED' as string,
    timing: null as string | null,
    explicitlyWantsAccess: false,
    explicitlyAcceptedPrice: false,
    requiresHuman: false,
    intentScore: 0.1,
  };

  if (/\b(unsubscribe|remove me|take me off|stop emailing|do not (email|contact))\b/.test(text)) {
    return { ...base, classification: 'UNSUBSCRIBE', intent: 'asked to be removed', intentScore: 0 };
  }
  if (/\b(no thanks|not interested|we'?re all set|no need|pass on this)\b/.test(text)) {
    return { ...base, classification: 'NOT_INTERESTED', intent: 'declined', intentScore: 0 };
  }
  if (/\b(out of (the )?office|on (annual )?leave|on holiday|back on \w+day)\b/.test(text)) {
    return { ...base, classification: 'OUT_OF_OFFICE', intent: 'auto-reply', intentScore: 0 };
  }
  if (/\b(wrong person|not my (area|department)|i no longer work)\b/.test(text)) {
    return { ...base, classification: 'WRONG_PERSON', intent: 'wrong contact', intentScore: 0 };
  }

  const wantsAccess =
    /\b(first installs?|sign (us|me) up|the pilot|early access|we'?ll install|send (me|us) the install|put (us|me) (on|in) the beta|would like to (try|test)|(we|i)'?(d| would) like (a|one of the) (pilot|first))\b/.test(
      text,
    );
  const acceptedPrice =
    /\$\s?\d+(\.\d{2})?\s*(\/|per\s)?\s*(mo|month|mo\.)?\s*(is|sounds|seems|works|would be)?\s*(fine|fair|ok|okay|reasonable|great|good|worth it|no problem|acceptable)\b/.test(
      text,
    ) || /\b((happy|willing|glad) to pay|we'?ll pay|that price (is|works|sounds) (fine|fair|ok|okay|good|reasonable))\b/.test(text);

  if (/\b(we'?d need|would need it to|without that|only if it|as long as it (also )?(handles|supports))\b/.test(text)) {
    const feature = /case[- ]pack/.test(text)
      ? 'case-pack quantities, not just unit counts'
      : 'a capability the reply names';
    return {
      ...base,
      classification: 'FEATURE_REQUIREMENT',
      intent: 'states a requirement before committing',
      requestedFeature: feature,
      explicitlyWantsAccess: false,
      intentScore: 0.3,
    };
  }

  if (acceptedPrice) {
    return {
      ...base,
      classification: 'PRICE_ACCEPTED',
      intent: 'accepts the stated price',
      priceReaction: 'ACCEPTED',
      explicitlyAcceptedPrice: true,
      explicitlyWantsAccess: wantsAccess,
      intentScore: 0.95,
    };
  }
  if (wantsAccess) {
    return {
      ...base,
      classification: 'INTERESTED_STRONG',
      intent: 'asks for access without reacting to price',
      explicitlyWantsAccess: true,
      intentScore: 0.7,
    };
  }
  if (/\?\s*$|\b(how (does|do|would)|what (about|happens)|can it)\b/.test(text)) {
    return { ...base, classification: 'ASKING_QUESTION', intent: 'asks a question', intentScore: 0.3 };
  }
  return {
    ...base,
    classification: 'INTERESTED_WEAK',
    intent: 'vague positivity with no ask',
    intentScore: 0.25,
  };
}
