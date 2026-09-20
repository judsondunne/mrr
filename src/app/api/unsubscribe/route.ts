/**
 * Unsubscribe endpoint. GET and POST.
 *
 * This is a genuine ONE-STEP opt-out:
 *  - GET  : the link in an email. Suppression happens on that single request.
 *           No login, no confirmation form, no "are you sure". The response is
 *           a redirect to a page that confirms what already happened.
 *  - POST : RFC 8058 one-click (`List-Unsubscribe-Post: List-Unsubscribe=One-Click`).
 *           Same effect, no user interaction at all.
 *
 * A valid unsubscribe is never answered with an error page.
 */
import { runUnsubscribe, type UnsubscribeOutcome } from '@/app/_lib/unsubscribe';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function redirectToConfirmation(req: Request, outcome: UnsubscribeOutcome): Response {
  const url = new URL('/unsubscribe', req.url);
  url.searchParams.set('status', outcome.toLowerCase());
  return new Response(null, {
    status: 303,
    headers: { location: url.toString(), 'cache-control': 'no-store' },
  });
}

async function tokenFromBody(req: Request): Promise<string | null> {
  const contentType = (req.headers.get('content-type') ?? '').toLowerCase();
  try {
    if (contentType.includes('application/json')) {
      const body: unknown = await req.json();
      if (body && typeof body === 'object') {
        const value = (body as { token?: unknown }).token;
        return typeof value === 'string' && value !== '' ? value : null;
      }
      return null;
    }
    if (
      contentType.includes('application/x-www-form-urlencoded') ||
      contentType.includes('multipart/form-data')
    ) {
      const form = await req.formData();
      const value = form.get('token');
      return typeof value === 'string' && value !== '' ? value : null;
    }
  } catch {
    return null;
  }
  return null;
}

export async function GET(req: Request): Promise<Response> {
  const { outcome } = await runUnsubscribe(new URL(req.url).searchParams.get('token'));
  // Always a confirmation page, never an error page.
  return redirectToConfirmation(req, outcome === 'MISSING_TOKEN' ? 'INVALID_TOKEN' : outcome);
}

export async function POST(req: Request): Promise<Response> {
  const token = new URL(req.url).searchParams.get('token') ?? (await tokenFromBody(req));
  if (!token) return json({ ok: false, status: 'MISSING_TOKEN' }, 400);

  const { outcome } = await runUnsubscribe(token);

  // 200 for both UNSUBSCRIBED and INVALID_TOKEN: a one-click mail client cannot
  // fix a bad token, and a non-2xx there only produces a scary error in the
  // recipient's mail app. A genuine internal failure is a real 500.
  if (outcome === 'UNSUBSCRIBED' || outcome === 'INVALID_TOKEN') {
    return json({ ok: outcome === 'UNSUBSCRIBED', status: outcome }, 200);
  }
  return json({ ok: false, status: 'ERROR' }, 500);
}
