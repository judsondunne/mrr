/**
 * Resend delivery-event webhook (delivered / bounced / complained / opened …).
 *
 * The body is read with req.text() and NEVER with req.json(): the signature is
 * computed over the exact bytes Resend sent, so any re-serialization would
 * break verification.
 */
import {
  headerMap,
  logWebhookFailure,
  readRawBody,
  statusForRejection,
  statusForThrown,
  webhookJson,
} from '@/app/_lib/webhook';
import { handleDeliveryWebhook } from '@/app/_lib/pipeline';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  const rawBody = await readRawBody(req);
  if (rawBody === null) return webhookJson({ ok: false, error: 'REJECTED' }, 400);

  try {
    const result = await handleDeliveryWebhook(rawBody, headerMap(req));

    // Accepted and duplicate both answer 200 so the provider stops retrying.
    if (result.accepted || result.duplicate) {
      return webhookJson({ ok: true, duplicate: result.duplicate === true }, 200);
    }
    return webhookJson({ ok: false, error: 'REJECTED' }, statusForRejection(result.detail));
  } catch (err) {
    logWebhookFailure('resend-delivery', err);
    return webhookJson({ ok: false, error: 'REJECTED' }, statusForThrown(err));
  }
}
