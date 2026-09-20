/**
 * Provider webhooks.
 *
 * Two rules, both absolute:
 *
 *   1. VERIFY FIRST. The signature is checked against the RAW body with a
 *      constant-time compare and a timestamp tolerance before the payload is
 *      parsed, stored, or acted on. An unverified payload is discarded — it is
 *      an anonymous internet request claiming a customer complained.
 *   2. PROCESS ONCE. Every event is inserted into webhook_events keyed by the
 *      provider event id; a duplicate delivery is a no-op.
 *
 * Opens are recorded and never, under any circumstance, treated as intent.
 */
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { getConfig } from '../../lib/config.js';
import { getDb, one } from '../../lib/db.js';
import { newId, safeCompare, sha256 } from '../../lib/hash.js';
import { createLogger } from '../../lib/logger.js';
import { recordAudit } from '../../lib/audit.js';
import type { CommitmentInput } from '../../lib/contracts.js';
import { classifyReply, commitmentTypesFor, recordCommitments } from './classify.js';
import { parseAddress, parseInboundBody, referencedMessageIds } from './inbound-parse.js';
import { loadOffer } from './offer.js';
import { draftAutoReply } from './reply-agent.js';
import { autoReplyIdempotencyKey, insertDraftMessage, prospectContextFromRow, type ProspectRow } from './drafts.js';
import { sendDraftedMessageNow } from './send.js';
import { companyKeyFor, isSuppressed, normalizeEmail, suppress } from './suppression.js';
import type { InboundResult, WebhookResult } from './index.js';

const logger = createLogger('outreach:webhooks');

/** Reject anything older than this; replayed captures are not events. */
const TIMESTAMP_TOLERANCE_SECONDS = 300;
const MAX_BODY_BYTES = 512 * 1024;

// --- signature verification (Svix / standard-webhooks, as used by Resend) ----

function lowerKeys(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) out[k.toLowerCase().trim()] = v;
  return out;
}

