/**
 * Direct Resend REST client for the POLLING architecture.
 *
 * The SDK covers sending. These are the read endpoints the validation loop
 * needs and does not expose: listing sent mail with its real delivery state,
 * and listing inbound mail. Polling them removes the need for any public
 * endpoint on this machine — no tunnel, no webhook secret, no ingress.
 *
 * The important property is unchanged from the webhook design: delivery state
 * originates from the PROVIDER. This machine never decides that an email was
 * delivered; it asks Resend and records the answer.
 *
 * Requires a full-access API key. A send-only key answers 401 here, which is
 * surfaced as a clear error rather than an empty list — an empty list would be
 * indistinguishable from "nothing happened" and would quietly stall the loop.
 */
import { getConfig } from '../config';
import { ProviderError } from '../errors';
import { createLogger } from '../logger';

const logger = createLogger('resend:api');

const API_BASE = 'https://api.resend.com';

/** Resend's own lifecycle vocabulary for a sent message. */
export type ResendLastEvent =
  | 'sent'
  | 'delivered'
  | 'delivery_delayed'
  | 'bounced'
  | 'complained'
  | 'failed'
  | 'canceled'
  | 'scheduled'
  | 'queued';

export interface SentEmail {
  id: string;
  to: string[];
  from: string;
  subject: string;
  createdAt: string;
  lastEvent: ResendLastEvent | null;
  /** RFC 5322 Message-ID. This is what a reply quotes in In-Reply-To. */
  messageId: string | null;
  replyTo: string[] | null;
}

export interface InboundEmail {
  id: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string | null;
  createdAt: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  raw: unknown;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const cfg = getConfig();
  if (!cfg.resendApiKey) throw new ProviderError('resend', 'RESEND_API_KEY is not set', false);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${cfg.resendApiKey}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new ProviderError('resend', `network: ${String(err).slice(0, 160)}`, true);
  }

  const body = await res.text();
  if (!res.ok) {
    // A restricted key is a configuration fault, not a transient one: retrying
    // will never fix it, and treating it as empty data would silently stall
    // the whole validation loop.
    const retryable = res.status === 429 || res.status >= 500;
    const detail = body.slice(0, 200);
    if (res.status === 401 && detail.includes('restricted')) {
      throw new ProviderError(
        'resend',
        'RESEND_API_KEY is send-only; polling delivery and inbound mail needs a full-access key',
        false,
      );
    }
    throw new ProviderError('resend', `${res.status}: ${detail}`, retryable);
  }

  try {
    return JSON.parse(body) as T;
  } catch {
    throw new ProviderError('resend', 'unparseable response', true);
  }
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}
function asArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  return typeof v === 'string' ? [v] : [];
}

/** One sent email, with the delivery state Resend currently holds for it. */
export async function getSentEmail(id: string): Promise<SentEmail | null> {
  try {
    const raw = await call<Record<string, unknown>>(`/emails/${encodeURIComponent(id)}`);
    return {
      id: String(raw.id ?? id),
      to: asArray(raw.to),
      from: String(raw.from ?? ''),
      subject: String(raw.subject ?? ''),
      createdAt: String(raw.created_at ?? ''),
      lastEvent: (asString(raw.last_event) as ResendLastEvent | null) ?? null,
      messageId: asString(raw.message_id),
      replyTo: Array.isArray(raw.reply_to) ? asArray(raw.reply_to) : null,
    };
  } catch (err) {
    if (err instanceof ProviderError && !err.retryable) throw err;
    logger.warn('could not retrieve sent email', { id, err: String(err).slice(0, 140) });
    return null;
  }
}

/**
 * Inbound mail waiting in the Resend inbox.
 *
 * Resend returns newest-first; callers de-duplicate on `id`, which is what
 * makes repeated polling safe.
 */
export async function listInboundEmails(limit = 50): Promise<InboundEmail[]> {
  const raw = await call<{ data?: Array<Record<string, unknown>> }>(
    `/emails/inbound?limit=${Math.max(1, Math.min(100, limit))}`,
  );
  const rows = raw.data ?? [];
  return rows.map((r) => {
    const headers = (r.headers ?? {}) as Record<string, unknown>;
    const header = (name: string): string | null => {
      for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === name.toLowerCase()) return asString(v);
      }
      return null;
    };
    return {
      id: String(r.id ?? ''),
      from: String(r.from ?? ''),
      to: asArray(r.to),
      subject: String(r.subject ?? ''),
      text: String(r.text ?? ''),
      html: asString(r.html),
      createdAt: String(r.created_at ?? ''),
      messageId: asString(r.message_id) ?? header('Message-ID'),
      inReplyTo: asString(r.in_reply_to) ?? header('In-Reply-To'),
      references: asString(r.references) ?? header('References'),
      raw: r,
    };
  });
}

/** True when the configured key can read, not merely send. */
export async function hasFullAccess(): Promise<{ ok: boolean; reason: string }> {
  try {
    await call<unknown>('/domains');
    return { ok: true, reason: '' };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
