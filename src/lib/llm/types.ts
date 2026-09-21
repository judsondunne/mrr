import type { z } from 'zod';

/**
 * Two tiers, never a hard-coded model name at a call site.
 *   fast     - classification, extraction, qualification, reply triage, short personalization
 *   reasoner - complaint clustering, wedge synthesis, final build spec. That is the whole list.
 */
export type LlmTier = 'fast' | 'reasoner';

/** Which sub-budget a call is charged to. */
export type SpendPhase = 'DISCOVERY' | 'RESEARCH' | 'PROSPECTING' | 'REPLY' | 'FINAL_ANALYSIS';

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
  /**
   * Prompt identity. Bumping `promptVersion` changes the cache key AND is
   * recorded on the output, so learning never compares results produced by two
   * different prompts as though they were the same experiment.
   */
  promptId?: string;
  promptVersion?: number;
  /** Sub-budget to charge. Defaults to RESEARCH. */
  phase?: SpendPhase;
  /** Attributes spend to one opportunity for information-value ranking. */
  opportunityId?: string | null;
  /**
   * External text (web pages, emails, reviews) that must be treated as DATA.
   * Passing it here rather than concatenating into `user` lets the LLM layer
   * fence it consistently. See src/autonomy/injection.ts.
   */
  untrusted?: Record<string, string>;
}

export interface LlmResponse<T> {
  data: T;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  model: string;
  cached: boolean;
  /** True when the primary provider failed and a configured fallback answered. */
  usedFallback?: boolean;
  promptId?: string;
  promptVersion?: number;
}

export interface LlmProvider {
  readonly name: string;
  complete<T>(req: LlmRequest<T>): Promise<LlmResponse<T>>;
}
