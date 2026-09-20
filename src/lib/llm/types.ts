import type { z } from 'zod';

/**
 * Two tiers, never a hard-coded model name at a call site.
 *   fast     - classification, extraction, qualification, reply triage, short personalization
 *   reasoner - complaint clustering, wedge synthesis, final build spec. That is the whole list.
 */
export type LlmTier = 'fast' | 'reasoner';

export interface LlmRequest<T> {
  tier: LlmTier;
  /** Short, stable name used for the cache key and the cost ledger metadata. */
  task: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  schemaName: string;
  maxTokens?: number;
  /** Set false for genuinely time-varying prompts. Default true. */
  cacheable?: boolean;
}

export interface LlmResponse<T> {
  data: T;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  model: string;
  cached: boolean;
}

export interface LlmProvider {
  readonly name: string;
  complete<T>(req: LlmRequest<T>): Promise<LlmResponse<T>>;
}
