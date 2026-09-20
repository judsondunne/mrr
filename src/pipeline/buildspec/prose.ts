/**
 * Optional prose polish for the build spec — the ONLY place in this agent's
 * three layers where a model may be called at all, and even here it may not
 * introduce a single fact.
 *
 * Guardrails, all of them cheap and deterministic:
 *   - reasoner tier only, one short call, cached by content hash
 *   - the returned paragraph may contain no digits, no URL, no quotation mark,
 *     and no claim language; otherwise it is discarded
 *   - mock provider output is discarded (shadow mode and the test suite always
 *     render the deterministic paragraph)
 *   - any error at all falls back to the deterministic paragraph
 *
 * Every number, quote and URL in the generated spec is rendered by code from a
 * database row, never by this function.
 */
import { z } from 'zod';
import { llmComplete } from '../../lib/llm/index';
import { createLogger } from '../../lib/logger';
import { containsClaimLanguage } from '../notify/claims';

const logger = createLogger('buildspec:prose');

const PolishedSummary = z.object({
  paragraph: z.string().min(40).max(900),
});

const SYSTEM = [
  'You rewrite one paragraph of an internal engineering brief.',
  'Rules you must follow exactly:',
  '- Do not add facts. Do not invent numbers, customers, quotes or URLs.',
  '- Never write any digit. Never write a URL. Never use quotation marks.',
  '- Never promise revenue or outcomes of any kind.',
  '- Keep it under six sentences, plain and concrete.',
].join('\n');

/** True when the text smuggled in something only a database row may assert. */
export function polishIsSafe(text: string): boolean {
  if (/\d/.test(text)) return false;
  if (/https?:|www\./i.test(text)) return false;
  if (/["'`]/.test(text)) return false;
  if (containsClaimLanguage(text)) return false;
  return true;
}

/**
 * Returns a polished version of `deterministic`, or `deterministic` itself.
 * Callers must treat the result as cosmetic: it is never load-bearing.
 */
export async function polishParagraph(params: {
  deterministic: string;
  context: string;
  task: string;
}): Promise<string> {
  try {
    const res = await llmComplete({
      tier: 'reasoner',
      task: params.task,
      schemaName: 'PolishedSummary',
      schema: PolishedSummary,
      maxTokens: 600,
      system: SYSTEM,
      user: [
        'Context (facts already verified in the database; do not restate numbers):',
        params.context,
        '',
        'Paragraph to rewrite more clearly:',
        params.deterministic,
      ].join('\n'),
    });

    if (res.model.startsWith('mock:')) return params.deterministic;
    const candidate = res.data.paragraph.trim();
    if (!polishIsSafe(candidate)) {
      logger.warn('discarding polished paragraph: it introduced unverifiable content', {
        task: params.task,
      });
      return params.deterministic;
    }
    return candidate;
  } catch (err) {
    logger.warn('prose polish unavailable; using deterministic text', {
      task: params.task,
      err: String(err),
    });
    return params.deterministic;
  }
}
