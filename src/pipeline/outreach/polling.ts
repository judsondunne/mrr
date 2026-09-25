/**
 * POLLING: real delivery state and real replies, without a public endpoint.
 *
 * Two jobs the supervisor runs on a timer:
 *
 *   reconcileDelivery()  asks Resend what happened to each message we sent and
 *                        records its answer. Delivery is never inferred here.
 *   pollInbound()        pulls replies from the Resend inbox, attaches each to
 *                        the outbound message that caused it, classifies it,
 *                        and moves the validation ladder.
 *
 * Threading is done on the RFC Message-ID, which is the identifier a real mail
 * client quotes back in In-Reply-To/References. Resend's own UUID never appears
 * in a reply, so matching on it would silently fail on every real conversation.
 * Subject matching is a last resort and is recorded as such.
 */
import { getConfig } from '../../lib/config';
import { getDb, one } from '../../lib/db';
import { newId } from '../../lib/hash';
import { createLogger, errorToFields } from '../../lib/logger';
import { recordAudit } from '../../lib/audit';
import { getSentEmail, listInboundEmails, type ResendLastEvent } from '../../lib/email/resend-api';
import { suppress, isSuppressed, companyKeyFor, normalizeEmail } from './suppression';
import { classifyReply } from './classify';
import { deterministicIntent, reconcile as reconcileIntent, IntentExtraction } from './intent';
import { llmComplete } from '../../lib/llm/index';
import { reevaluate } from '../validation/ladder';

const logger = createLogger('outreach:polling');

// --- delivery ----------------------------------------------------------------

/** How Resend's vocabulary maps onto ours. */
const EVENT_TO_STATUS: Readonly<Record<string, string>> = {
  sent: 'SENT',
  delivered: 'DELIVERED',
  delivery_delayed: 'SENT',
  bounced: 'BOUNCED',
  complained: 'COMPLAINED',
  failed: 'FAILED',
  canceled: 'FAILED',
};

export interface ReconcileResult {
  checked: number;
  updated: number;
  delivered: number;
  bounced: number;
  complained: number;
}

/**
 * Brings local delivery state in line with the provider's.
 *
 * Only messages that have actually left and are not yet in a terminal state
 * are polled, so this stays cheap however much history accumulates.
 */
export async function reconcileDelivery(limit = 100): Promise<ReconcileResult> {
  const db = await getDb();
  const out: ReconcileResult = { checked: 0, updated: 0, delivered: 0, bounced: 0, complained: 0 };

  const pending = await db.query<{ id: string; provider_message_id: string; status: string; campaign_id: string | null }>(
    `SELECT id, provider_message_id, status, campaign_id
       FROM messages
      WHERE direction = 'OUTBOUND'
        AND provider_message_id IS NOT NULL
        AND status NOT IN ('DELIVERED','BOUNCED','COMPLAINED','FAILED')
        AND sent_at IS NOT NULL
      ORDER BY sent_at ASC
      LIMIT $1`,
    [Math.max(1, limit)],
  );

  for (const row of pending.rows) {
    const remote = await getSentEmail(row.provider_message_id);
    out.checked += 1;
    if (!remote) continue;

    const event: ResendLastEvent | null = remote.lastEvent;
    const status = event ? EVENT_TO_STATUS[event] : undefined;

    // Record the RFC Message-ID the first time we see it: without it no reply
    // can be threaded back to this message.
    if (remote.messageId) {
      await db.query(
        'UPDATE messages SET rfc_message_id = COALESCE(rfc_message_id, $2) WHERE id = $1',
        [row.id, remote.messageId],
      );
    }

    await db.query(
      'UPDATE messages SET provider_last_event = $2, provider_checked_at = now() WHERE id = $1',
      [row.id, event ?? null],
    );

    if (!status || status === row.status) continue;

    await db.query(
      `UPDATE messages
          SET status = $2,
              delivered_at = CASE WHEN $2 = 'DELIVERED' THEN COALESCE(delivered_at, now()) ELSE delivered_at END,
              bounced_at   = CASE WHEN $2 = 'BOUNCED'   THEN COALESCE(bounced_at, now())   ELSE bounced_at END,
              complained_at= CASE WHEN $2 = 'COMPLAINED'THEN COALESCE(complained_at, now())ELSE complained_at END
        WHERE id = $1`,
      [row.id, status],
    );
    out.updated += 1;
    if (status === 'DELIVERED') out.delivered += 1;

    // A bounce or a complaint is a suppression event, not a statistic.
    if (status === 'BOUNCED' || status === 'COMPLAINED') {
      if (status === 'BOUNCED') out.bounced += 1;
      else out.complained += 1;

      const prospect = await one<{ contact_email: string; domain: string }>(
        `SELECT p.contact_email, p.domain FROM messages m
           JOIN prospects p ON p.id = m.prospect_id WHERE m.id = $1`,
        [row.id],
      );
      if (prospect?.contact_email) {
        await suppress({
          email: prospect.contact_email,
          reason: status === 'BOUNCED' ? 'HARD_BOUNCE' : 'COMPLAINT',
          notes: `resend reported ${event} on poll`,
        });
      }
    }

    await recordAudit({
      entityType: 'message',
      entityId: row.id,
      eventType: 'SEND',
      actor: 'polling:reconcile',
      reason: `provider reported ${event}`,
      detail: { providerMessageId: row.provider_message_id, status },
    });
  }

  if (out.checked > 0) logger.info('delivery reconciled', { ...out });
  return out;
}

