/**
 * The single entry point for every LLM call in the system.
 *
 * Enforces, in this order:
 *   1. cache lookup by content hash  — unchanged content is never re-analyzed
 *   2. budget assertion              — refuses the call that would cross the cap
 *   3. provider call
 *   4. cost ledger write
 *   5. cache write
 *
 * Before adding a call site, ask: "can normal code do this?" If yes, do that.
 */
import { getConfig } from '../config';
import { getDb } from '../db';
import { sha256 } from '../hash';
import { createLogger } from '../logger';
import { assertBudget, estimateLlmCost, recordCosts } from '../cost';
import { AnthropicProvider } from './anthropic';
import { MockLlmProvider } from './mock';
import type { LlmProvider, LlmRequest, LlmResponse } from './types';

export type { LlmProvider, LlmRequest, LlmResponse, LlmTier } from './types';
export { MockLlmProvider } from './mock';

const logger = createLogger('llm');

let provider: LlmProvider | null = null;

export function getLlmProvider(): LlmProvider {
  if (!provider) {
    const cfg = getConfig();
    provider = cfg.llmProvider === 'mock' || !cfg.anthropicApiKey
      ? new MockLlmProvider()
      : new AnthropicProvider();
    if (cfg.llmProvider !== 'mock' && !cfg.anthropicApiKey) {
      logger.warn('ANTHROPIC_API_KEY missing — falling back to mock LLM provider (shadow-safe)');
    }
  }
  return provider;
}

export function setLlmProvider(p: LlmProvider | null): void {
  provider = p;
}

/** Content-addressed: identical inputs are never analyzed twice. */
function cacheKey<T>(req: LlmRequest<T>, model: string): string {
  return sha256(JSON.stringify([model, req.task, req.schemaName, req.system, req.user]));
}

/**
 * Rough pre-call cost estimate so the budget check happens BEFORE we spend.
 * ~4 chars/token is close enough to decide whether we are at the cap.
 */
function projectCost<T>(req: LlmRequest<T>): number {
  const approxIn = Math.ceil((req.system.length + req.user.length) / 4);
  const approxOut = req.maxTokens ?? 4096;
  return estimateLlmCost(req.tier, approxIn, approxOut);
}

export async function llmComplete<T>(req: LlmRequest<T>): Promise<LlmResponse<T>> {
  const cfg = getConfig();
  const model = req.tier === 'fast' ? cfg.llmFast : cfg.llmReasoner;
  const cacheable = req.cacheable !== false;
  const key = cacheKey(req, model);

  if (cacheable) {
    const hit = await readCache<T>(key, req);
    if (hit) return hit;
  }

  await assertBudget('LLM', projectCost(req));

  const res = await getLlmProvider().complete(req);
  const costProvider = res.model.startsWith('mock:') ? 'mock' : 'anthropic';

  await recordCosts([
    {
      provider: costProvider,
      resourceType: 'LLM_INPUT_TOKENS',
      quantity: res.inputTokens,
      estimatedCost: estimateLlmCost(req.tier, res.inputTokens, 0),
      metadata: { task: req.task, model: res.model, tier: req.tier },
    },
    {
      provider: costProvider,
      resourceType: 'LLM_OUTPUT_TOKENS',
      quantity: res.outputTokens,
      estimatedCost: estimateLlmCost(req.tier, 0, res.outputTokens),
      metadata: { task: req.task, model: res.model, tier: req.tier },
    },
  ]);

  if (cacheable) await writeCache(key, model, res);

  logger.debug('llm call complete', {
    task: req.task,
    tier: req.tier,
    model: res.model,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
    cost: res.estimatedCost,
  });
  return res;
}

async function readCache<T>(key: string, req: LlmRequest<T>): Promise<LlmResponse<T> | null> {
  try {
    const db = await getDb();
    const res = await db.query<{ response_json: unknown; model: string }>(
      'SELECT response_json, model FROM llm_cache WHERE cache_key = $1',
      [key],
    );
    const row = res.rows[0];
    if (!row) return null;
    const raw = typeof row.response_json === 'string' ? JSON.parse(row.response_json) : row.response_json;
    const parsed = req.schema.safeParse(raw);
    if (!parsed.success) return null; // schema changed since caching; re-run
    logger.debug('llm cache hit', { task: req.task });
    return {
      data: parsed.data as T,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      model: row.model,
      cached: true,
    };
  } catch (err) {
    logger.warn('llm cache read failed', { err: String(err) });
    return null;
  }
}

async function writeCache<T>(key: string, model: string, res: LlmResponse<T>): Promise<void> {
  try {
    const db = await getDb();
    await db.query(
      `INSERT INTO llm_cache (cache_key, model, response_json, input_tokens, output_tokens)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (cache_key) DO NOTHING`,
      [key, model, JSON.stringify(res.data), res.inputTokens, res.outputTokens],
    );
  } catch (err) {
    logger.warn('llm cache write failed', { err: String(err) });
  }
}
