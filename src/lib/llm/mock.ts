import type { z } from 'zod';
import { createLogger } from '../logger.js';
import type { LlmProvider, LlmRequest, LlmResponse } from './types.js';

const logger = createLogger('llm:mock');

type Handler = (req: LlmRequest<unknown>) => unknown;

/**
 * Deterministic stand-in so SHADOW MODE and the test suite run with no API key
 * and no spend. Produces schema-valid output by walking the Zod schema and
 * filling plausible values, unless a task-specific handler is registered.
 */
export class MockLlmProvider implements LlmProvider {
  readonly name = 'mock';
  private handlers = new Map<string, Handler>();
  readonly calls: Array<{ task: string; tier: string }> = [];

  register(task: string, handler: Handler): this {
    this.handlers.set(task, handler);
    return this;
  }

  async complete<T>(req: LlmRequest<T>): Promise<LlmResponse<T>> {
    this.calls.push({ task: req.task, tier: req.tier });
    const handler = this.handlers.get(req.task);
    const raw = handler ? handler(req as LlmRequest<unknown>) : synthesize(req.schema, req.task);

    const parsed = req.schema.safeParse(raw);
    if (!parsed.success) {
      logger.warn('mock output failed schema; returning synthesized fallback', {
        task: req.task,
        issues: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`),
      });
      const fallback = req.schema.safeParse(synthesize(req.schema, req.task));
      if (!fallback.success) {
        throw new Error(`MockLlmProvider cannot synthesize a valid value for task "${req.task}"`);
      }
      return wrap(fallback.data as T, req.task);
    }
    return wrap(parsed.data as T, req.task);
  }
}

function wrap<T>(data: T, task: string): LlmResponse<T> {
  return {
    data,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCost: 0,
    model: `mock:${task}`,
    cached: false,
  };
}

/** Best-effort schema-shaped value generator. Handles the subset we actually use. */
function synthesize(schema: z.ZodType<unknown>, seed: string, depth = 0): unknown {
  if (depth > 8) return null;
  const def = (schema as unknown as { def?: { type?: string } }).def;
  const type = def?.type;
  const d = def as Record<string, unknown> | undefined;

  switch (type) {
    case 'string':
      return `mock-${seed}`;
    case 'number':
      return 1;
    case 'bigint':
      return BigInt(1);
    case 'boolean':
      return false;
    case 'date':
      return new Date(0);
    case 'literal': {
      const vals = d?.values as unknown[] | undefined;
      return vals?.[0] ?? null;
    }
    case 'enum': {
      const entries = d?.entries as Record<string, unknown> | undefined;
      return entries ? Object.values(entries)[0] : null;
    }
    case 'array':
      return [];
    case 'object': {
      const shape = (d?.shape ?? {}) as Record<string, z.ZodType<unknown>>;
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(shape)) {
        out[key] = synthesize(child, `${seed}-${key}`, depth + 1);
      }
      return out;
    }
    case 'optional':
    case 'nullable':
    case 'default':
      return synthesize(d?.innerType as z.ZodType<unknown>, seed, depth + 1);
    case 'union': {
      const options = d?.options as z.ZodType<unknown>[] | undefined;
      return options?.[0] ? synthesize(options[0], seed, depth + 1) : null;
    }
    default:
      return null;
  }
}