function headerValue(headers: Record<string, string>, names: string[]): string | null {
  for (const name of names) {
    const value = headers[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/** `whsec_<base64>` keys are binary; anything else is used as raw bytes. */
function signingKey(secret: string): Buffer {
  return secret.startsWith('whsec_')
    ? Buffer.from(secret.slice('whsec_'.length), 'base64')
    : Buffer.from(secret, 'utf8');
}

/** The signature for one (id, timestamp, body) triple. Exported for tests. */
export function signWebhookPayload(secret: string, id: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', signingKey(secret)).update(`${id}.${timestamp}.${rawBody}`).digest('base64');
}

export interface VerificationResult {
  ok: boolean;
  reason: string | null;
  eventId: string | null;
}

export function verifyWebhookSignature(
  rawBody: string,
  rawHeaders: Record<string, string>,
  secret: string,
  now: Date = new Date(),
): VerificationResult {
  if (secret.trim() === '') return { ok: false, reason: 'WEBHOOK_SECRET_NOT_CONFIGURED', eventId: null };
  if (typeof rawBody !== 'string' || rawBody === '') return { ok: false, reason: 'EMPTY_BODY', eventId: null };
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
    return { ok: false, reason: 'BODY_TOO_LARGE', eventId: null };
  }

  const headers = lowerKeys(rawHeaders);
  const id = headerValue(headers, ['svix-id', 'resend-id', 'webhook-id']);
  const timestamp = headerValue(headers, ['svix-timestamp', 'resend-timestamp', 'webhook-timestamp']);
  const signature = headerValue(headers, ['svix-signature', 'resend-signature', 'webhook-signature']);
  if (!id || !timestamp || !signature) return { ok: false, reason: 'MISSING_SIGNATURE_HEADERS', eventId: null };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'INVALID_TIMESTAMP', eventId: null };
  const skew = Math.abs(Math.floor(now.getTime() / 1000) - ts);
  if (skew > TIMESTAMP_TOLERANCE_SECONDS) return { ok: false, reason: 'STALE_TIMESTAMP', eventId: null };

  const expected = signWebhookPayload(secret, id, timestamp, rawBody);
  // The header carries a space-separated list of `v1,<sig>` entries so keys can
  // be rotated. Every candidate is compared in constant time.
  let matched = false;
  for (const part of signature.split(' ')) {
    const comma = part.indexOf(',');
    const candidate = comma >= 0 ? part.slice(comma + 1) : part;
    if (safeCompare(candidate, expected)) matched = true;
  }
  if (!matched) return { ok: false, reason: 'SIGNATURE_MISMATCH', eventId: id };

  return { ok: true, reason: null, eventId: id };
}

// --- payload schemas ---------------------------------------------------------

const DeliveryEvent = z.object({
  type: z.string().min(1).max(120),
  created_at: z.string().max(64).optional(),
  data: z.object({
    email_id: z.string().max(200).optional(),
    to: z.union([z.string(), z.array(z.string())]).optional(),
    from: z.string().max(320).optional(),
    subject: z.string().max(998).optional(),
    bounce: z
      .object({
        type: z.string().max(80).optional(),
        subType: z.string().max(80).optional(),
        message: z.string().max(2000).optional(),
      })
      .optional(),
    click: z.object({ link: z.string().max(2000).optional() }).optional(),
  }),
});

const InboundEvent = z.object({
  type: z.string().min(1).max(120),
  created_at: z.string().max(64).optional(),
  data: z.object({
    email_id: z.string().max(200).optional(),
    message_id: z.string().max(400).optional(),
    from: z.union([z.string(), z.array(z.string())]).optional(),
    to: z.union([z.string(), z.array(z.string())]).optional(),
    subject: z.string().max(998).optional(),
    text: z.string().optional(),
    html: z.string().optional(),
    in_reply_to: z.string().max(400).optional(),
    references: z.string().max(4000).optional(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
});

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// --- idempotency -------------------------------------------------------------

/** Returns false when this event id has already been recorded. */
async function claimEvent(id: string, provider: string, eventType: string, payload: unknown): Promise<boolean> {
  const db = await getDb();
  const res = await db.query<{ id: string }>(
    `INSERT INTO webhook_events (id, provider, event_type, payload_json)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [id, provider, eventType, JSON.stringify(payload ?? {})],
  );
  return res.rowCount === 1;
}

async function markEventProcessed(id: string): Promise<void> {
  const db = await getDb();
  await db.query('UPDATE webhook_events SET processed_at = now() WHERE id = $1', [id]);
}

// --- delivery events ---------------------------------------------------------

interface MessageRow {
  id: string;
  campaign_id: string | null;
  prospect_id: string | null;
  contact_email: string | null;
  domain: string | null;
}

async function findMessageByProviderId(providerMessageId: string): Promise<MessageRow | null> {
  return one<MessageRow>(
    `SELECT m.id, m.campaign_id, m.prospect_id, p.contact_email, p.domain
       FROM messages m
       LEFT JOIN prospects p ON p.id = m.prospect_id
      WHERE m.provider_message_id = $1 AND m.direction = 'OUTBOUND'
      ORDER BY m.created_at DESC
      LIMIT 1`,
    [providerMessageId],
  );
}

/**
 * Permanent vs temporary. Anything the provider marks permanent, or whose
 * diagnostic says the mailbox does not exist, is a HARD bounce and the address
 * is suppressed forever. Everything else is SOFT and changes nothing.
 */
export function classifyBounce(bounce: { type?: string; subType?: string; message?: string } | undefined): 'HARD' | 'SOFT' {
  const haystack = `${bounce?.type ?? ''} ${bounce?.subType ?? ''} ${bounce?.message ?? ''}`.toLowerCase();
  if (/\b(permanent|hard|suppressed|undetermined_permanent)\b/.test(haystack)) return 'HARD';
  if (/(no such (user|mailbox|address)|user unknown|does not exist|invalid recipient|address rejected|mailbox unavailable|account (is )?disabled|550)/.test(haystack)) {
    return 'HARD';
  }
  if (/\b(transient|temporary|soft|mailboxfull|quota|deferred|timeout|throttl)/.test(haystack)) return 'SOFT';
  // Unknown bounce shape: treat as soft so one ambiguous event cannot burn a
  // legitimate address, but it is recorded for the health check either way.
  return 'SOFT';
}

export async function handleDeliveryWebhook(
  rawBody: string,
  headers: Record<string, string>,
): Promise<WebhookResult> {
  const cfg = getConfig();
  const verification = verifyWebhookSignature(rawBody, headers, cfg.resendWebhookSecret);
  if (!verification.ok) {
    logger.warn('rejected an unverified delivery webhook', { reason: verification.reason });
    return { accepted: false, duplicate: false, eventType: 'unknown', detail: verification.reason ?? 'unverified' };
  }

  const parsed = DeliveryEvent.safeParse(safeJsonParse(rawBody));
  if (!parsed.success) {
    return { accepted: false, duplicate: false, eventType: 'unknown', detail: 'INVALID_PAYLOAD' };
  }
  const event = parsed.data;
  const eventId = verification.eventId ?? sha256(rawBody);

  if (!(await claimEvent(eventId, 'resend', event.type, event))) {
    logger.info('duplicate delivery webhook ignored', { eventId, type: event.type });
    return { accepted: true, duplicate: true, eventType: event.type };
  }

  const providerMessageId = event.data.email_id ?? null;
  const message = providerMessageId ? await findMessageByProviderId(providerMessageId) : null;
  const recipient = message?.contact_email ?? parseAddress(event.data.to ?? null);
  const db = await getDb();

  switch (event.type) {
    case 'email.delivered': {
      if (message) {
        await db.query(
          `UPDATE messages SET status = 'DELIVERED', delivered_at = COALESCE(delivered_at, now())
            WHERE id = $1 AND status IN ('SENT','SENDING','DELIVERED')`,
          [message.id],
        );
      }
      break;
    }

    case 'email.bounced': {
      const bounceType = classifyBounce(event.data.bounce);
      if (message) {
        await db.query(
          `UPDATE messages SET status = 'BOUNCED', bounced_at = COALESCE(bounced_at, now()), bounce_type = $2
            WHERE id = $1`,
          [message.id, bounceType],
        );
      }
      if (bounceType === 'HARD' && recipient) {
        await suppress({ email: recipient, reason: 'HARD_BOUNCE', notes: event.data.bounce?.message });
        if (message?.prospect_id) {
          await db.query(
            `UPDATE prospects SET status = 'BOUNCED', suppressed_at = COALESCE(suppressed_at, now()), updated_at = now()
              WHERE id = $1`,
            [message.prospect_id],
          );
        }
      }
      break;
    }

    case 'email.complained': {
      // A complaint is the strongest possible signal. Suppress immediately,
      // before anything else, and never mind which message it was.
      if (recipient) await suppress({ email: recipient, reason: 'COMPLAINT', notes: 'spam complaint' });
      if (message) {
        await db.query(
          `UPDATE messages SET status = 'COMPLAINED', complained_at = COALESCE(complained_at, now()) WHERE id = $1`,
          [message.id],
        );
        if (message.prospect_id) {
          await db.query(
            `UPDATE prospects SET status = 'SUPPRESSED', suppressed_at = COALESCE(suppressed_at, now()), updated_at = now()
              WHERE id = $1`,
            [message.prospect_id],
          );
        }
      }
      break;
    }

    case 'email.opened': {
      // RECORDED ONLY. An open is not interest, not intent, and not evidence.
      // Nothing downstream reads opened_at except the dashboard.
      if (message) {
        await db.query('UPDATE messages SET opened_at = COALESCE(opened_at, now()) WHERE id = $1', [message.id]);
      }
      break;
    }

    case 'email.clicked': {
      // Also not intent. A click is a visit, not a commitment.
      if (message) {
        await db.query('UPDATE messages SET clicked_at = COALESCE(clicked_at, now()) WHERE id = $1', [message.id]);
      }
      break;
    }

    case 'email.delivery_delayed': {
      if (message) {
        await db.query(
          `UPDATE messages SET error = $2 WHERE id = $1 AND status NOT IN ('BOUNCED','COMPLAINED')`,
          [message.id, 'DELAYED:provider reported a delivery delay'],
        );
      }
      break;
    }

    default:
      logger.info('unhandled delivery event type', { type: event.type });
      break;
  }

  await markEventProcessed(eventId);
  await recordAudit({
    entityType: 'message',
    entityId: message?.id ?? null,
    eventType: 'DECISION',
    actor: 'outreach:delivery_webhook',
    reason: event.type,
    detail: { eventId, providerMessageId, matched: Boolean(message) },
  });

  return { accepted: true, duplicate: false, eventType: event.type };
}

// --- inbound replies ---------------------------------------------------------

interface OriginalMessageRow {
  id: string;
  campaign_id: string | null;
  prospect_id: string | null;
  thread_id: string | null;
  subject: string;
}

async function findOriginalMessage(params: {
  referenceIds: string[];
  prospectId: string | null;
}): Promise<OriginalMessageRow | null> {
  for (const ref of params.referenceIds) {
    const row = await one<OriginalMessageRow>(
      `SELECT id, campaign_id, prospect_id, thread_id, subject
         FROM messages
        WHERE direction = 'OUTBOUND' AND provider_message_id = $1
        LIMIT 1`,
      [ref],
    );
    if (row) return row;
  }
  if (params.prospectId) {
    return one<OriginalMessageRow>(
      `SELECT id, campaign_id, prospect_id, thread_id, subject
         FROM messages
        WHERE direction = 'OUTBOUND' AND prospect_id = $1
        ORDER BY COALESCE(sent_at, created_at) DESC
        LIMIT 1`,
      [params.prospectId],
    );
  }
  return null;
}

async function findProspectByEmail(email: string): Promise<ProspectRow | null> {
  return one<ProspectRow>(
    `SELECT id, company_name, domain, contact_email, contact_name_if_public,
            public_evidence_url, qualification_reason, country, status
       FROM prospects
      WHERE lower(contact_email) = $1
      ORDER BY updated_at DESC
      LIMIT 1`,
    [normalizeEmail(email)],
  );
}

const INBOUND_EMPTY: InboundResult = {
  accepted: false,
  duplicate: false,
  classification: null,
  commitmentsCreated: 0,
  autoReplied: false,
  suppressed: false,
};

export async function handleInboundWebhook(
  rawBody: string,
  headers: Record<string, string>,
): Promise<InboundResult> {
  const cfg = getConfig();
  const verification = verifyWebhookSignature(rawBody, headers, cfg.resendInboundWebhookSecret);
  if (!verification.ok) {
    logger.warn('rejected an unverified inbound webhook', { reason: verification.reason });
    return { ...INBOUND_EMPTY };
  }

  const parsed = InboundEvent.safeParse(safeJsonParse(rawBody));
  if (!parsed.success) return { ...INBOUND_EMPTY };
  const event = parsed.data;
  const eventId = verification.eventId ?? sha256(rawBody);

  if (!(await claimEvent(eventId, 'resend-inbound', event.type, event))) {
    logger.info('duplicate inbound webhook ignored', { eventId });
    return { ...INBOUND_EMPTY, accepted: true, duplicate: true };
  }

  const fromAddress = parseAddress(event.data.from ?? null);
  if (!fromAddress) {
    await markEventProcessed(eventId);
    return { ...INBOUND_EMPTY, accepted: true };
  }

  // Untrusted content: sanitized to text, never rendered, never evaluated.
  const body = parseInboundBody({ text: event.data.text ?? null, html: event.data.html ?? null });
  const subject = (event.data.subject ?? '').slice(0, 300);
  const inboundHeaders = event.data.headers ?? {};

  const prospectRow = await findProspectByEmail(fromAddress);
  const original = await findOriginalMessage({
    referenceIds: referencedMessageIds({
      inReplyTo: event.data.in_reply_to ?? null,
      references: event.data.references ?? null,
    }),
    prospectId: prospectRow?.id ?? null,
  });

  const offer = original?.campaign_id ? await loadOffer(original.campaign_id) : null;
  const classification = await classifyReply({
    text: body.cleaned,
    subject,
    headers: inboundHeaders,
    offerSummary: offer
      ? `${offer.copy.productName}: ${offer.copy.outcome} at $${offer.priceMonthly}/month (not built yet, being validated)`
      : '',
  });
  const analysis = classification.analysis;

  const db = await getDb();
  const inboundId = await insertInboundMessage({
    campaignId: original?.campaign_id ?? null,
    prospectId: prospectRow?.id ?? null,
    providerMessageId: event.data.message_id ?? event.data.email_id ?? eventId,
    threadId: original?.thread_id ?? original?.id ?? null,
    subject,
    body: body.cleaned,
    classification: analysis.classification,
    intentScore: analysis.intentScore,
    requiresHuman: analysis.requiresHuman,
    extraction: {
      intent: analysis.intent,
      requestedFeature: analysis.requestedFeature,
      competitorMentioned: analysis.competitorMentioned,
      priceReaction: analysis.priceReaction,
      timing: analysis.timing,
      explicitlyWantsAccess: analysis.explicitlyWantsAccess,
      explicitlyAcceptedPrice: analysis.explicitlyAcceptedPrice,
      deterministicRule: classification.rule,
    },
  });

  // --- opt-out is handled before anything else ---
  let suppressed = false;
  if (analysis.classification === 'UNSUBSCRIBE') {
    await suppress({ email: fromAddress, reason: 'EXPLICIT_STOP', notes: 'opt-out in reply body' });
    suppressed = true;
  }

  if (prospectRow) {
    await db.query(
      `UPDATE prospects
          SET status = CASE WHEN status IN ('SUPPRESSED','BOUNCED','COMMITTED') THEN status ELSE 'REPLIED' END,
              updated_at = now()
        WHERE id = $1`,
      [prospectRow.id],
    );
  }

  // --- commitments ---
  let commitmentsCreated = 0;
  const campaignId = original?.campaign_id ?? null;
  if (!suppressed && campaignId) {
    const types = commitmentTypesFor(analysis, body.cleaned);
    if (types.length > 0) {
      const companyKey = companyKeyFor({ domain: prospectRow?.domain ?? null, email: fromAddress });
      const inputs: CommitmentInput[] = types.map((type) => ({
        campaignId,
        prospectId: prospectRow?.id ?? null,
        companyKey,
        type,
        priceMonthly: offer?.priceMonthly ?? null,
        source: 'EMAIL_REPLY',
        evidenceText: body.cleaned.slice(0, 2000),
        evidenceUrl: null,
        messageId: inboundId,
        verified: false,
      }));
      commitmentsCreated = await recordCommitments(inputs);
      if (commitmentsCreated > 0 && prospectRow) {
        await db.query(
          `UPDATE prospects SET status = 'COMMITTED', updated_at = now()
            WHERE id = $1 AND status NOT IN ('SUPPRESSED','BOUNCED')`,
          [prospectRow.id],
        );
      }
    }
  }

  // --- bounded auto-reply ---
  let autoReplied = false;
  let requiresHuman = analysis.requiresHuman;
  if (!suppressed && offer && prospectRow && original) {
    const prospect = prospectContextFromRow(prospectRow);
    const stillSendable = prospect !== null && !(await isSuppressed(prospect.contactEmail));
    if (prospect && stillSendable) {
      const decision = await draftAutoReply({
        analysis,
        replyText: body.cleaned,
        offer,
        prospect,
        subject,
      });
      if (decision.message) {
        const draftId = await insertDraftMessage({
          campaignId: offer.campaignId,
          prospectId: prospect.id,
          step: -1,
          message: decision.message,
          idempotencyKey: autoReplyIdempotencyKey(inboundId),
          threadId: original.thread_id ?? original.id,
        });
        if (draftId) {
          const outcome = await sendDraftedMessageNow(draftId);
          autoReplied = outcome.sent;
          if (!outcome.sent) {
            logger.info('auto-reply drafted but not sent', { reason: outcome.reason, draftId });
          }
        }
      } else if (decision.requiresHuman) {
        requiresHuman = true;
        await db.query('UPDATE messages SET requires_human = true WHERE id = $1', [inboundId]);
        logger.info('auto-reply refused; a human must answer', {
          reason: decision.reason,
          violations: decision.violations,
        });
      }
    }
  } else if (!suppressed && analysis.classification !== 'OUT_OF_OFFICE' && analysis.classification !== 'NOT_INTERESTED') {
    requiresHuman = true;
    await db.query('UPDATE messages SET requires_human = true WHERE id = $1', [inboundId]);
  }

  await markEventProcessed(eventId);
  await recordAudit({
    entityType: 'message',
    entityId: inboundId,
    eventType: 'DECISION',
    actor: 'outreach:inbound_webhook',
    reason: analysis.classification,
    detail: {
      deterministic: classification.deterministic,
      rule: classification.rule,
      commitmentsCreated,
      autoReplied,
      suppressed,
      requiresHuman,
    },
  });

  return {
    accepted: true,
    duplicate: false,
    classification: analysis.classification,
    commitmentsCreated,
    autoReplied,
    suppressed,
  };
}

async function insertInboundMessage(params: {
  campaignId: string | null;
  prospectId: string | null;
  providerMessageId: string;
  threadId: string | null;
  subject: string;
  body: string;
  classification: string;
  intentScore: number;
  requiresHuman: boolean;
  extraction: Record<string, unknown>;
}): Promise<string> {
  const db = await getDb();
  const id = newId('msg');
  const res = await db.query<{ id: string }>(
    `INSERT INTO messages
       (id, campaign_id, prospect_id, direction, sequence_step, provider_message_id, thread_id,
        subject, body, received_at, classification, intent_score, requires_human, status,
        idempotency_key, extraction_json)
     VALUES ($1,$2,$3,'INBOUND',-1,$4,$5,$6,$7, now(), $8,$9,$10,'RECEIVED',$11,$12)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      id,
      params.campaignId,
      params.prospectId,
      params.providerMessageId,
      params.threadId ?? id,
      params.subject,
      params.body,
      params.classification,
      // Advisory metadata only. Nothing in this system branches on it.
      params.intentScore,
      params.requiresHuman,
      `inbound:${params.providerMessageId}`,
      JSON.stringify(params.extraction),
    ],
  );
  const inserted = res.rows[0]?.id;
  if (inserted) return inserted;
  const existing = await one<{ id: string }>('SELECT id FROM messages WHERE idempotency_key = $1', [
    `inbound:${params.providerMessageId}`,
  ]);
  return existing?.id ?? id;
}
