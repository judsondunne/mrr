/**
 * Google Gemini provider.
 *
 * Same contract as the Anthropic provider: a tier in, validated structured
 * output out, tokens and cost reported. The difference is how structure is
 * enforced — Gemini takes an OpenAPI-subset `responseSchema` rather than a Zod
 * helper, so the request schema is derived from the call site's Zod type and
 * the RESPONSE is still parsed through that same Zod type. The model's schema
 * is a hint to it; Zod remains the thing that decides whether the answer is
 * acceptable, exactly as before.
 *
 * `gemini-2.5-flash` is a thinking model. Thinking is disabled on the fast
 * tier — classification and extraction do not need it, and it is billed as
 * output tokens, so leaving it on would roughly triple the cost of the most
 * frequent call in the system.
 */
import { z } from 'zod';
import { getConfig } from '../config';
import { ProviderError } from '../errors';
import { createLogger } from '../logger';
import { estimateLlmCost } from '../cost';
import type { LlmProvider, LlmRequest, LlmResponse } from './types';

const logger = createLogger('llm:gemini');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** How many times a schema-invalid answer is re-asked before giving up. */
const MAX_REPAIR_ATTEMPTS = 1;

interface GeminiPart {
  text?: string;
}
interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string; code?: number };
}

// --- schema conversion -------------------------------------------------------

type JsonSchema = Record<string, unknown>;

/**
 * Keys Gemini's schema dialect rejects outright. `additionalProperties` is the
 * one Zod always emits and Gemini always refuses.
 */
const UNSUPPORTED_KEYS = new Set([
  '$schema',
  '$id',
  '$ref',
  'additionalProperties',
  'patternProperties',
  'definitions',
  '$defs',
  'default',
  'const',
  'examples',
  'allOf',
  'oneOf',
  'not',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'pattern',
]);

/**
 * Rewrites a JSON Schema into the OpenAPI subset Gemini accepts.
 *
 * The important case is nullability: Zod emits `anyOf: [T, {type:'null'}]` for
 * `.nullable()`, which Gemini does not understand, but it does understand
 * `nullable: true`. Collapsing that is what makes every `.nullable()` field in
 * the contracts survive the round trip.
 */
export function toGeminiSchema(input: unknown): JsonSchema {
  if (input === null || typeof input !== 'object') return { type: 'string' };
  const schema = input as JsonSchema;

  // `.nullable()` / unions with null.
  const anyOf = schema.anyOf;
  if (Array.isArray(anyOf)) {
    const branches = anyOf as JsonSchema[];
    const nullBranch = branches.some((b) => b?.type === 'null');
    const real = branches.filter((b) => b?.type !== 'null');
    // A union of real alternatives is not expressible here; take the first and
    // let Zod reject anything that does not fit. Better a narrow hint than a
    // schema the API refuses.
    const chosen = real[0] ?? { type: 'string' };
    const converted = toGeminiSchema(chosen);
    if (nullBranch) converted.nullable = true;
    if (typeof schema.description === 'string') converted.description = schema.description;
    return converted;
  }

  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_KEYS.has(key)) continue;

    if (key === 'properties' && value !== null && typeof value === 'object') {
      const props: JsonSchema = {};
      for (const [name, sub] of Object.entries(value as JsonSchema)) {
        props[name] = toGeminiSchema(sub);
      }
      out.properties = props;
      continue;
    }
    if (key === 'items') {
      out.items = toGeminiSchema(value);
      continue;
    }
    if (key === 'type' && Array.isArray(value)) {
      // ['string','null'] -> string + nullable
      const types = (value as string[]).filter((t) => t !== 'null');
      out.type = types[0] ?? 'string';
      if (types.length !== value.length) out.nullable = true;
      continue;
    }
    out[key] = value;
  }

  // An object with no declared properties is rejected; describe it as a string
  // rather than sending something unusable.
  const props = out.properties;
  if (out.type === 'object' && (props === undefined || props === null || Object.keys(props as object).length === 0)) {
    return { type: 'string' };
  }
  return out;
}

/** The Gemini `responseSchema` for a call site's Zod type. */
function responseSchemaFor<T>(schema: z.ZodType<T>): JsonSchema | null {
  try {
    return toGeminiSchema(z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }));
  } catch (err) {
    // Without a schema the model still gets `responseMimeType: application/json`
    // and the prompt contract, and Zod still validates. Degrade, do not fail.
    logger.warn('could not derive a response schema; falling back to JSON mode only', {
      err: String(err).slice(0, 200),
    });
    return null;
  }
}

// --- provider ----------------------------------------------------------------