// --- inbound -----------------------------------------------------------------

export interface InboundPollResult {
  fetched: number;
  claimed: number;
  processed: number;
  matched: number;
  unmatched: number;
  suppressed: number;
}

/** Message-IDs a reply is quoting, most specific first. */
function referencedIds(inReplyTo: string | null, references: string | null): string[] {
  const ids: string[] = [];
  const push = (raw: string | null): void => {
    if (!raw) return;
    for (const m of raw.matchAll(/<([^>]+)>/g)) {
      const id = m[1];
      if (id && !ids.includes(id)) ids.push(id);
    }
    // Some clients omit the angle brackets entirely.
    const bare = raw.trim();
    if (bare !== '' && !bare.includes('<') && !ids.includes(bare)) ids.push(bare);
  };
  push(inReplyTo);
  push(references);
  return ids;
}

/**
 * Attaches an inbound message to the outbound one that caused it.
 *
 * In order of trustworthiness: the Message-ID it quotes, then the most recent
 * message sent to that address. The method used is recorded, because a
 * subject-matched thread is materially weaker evidence than a header-matched
 * one and later analysis should be able to tell them apart.
 */
async function matchOutbound(params: {
  inReplyTo: string | null;
  references: string | null;
  fromAddress: string;
}): Promise<{ messageId: string; method: string } | null> {
  for (const ref of referencedIds(params.inReplyTo, params.references)) {
    const hit = await one<{ id: string }>(
      `SELECT id FROM messages
        WHERE direction = 'OUTBOUND' AND rfc_message_id IS NOT NULL
          AND (rfc_message_id = $1 OR rfc_message_id = '<' || $1 || '>')
        LIMIT 1`,
      [ref],
    );
    if (hit) return { messageId: hit.id, method: 'RFC_MESSAGE_ID' };
  }

  const email = normalizeEmail(params.fromAddress);
  const recent = await one<{ id: string }>(
    `SELECT m.id FROM messages m
       JOIN prospects p ON p.id = m.prospect_id
      WHERE m.direction = 'OUTBOUND' AND lower(p.contact_email) = $1
      ORDER BY COALESCE(m.sent_at, m.created_at) DESC
      LIMIT 1`,
    [email],
  );
  if (recent) return { messageId: recent.id, method: 'RECIPIENT_FALLBACK' };
  return null;
}

const CLASSIFY_SYSTEM = [
  'You read ONE inbound business email and report what it commercially means.',
  'Use only the supplied text.',
  'evidenceQuote MUST be copied VERBATIM from the reply.',
  'Be conservative. Politeness is not interest; interest is not willingness to pay.',
  '"Sounds interesting" is INTERESTED, never WILLING_TO_PAY.',
  'Only name an amount the sender themselves offered to pay. Money they already',
  'spend on something else is currentSpend, not willingness to pay.',
  'qualifiedCompany is false for vendors selling into this space, consultants,',
  'students, researchers and competitors.',
].join('\n');

/**
 * Pulls replies, threads them, classifies them and advances the ladder.
 *
 * Every inbound message is claimed exactly once by a unique-constrained insert,
 * so repeated polling — including two overlapping runs — cannot double-process.
 */
