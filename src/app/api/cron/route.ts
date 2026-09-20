/**
 * Scheduler entry point.
 *
 * POST is the real interface; GET is accepted because Vercel Cron issues GETs.
 * Both require `Authorization: Bearer <CRON_SECRET>`, compared in constant time.
 *
 * This route contains NO job logic. It dispatches through the single
 * indirection `runJob(name)` from `@/jobs/registry`, which owns locking,
 * idempotency, budget halts and the kill switch.
 */
import { getConfig } from '@/lib/config';
import { safeCompare } from '@/lib/hash';
import { createLogger } from '@/lib/logger';
import { JOB_NAMES, runJob } from '@/jobs/registry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const logger = createLogger('web:cron');

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

function isAuthorized(req: Request): boolean {
  const expected = getConfig().cronSecret;
  if (!expected) return false; // fail closed: no secret configured => no cron
  const presented = bearerToken(req);
  if (!presented) return false;
  return safeCompare(presented, expected);
}

async function handle(req: Request): Promise<Response> {
  if (!isAuthorized(req)) return json({ ok: false, error: 'UNAUTHORIZED' }, 401);

  const job = new URL(req.url).searchParams.get('job')?.trim() ?? '';
  const names = [...JOB_NAMES] as string[];

  if (!job) return json({ ok: false, error: 'MISSING_JOB', jobs: names }, 400);
  if (!names.includes(job)) return json({ ok: false, error: 'UNKNOWN_JOB', jobs: names }, 400);

  try {
    const result = await runJob(job);
    logger.info('cron job finished', {
      job: result.job,
      status: result.status,
      records: result.recordsProcessed,
    });
    return json(
      {
        ok: result.status === 'SUCCESS' || result.status === 'SKIPPED',
        job: result.job,
        status: result.status,
        recordsProcessed: result.recordsProcessed,
        durationMs: result.durationMs,
        cost: result.cost,
        error: result.error ? String(result.error).slice(0, 300) : null,
      },
      200,
    );
  } catch (err) {
    logger.error('cron dispatch failed', {
      job,
      error: err instanceof Error ? err.message : String(err),
    });
    return json({ ok: false, error: 'JOB_DISPATCH_FAILED', job }, 500);
  }
}

export async function POST(req: Request): Promise<Response> {
  return handle(req);
}

/** Vercel Cron sends GET. Same auth, same dispatch. */
export async function GET(req: Request): Promise<Response> {
  return handle(req);
}
