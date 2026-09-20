/**
 * Shared webhook plumbing.
 *
 * Two rules the provider depends on:
 *  - the body is read as RAW TEXT and handed to the pipeline untouched, because
 *    signature verification is over the exact bytes;
 *  - an accepted event AND a duplicate event both answer 200, so the provider
 *    stops retrying something we already processed.
 *
 * Response bodies are deliberately contentless: an attacker probing the
 * endpoint learns only "rejected", never why.
 */
import { createLogger } from '@/lib/logger';

const logger = createLogger('web:webhook');

/** 2 MB. Larger than any Resend event; small enough to refuse abuse cheaply. */
export const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;

const SIGNATURE_HINT =
  /(signature|signing|unsigned|unauthori[sz]|unauthenticat|forbidden|secret|svix|timestamp\s*(skew|tolerance))/i;

export function webhookJson(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** Lowercased header map, which is what the pipeline contract expects. */
export function headerMap(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * A handler that returned `accepted: false` is treated as a malformed or
 * unhandled payload (400) unless it said the problem was the signature (401).
 */
export function statusForRejection(detail: string | undefined | null): 400 | 401 {
  return detail && SIGNATURE_HINT.test(detail) ? 401 : 400;
}

/**
 * A handler that threw. Signature failures are 401; everything else is a
 * genuine server-side error (500) so the provider retries it.
 */
export function statusForThrown(err: unknown): 401 | 500 {
  const message = err instanceof Error ? err.message : String(err);
  return SIGNATURE_HINT.test(message) ? 401 : 500;
}

/** Reads the raw body, refusing anything implausibly large. */
export async function readRawBody(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) return null;
  try {
    const raw = await req.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_WEBHOOK_BYTES) return null;
    return raw;
  } catch {
    return null;
  }
}

export function logWebhookFailure(scope: string, err: unknown): void {
  logger.error('webhook handler threw', {
    scope,
    error: err instanceof Error ? err.message : String(err),
  });
}