export async function pollInbound(limit = 50): Promise<InboundPollResult> {
  const cfg = getConfig();
  const out: InboundPollResult = { fetched: 0, claimed: 0, processed: 0, matched: 0, unmatched: 0, suppressed: 0 };

  const inbound = await listInboundEmails(limit);
  out.fetched = inbound.length;

  for (const mail of inbound) {
    if (!mail.id) continue;

    // Claim it. The unique index on provider_inbound_id is what makes polling
    // idempotent; a second sighting inserts nothing.
    const db = await getDb();
    const claimed = await db.query<{ id: string }>(
      `INSERT INTO inbound_emails
         (id, provider_inbound_id, from_address, to_address, subject, text_body,
          rfc_message_id, in_reply_to, references_header, received_at, raw_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (provider_inbound_id) DO NOTHING
       RETURNING id`,
      [
        newId('inb'),
        mail.id,
        mail.from,
        mail.to[0] ?? null,
        mail.subject,
        mail.text,
        mail.messageId,
        mail.inReplyTo,
        mail.references,
        mail.createdAt || null,
        JSON.stringify(mail.raw ?? {}),
      ],
    );
    if (claimed.rows.length === 0) continue;
    out.claimed += 1;

    const localId = claimed.rows[0]?.id;
    if (!localId) continue;

    try {
      await processInbound(localId, mail, out);
      out.processed += 1;
    } catch (err) {
      logger.error('inbound processing failed', { inboundId: localId, ...errorToFields(err) });
    }
  }

  if (out.fetched > 0) logger.info('inbound poll complete', { ...out, inbox: cfg.resendInboundAddress });
  return out;
}