export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini';

  private apiKey(): string {
    const key = getConfig().geminiApiKey;
    if (!key) throw new ProviderError('gemini', 'GEMINI_API_KEY is not set', false);
    return key;
  }

  async complete<T>(req: LlmRequest<T>): Promise<LlmResponse<T>> {
    const cfg = getConfig();
    const model = req.tier === 'fast' ? cfg.llmFast : cfg.llmReasoner;
    const responseSchema = responseSchemaFor(req.schema);

    let repairHint = '';
    let lastIssue = '';

    for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
      const { text, inputTokens, outputTokens } = await this.call({
        model,
        system: req.system,
        user: attempt === 0 ? req.user : `${req.user}\n\n${repairHint}`,
        maxTokens: req.maxTokens ?? 4096,
        responseSchema,
        // Thinking costs output tokens. The fast tier is classification work.
        thinking: req.tier !== 'fast',
        task: req.task,
      });

      const parsedJson = safeJson(text);
      if (parsedJson === undefined) {
        lastIssue = 'the response was not valid JSON';
        repairHint = `Your previous answer was not valid JSON. Return ONLY a JSON object matching the schema.`;
        continue;
      }

      const validated = req.schema.safeParse(parsedJson);
      if (validated.success) {
        return {
          data: validated.data,
          inputTokens,
          outputTokens,
          estimatedCost: estimateLlmCost(req.tier, inputTokens, outputTokens),
          model,
          cached: false,
        };
      }

      lastIssue = validated.error.issues
        .slice(0, 4)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      repairHint =
        `Your previous answer did not satisfy the required shape: ${lastIssue}. ` +
        `Return ONLY a corrected JSON object.`;
      logger.warn('gemini output failed schema validation; re-asking', {
        task: req.task,
        issues: lastIssue,
      });
    }

    // Retryable: a different sample may parse, and the caller's retry policy
    // is a better judge of whether to spend again than this layer is.
    throw new ProviderError('gemini', `structured output failed for ${req.task}: ${lastIssue}`, true);
  }

  private async call(params: {
    model: string;
    system: string;
    user: string;
    maxTokens: number;
    responseSchema: JsonSchema | null;
    thinking: boolean;
    task: string;
  }): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
    const generationConfig: JsonSchema = {
      responseMimeType: 'application/json',
      maxOutputTokens: params.maxTokens,
      temperature: 0,
    };
    if (params.responseSchema) generationConfig.responseSchema = params.responseSchema;
    if (!params.thinking) generationConfig.thinkingConfig = { thinkingBudget: 0 };

    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: params.system }] },
      contents: [{ role: 'user', parts: [{ text: params.user }] }],
      generationConfig,
    });

    let res: Response;
    try {
      res = await fetch(`${API_BASE}/${encodeURIComponent(params.model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey() },
        body,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      throw new ProviderError('gemini', `network: ${String(err).slice(0, 200)}`, true);
    }

    const raw = await res.text();
    if (!res.ok) {
      const message = (safeJson(raw) as GeminiResponse | undefined)?.error?.message ?? raw.slice(0, 200);
      // 429 and 5xx are worth retrying; a 400 means the request itself is wrong.
      const retryable = res.status === 429 || res.status >= 500;
      logger.error('gemini api error', { status: res.status, task: params.task });
      throw new ProviderError('gemini', `${res.status}: ${message}`, retryable);
    }

    const parsed = safeJson(raw) as GeminiResponse | undefined;
    if (!parsed) throw new ProviderError('gemini', 'provider returned unparseable JSON', true);

    const blocked = parsed.promptFeedback?.blockReason;
    if (blocked) {
      throw new ProviderError('gemini', `prompt blocked by safety filter: ${blocked}`, false);
    }

    const candidate = parsed.candidates?.[0];
    const finish = candidate?.finishReason;
    if (finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT' || finish === 'BLOCKLIST') {
      throw new ProviderError('gemini', `response blocked: ${finish}`, false);
    }
    if (finish === 'MAX_TOKENS') {
      throw new ProviderError('gemini', `response truncated at maxOutputTokens for ${params.task}`, true);
    }

    const text = (candidate?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')
      .trim();
    if (text === '') throw new ProviderError('gemini', `empty response for ${params.task}`, true);

    const usage = parsed.usageMetadata ?? {};
    // Thinking tokens are billed as output. Counting them keeps the budget
    // honest rather than pleasantly wrong.
    const outputTokens = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
    return { text, inputTokens: usage.promptTokenCount ?? 0, outputTokens };
  }
}

/** Tolerates a fenced ```json block, which Gemini occasionally still emits. */
function safeJson(raw: string): unknown {
  const text = raw.trim();
  const unfenced = text.startsWith('```')
    ? text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
    : text;
  try {
    return JSON.parse(unfenced);
  } catch {
    return undefined;
  }
}
