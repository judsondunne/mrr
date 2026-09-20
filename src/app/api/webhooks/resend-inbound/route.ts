/**
 * Resend inbound-email webhook (a prospect replying to an outreach message).
 *
 * Same contract as the delivery webhook: raw body, never req.json(), and a 200
 * for both accepted and duplicate events.
 *
 * The inbound result carries no failure detail, so a returned `accepted:false`
 * is reported as malformed (400) and only a thrown signature error becomes 401.
 */
import {
  headerMap,
  logWebhookFailure,
  readRawBody,
  statusForThrown,
  webhookJson,
} from '@/app/_lib/webhook';
import { handleInboundWebhook } from '@/app/_lib/pipeline';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  const rawBody = await readRawBody(req);
  if (rawBody === null) return webhookJson({ ok: false, error: 'REJECTED' }, 400);

  try {
    const result = await handleInboundWebhook(rawBody, headerMap(req));

    if (result.accepted || result.duplicate) {
      return webhookJson({ ok: true, duplicate: result.duplicate === true }, 200);
    }
    return webhookJson({ ok: false, error: 'REJECTED' }, 400);
  } catch (err) {
    logWebhookFailure('resend-inbound', err);
    return webhookJson({ ok: false, error: 'REJECTED' }, statusForThrown(err));
  }
}
