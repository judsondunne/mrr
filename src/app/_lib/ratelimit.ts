/**
 * Token-bucket rate limiter.
 *
 * IMPORTANT — this bucket lives in process memory, so the limit is PER SERVER
 * INSTANCE, not global. On a multi-instance / serverless deployment the
 * effective limit is (instances x capacity). It exists to blunt trivial abuse
 * of the public form; it is not a security control, and the real protection
 * against double-counting is the `commitments.dedupe_key` unique index, which
 * is enforced by the database regardless of how many instances are running.
 */

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface RateLimitOptions {
  /** Maximum burst. */
  capacity: number;
  /** Tokens refilled per second. */
  refillPerSecond: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Seconds until one token is available again. 0 when allowed. */
  retryAfterSeconds: number;
}

const buckets = new Map<string, Bucket>();
const MAX_TRACKED_KEYS = 5000;

export function rateLimit(key: string, opts: RateLimitOptions, now = Date.now()): RateLimitVerdict {
  if (buckets.size > MAX_TRACKED_KEYS) buckets.clear(); // crude, bounded, good enough

  const bucket = buckets.get(key) ?? { tokens: opts.capacity, updatedAt: now };
  const elapsedSeconds = Math.max(0, (now - bucket.updatedAt) / 1000);
  const tokens = Math.min(opts.capacity, bucket.tokens + elapsedSeconds * opts.refillPerSecond);

  if (tokens < 1) {
    buckets.set(key, { tokens, updatedAt: now });
    const deficit = 1 - tokens;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(deficit / opts.refillPerSecond)),
    };
  }

  buckets.set(key, { tokens: tokens - 1, updatedAt: now });
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Test helper. */
export function resetRateLimits(): void {
  buckets.clear();
}

/**
 * Best-effort client identity for rate limiting. Proxy headers are spoofable,
 * which is another reason this is not a security control.
 */
export function clientKey(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first || req.headers.get('x-real-ip')?.trim() || 'unknown';
}
