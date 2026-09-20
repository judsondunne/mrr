/**
 * Admin sign-in. Exchanges a correct ADMIN_TOKEN for the `mrr_admin` httpOnly
 * cookie. The token is never echoed back and never logged.
 */
import { z } from 'zod';
import {
  buildAdminCookie,
  isAdminTokenValid,
  safeNextPath,
} from '@/app/admin/auth';
import { createLogger } from '@/lib/logger';
import { clientKey, rateLimit } from '@/app/_lib/ratelimit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const logger = createLogger('web:admin-login');

/** Per instance — see src/app/_lib/ratelimit.ts. */
const RATE_LIMIT = { capacity: 8, refillPerSecond: 8 / 60 };

const LoginBody = z.object({
  token: z.string().min(1).max(512),
  next: z.string().max(300).optional(),
});

function redirectTo(req: Request, path: string, cookie?: string): Response {
  const headers = new Headers({
    location: new URL(path, req.url).toString(),
    'cache-control': 'no-store',
  });
  if (cookie) headers.set('set-cookie', cookie);
  return new Response(null, { status: 303, headers });
}

function json(body: Record<string, unknown>, status: number, cookie?: string): Response {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  if (cookie) headers.set('set-cookie', cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

export async function POST(req: Request): Promise<Response> {
  const contentType = (req.headers.get('content-type') ?? '').toLowerCase();
  const isBrowserForm =
    contentType.includes('application/x-www-form-urlencoded') ||
    contentType.includes('multipart/form-data');

  const limit = rateLimit(`admin-login:${clientKey(req)}`, RATE_LIMIT);
  if (!limit.allowed) {
    return isBrowserForm
      ? redirectTo(req, '/admin/login?error=rate')
      : json({ ok: false, error: 'RATE_LIMITED' }, 429);
  }

  let raw: Record<string, unknown> = {};
  try {
    if (isBrowserForm) {
      const form = await req.formData();
      raw = {
        token: String(form.get('token') ?? ''),
        next: String(form.get('next') ?? '/admin'),
      };
    } else {
      const body: unknown = await req.json();
      raw = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    }
  } catch {
    raw = {};
  }

  const parsed = LoginBody.safeParse(raw);
  const target = safeNextPath(parsed.success ? parsed.data.next : '/admin');

  if (!parsed.success || !isAdminTokenValid(parsed.data.token)) {
    logger.warn('admin login rejected', { ip: clientKey(req) });
    return isBrowserForm
      ? redirectTo(req, `/admin/login?error=1&next=${encodeURIComponent(target)}`)
      : json({ ok: false, error: 'UNAUTHORIZED' }, 401);
  }

  const cookie = buildAdminCookie(parsed.data.token);
  logger.info('admin login accepted', { ip: clientKey(req) });

  return isBrowserForm
    ? redirectTo(req, target, cookie)
    : json({ ok: true, next: target }, 200, cookie);
}
