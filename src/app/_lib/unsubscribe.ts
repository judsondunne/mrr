/**
 * Shared unsubscribe logic, used by both the API route (GET/POST) and the
 * confirmation page so that every entry point behaves identically.
 *
 * Never throws. A valid unsubscribe must never turn into an error page, and an
 * internal failure must never be reported to the recipient as success.
 */
import { z } from 'zod';
import { createLogger } from '@/lib/logger';
import { processUnsubscribe } from '@/app/_lib/pipeline';

const logger = createLogger('web:unsubscribe');

const Token = z.string().min(8).max(2048);

export type UnsubscribeOutcome = 'UNSUBSCRIBED' | 'INVALID_TOKEN' | 'MISSING_TOKEN' | 'ERROR';

export interface UnsubscribeResult {
  outcome: UnsubscribeOutcome;
  email: string | null;
}

export async function runUnsubscribe(rawToken: string | null): Promise<UnsubscribeResult> {
  const parsed = Token.safeParse(rawToken ?? '');
  if (!parsed.success) return { outcome: 'MISSING_TOKEN', email: null };

  try {
    const result = await processUnsubscribe(parsed.data);
    return result.ok
      ? { outcome: 'UNSUBSCRIBED', email: result.email }
      : { outcome: 'INVALID_TOKEN', email: null };
  } catch (err) {
    logger.error('unsubscribe failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { outcome: 'ERROR', email: null };
  }
}

export function outcomeFromStatus(value: string | null | undefined): UnsubscribeOutcome {
  switch ((value ?? '').toLowerCase()) {
    case 'unsubscribed':
      return 'UNSUBSCRIBED';
    case 'error':
      return 'ERROR';
    default:
      return 'INVALID_TOKEN';
  }
}
