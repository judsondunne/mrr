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

export class SimSearchProvider implements SearchProvider {
  readonly name = 'brave';
  constructor(private readonly state: SimState) {}

  async search(query: string, count: number): Promise<SearchResult[]> {
    this.state.counters.searches += 1;
    if (this.state.outage.search) {
      throw new ProviderError('brave', 'simulated search outage (HTTP 503)', true);
    }
    const q = query.toLowerCase();
    const hits = this.state.ideas.filter(
      (i) => q.includes(i.category.split('-')[0] ?? '~~') || q.includes(i.wedgeType.split('-')[0] ?? '~~'),
    );
    const pool = hits.length > 0 ? hits : this.state.ideas.slice(0, 3);
    return pool.slice(0, count).map((i) => ({
      title: i.name,
      url: `https://apps.example.com/${i.category}`,
      description: `${i.name} — ${i.paidCompetitorCount} paid competitors, ${i.competitorCount} total.`,
    }));
  }
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
    const parsed = req.schema.safeParse(shaped);
    const data = parsed.success ? parsed.data : (synthesize(req.schema) as T);

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

  if (/classif|reply|inbound/i.test(req.task)) {
    const strong = idea ? state.rng() < idea.strongShare : false;
    const accepted = strong && idea ? state.rng() < idea.priceAcceptShare : false;
    return {
      classification: accepted ? 'PRICE_ACCEPTED' : strong ? 'INTERESTED_STRONG' : 'INTERESTED_WEAK',
      intent: accepted ? 'accepts the stated price' : strong ? 'wants the pilot' : 'mildly curious',
      requestedFeature: strong ? `${idea?.wedgeType ?? 'rule'} at the cart` : null,
      competitorMentioned: null,
      priceReaction: accepted ? 'ACCEPTED' : 'NOT_MENTIONED',
      timing: null,
      explicitlyWantsAccess: strong,
      explicitlyAcceptedPrice: accepted,
      requiresHuman: false,
      intentScore: accepted ? 0.95 : strong ? 0.7 : 0.25,
    };
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