async function processInbound(
  localId: string,
  mail: Awaited<ReturnType<typeof listInboundEmails>>[number],
  out: InboundPollResult,
): Promise<void> {
  const db = await getDb();
  const fromAddress = extractAddress(mail.from);
  const body = stripQuotedReply(mail.text);

  const match = await matchOutbound({
    inReplyTo: mail.inReplyTo,
    references: mail.references,
    fromAddress,
  });
  if (match) out.matched += 1;
  else out.unmatched += 1;

  const original = match
    ? await one<{ id: string; campaign_id: string | null; prospect_id: string | null; thread_id: string | null }>(
        'SELECT id, campaign_id, prospect_id, thread_id FROM messages WHERE id = $1',
        [match.messageId],
      )
    : null;

  // Store the reply as a real inbound message row.
  const inboundMessageId = newId('msg');
  await db.query(
    `INSERT INTO messages
       (id, campaign_id, prospect_id, direction, sequence_step, provider_message_id,
        thread_id, subject, body, received_at, status, idempotency_key)
     VALUES ($1,$2,$3,'INBOUND',-1,$4,$5,$6,$7, now(), 'RECEIVED', $8)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      inboundMessageId,
      original?.campaign_id ?? null,
      original?.prospect_id ?? null,
      mail.id,
      original?.thread_id ?? original?.id ?? null,
      mail.subject,
      body,
      `inbound:${mail.id}`,
    ],
  );

  await db.query(
    'UPDATE inbound_emails SET processed_at = now(), matched_message_id = $2, match_method = $3 WHERE id = $1',
    [localId, match?.messageId ?? null, match?.method ?? 'UNMATCHED'],
  );

  // --- opt-out first, always ---
  const deterministic = deterministicIntent(body, {});
  if (deterministic?.intent === 'UNSUBSCRIBE') {
    await suppress({ email: fromAddress, reason: 'EXPLICIT_STOP', notes: 'reply-based opt-out' });
    out.suppressed += 1;
    await db.query(
      `UPDATE messages SET classification = 'UNSUBSCRIBE' WHERE id = $1`,
      [inboundMessageId],
    );
    await recordAudit({
      entityType: 'message',
      entityId: inboundMessageId,
      eventType: 'SUPPRESS',
      actor: 'polling:inbound',
      reason: 'prospect asked to stop; suppressed and follow-ups cancelled',
      detail: { from: fromAddress },
    });
    // Cancel anything still queued for them.
    if (original?.prospect_id) {
      await db.query(
        `UPDATE messages SET status = 'FAILED', error = 'cancelled: recipient opted out'
          WHERE prospect_id = $1 AND direction = 'OUTBOUND' AND status IN ('PENDING','DRAFTED')`,
        [original.prospect_id],
      );
    }
    return;
  }

  // --- classify ---
  const legacy = await classifyReply({ text: body, subject: mail.subject });
  let extraction: IntentExtraction | null = null;
  try {
    const res = await llmComplete({
      tier: 'fast',
      phase: 'REPLY',
      task: 'outreach.reply_intent',
      schemaName: 'IntentExtraction',
      schema: IntentExtraction,
      maxTokens: 800,
      system: CLASSIFY_SYSTEM,
      user: JSON.stringify({ subject: mail.subject }),
      untrusted: { inbound_email: body.slice(0, 6000) },
    });
    extraction = res.data;
  } catch (err) {
    logger.warn('intent extraction failed; keeping the deterministic reading', {
      err: String(err).slice(0, 140),
    });
  }

  if (!extraction) {
    await db.query('UPDATE messages SET classification = $2, requires_human = true WHERE id = $1', [
      inboundMessageId,
      legacy.analysis.classification,
    ]);
    return;
  }

  // The words cap the verdict. A model may not promote enthusiasm into money.
  const verdict = reconcileIntent(extraction, body, {});

  const companyKey = companyKeyFor({ email: fromAddress });
  const opportunityId = original?.campaign_id
    ? (
        await one<{ opportunity_id: string }>('SELECT opportunity_id FROM campaigns WHERE id = $1', [
          original.campaign_id,
        ])
      )?.opportunity_id ?? null
    : null;

  await db.query(
    `INSERT INTO reply_insights
       (id, message_id, campaign_id, opportunity_id, company_key, intent, confidence,
        evidence_quote, current_workflow, current_tools, current_spend, stated_amount_usd,
        price_sensitivity, requested_capability, objection, next_action, decision_maker,
        unsolicited, qualified_company, disqualified_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     ON CONFLICT (message_id) DO NOTHING`,
    [
      newId('ri'),
      inboundMessageId,
      original?.campaign_id ?? null,
      opportunityId,
      companyKey,
      verdict.intent,
      verdict.confidence,
      verdict.quoteVerified ? verdict.evidenceQuote : '',
      verdict.currentWorkflow,
      verdict.currentTools,
      verdict.currentSpend,
      verdict.statedAmountUsd,
      verdict.priceSensitivity,
      verdict.requestedCapability,
      verdict.objection,
      verdict.nextAction,
      verdict.decisionMaker,
      verdict.unsolicited,
      verdict.qualifiedCompany,
      verdict.disqualifiedReason,
    ],
  );

  await db.query(
    'UPDATE messages SET classification = $2, intent_score = $3, requires_human = $4 WHERE id = $1',
    [
      inboundMessageId,
      verdict.intent,
      verdict.confidence,
      verdict.intent === 'PAYMENT_COMMITMENT' || /\b(call|zoom|meet|phone|speak)\b/i.test(body),
    ],
  );

  logger.info('reply classified', {
    intent: verdict.intent,
    demoted: verdict.demoted,
    company: companyKey,
    matched: match?.method ?? 'UNMATCHED',
  });

  if (opportunityId) await reevaluate(opportunityId, { hasOutreach: true });
}

// --- helpers -----------------------------------------------------------------

/** "Name <a@b.com>" -> "a@b.com" */
export function extractAddress(from: string): string {
  const m = /<([^>]+)>/.exec(from ?? '');
  return normalizeEmail(m?.[1] ?? from ?? '');
}

/**
 * Drops the quoted history and signature so the classifier reads what the
 * person actually wrote. Without this, our own outbound copy — which contains
 * the price we proposed — is fed back in and read as the prospect's words.
 */
export function stripQuotedReply(text: string): string {
  if (!text) return '';
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) break;
    if (/^\s*On .+ wrote:\s*$/i.test(line)) break;
    if (/^\s*-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    if (/^\s*From:\s.+@/i.test(line)) break;
    if (/^\s*--\s*$/.test(line)) break; // signature delimiter
    kept.push(line);
  }
  const body = kept.join('\n').trim();
  return body.length > 0 ? body : text.trim();
}

export async function inboundIsConfigured(): Promise<{ ok: boolean; reason: string }> {
  const cfg = getConfig();
  if (!cfg.resendInboundAddress) {
    return { ok: false, reason: 'RESEND_INBOUND_ADDRESS is not set; replies cannot be received' };
  }
  if (await isSuppressed(cfg.resendInboundAddress)) {
    return { ok: false, reason: 'the inbound address is suppressed' };
  }
  return { ok: true, reason: '' };
}
