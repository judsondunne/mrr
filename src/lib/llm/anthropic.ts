import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { getConfig } from '../config.js';
import { ProviderError } from '../errors.js';
import { createLogger } from '../logger.js';
import { estimateLlmCost } from '../cost.js';
import type { LlmProvider, LlmRequest, LlmResponse } from './types.js';

const logger = createLogger('llm:anthropic');

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  private client: Anthropic | null = null;

  private getClient(): Anthropic {
    if (!this.client) {
      const cfg = getConfig();
      if (!cfg.anthropicApiKey) {
        throw new ProviderError('anthropic', 'ANTHROPIC_API_KEY is not set', false);
      }
      this.client = new Anthropic({ apiKey: cfg.anthropicApiKey, maxRetries: 3, timeout: 120_000 });
    }
    return this.client;
  }

  async complete<T>(req: LlmRequest<T>): Promise<LlmResponse<T>> {
    const cfg = getConfig();
    const model = req.tier === 'fast' ? cfg.llmFast : cfg.llmReasoner;

    try {
      const res = await this.getClient().messages.parse({
        model,
        max_tokens: req.maxTokens ?? 4096,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
        output_config: { format: zodOutputFormat(req.schema) },
      });

      if (res.stop_reason === 'refusal') {
        throw new ProviderError('anthropic', `model refused: ${req.task}`, false);
      }
      if (res.parsed_output === null || res.parsed_output === undefined) {
        throw new ProviderError('anthropic', `structured output failed to parse for ${req.task}`, true);
      }

      const inputTokens = res.usage.input_tokens ?? 0;
      const outputTokens = res.usage.output_tokens ?? 0;
      return {
        data: res.parsed_output as T,
        inputTokens,
        outputTokens,
        estimatedCost: estimateLlmCost(req.tier, inputTokens, outputTokens),
        model,
        cached: false,
      };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (err instanceof Anthropic.APIError) {
        const retryable = err.status === undefined || err.status === 429 || err.status >= 500;
        logger.error('anthropic api error', { status: err.status, task: req.task });
        throw new ProviderError('anthropic', `${err.status ?? 'network'}: ${err.message}`, retryable);
      }
      throw new ProviderError('anthropic', String(err), true);
    }
  }
}
