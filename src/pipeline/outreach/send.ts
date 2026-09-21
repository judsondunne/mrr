/**
 * THE SEND PATH. The most safety-critical code in this system.
 *
 * Everything below exists to make these statements true:
 *
 *   1. No email is ever sent twice. A message is claimed with a conditional
 *      UPDATE (... WHERE status='DRAFTED') inside a transaction; only the run
 *      whose UPDATE returns a row may call the provider, and the provider id is
 *      written back in the same transaction boundary as the status change.
 *   2. No suppressed address or domain is ever emailed — re-checked in the
 *      instant before the provider call, not just at draft time.
 *   3. Volume is bounded three ways at once: per batch (25 -> health -> 50 ->
 *      health -> 150), per day (MAX_EMAILS_PER_DAY), and per campaign.
 *   4. Nothing goes out outside the configured local sending window.
 *   5. In shadow mode the provider is never even reached.
 */
import { getConfig, isShadowMode, type Config } from '../../lib/config';
import { getDb, many, one, toNumber } from '../../lib/db';
import { AppError, BudgetExceededError, isRetryable } from '../../lib/errors';
import { createLogger } from '../../lib/logger';
import { assertBudget, remainingDailyEmailQuota } from '../../lib/cost';
import { recordAudit, transitionOpportunity } from '../../lib/audit';
import { assertCampaignTransition, type CampaignState } from '../../lib/state-machine';
import { sendEmail } from '../../lib/email/index';
import { assertCompliant, withHeaders, type ComposedMessage } from './compose';
import { ComplianceError } from './errors';
import { checkCampaignHealth } from '../../lib/campaign-health';
import { companyKeyFor, isCountryAllowed, isSuppressed, normalizeEmail, suppress } from './suppression';
import { sendingWindowStatus } from './window';
import {
  evaluateDeliverability,
  getSendAllowance,
  isSendingPaused,
  maybeAdvanceRamp,
  recordFirstSend,
  resumeSendingIfRecovered,
} from '../../autonomy/deliverability';
import { canContactCompanyForCampaign, recordContact, upsertCompany } from '../../autonomy/company';
import { recordRoleOutcomeFor } from './contact-role';
import { recordOutboundTurn } from './conversation';
import type { SendResult } from './index';

const logger = createLogger('outreach:send');

/** States from which a campaign may still put mail on the wire. */
const SENDABLE_STATES: readonly CampaignState[] = [
  'READY',
  'BATCH_1',
  'BATCH_1_REVIEW',
  'BATCH_2',
  'BATCH_2_REVIEW',
  'SCALING',
];

const MAX_SEND_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 150;

interface CampaignRow {
  id: string;
  opportunity_id: string;
  state: string;
  landing_slug: string;
}

interface SendableRow {
  id: string;
  campaign_id: string;
  prospect_id: string | null;
  subject: string;
  body: string;
  thread_id: string | null;
  sequence_step: number;
  contact_email: string | null;
  country: string | null;
  prospect_status: string | null;
  domain: string | null;
}

/** The columns every send path needs. One definition, so they cannot drift. */
const SENDABLE_COLUMNS = `m.id, m.campaign_id, m.prospect_id, m.subject, m.body, m.thread_id,
            m.sequence_step,
            p.contact_email, p.country, p.status AS prospect_status, p.domain`;

// --- batch planning ----------------------------------------------------------

/** Cumulative number of emails a campaign is allowed to have sent, by state. */
export function cumulativeTargetForState(state: string, cfg: Config): number {
  switch (state) {
    case 'READY':
    case 'BATCH_1':
      return cfg.initialEmailBatch;
    case 'BATCH_2':
      return Math.min(cfg.initialEmailBatch + cfg.secondEmailBatch, cfg.maxEmailsPerCampaign);
    case 'SCALING':
      return cfg.maxEmailsPerCampaign;
    default:
      return 0;
  }
}

/** The review state a batch rolls into once its quota is used up. */
function reviewStateAfter(state: string): CampaignState | null {
  switch (state) {
    case 'BATCH_1':
      return 'BATCH_1_REVIEW';
    case 'BATCH_2':
      return 'BATCH_2_REVIEW';
    case 'SCALING':
      return 'COMPLETE';
    default:
      return null;
  }
}

async function setCampaignState(
  campaignId: string,
  from: string,
  to: CampaignState,
  reason: string,
  haltReason?: string,
): Promise<void> {
  assertCampaignTransition(from as CampaignState, to);
  const db = await getDb();
  await db.query(
    `UPDATE campaigns
        SET state = $2, updated_at = now(),
            halt_reason = $3,
            ended_at = CASE WHEN $2 IN ('COMPLETE','FAILED','HALTED') THEN now() ELSE ended_at END
      WHERE id = $1 AND state = $4`,
    [campaignId, to, haltReason ?? null, from],
  );
  await recordAudit({
    entityType: 'campaign',
    entityId: campaignId,
    eventType: 'STATE_TRANSITION',
    actor: 'outreach:send_due_messages',
    fromState: from,
    toState: to,
    reason,
  });
}

/**
 * Everything that has been handed to, or may have been handed to, the provider.
 * SENDING is counted: a row stuck mid-send may or may not have gone out, so it
 * consumes batch quota rather than being quietly re-attempted.
 */
async function sentCountFor(campaignId: string): Promise<number> {
  const row = await one<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM messages
      WHERE campaign_id = $1 AND direction = 'OUTBOUND'
        AND status IN ('SENDING','SENT','DELIVERED','BOUNCED','COMPLAINED')`,
    [campaignId],
  );
  return toNumber(row?.n);
}

// --- message state transitions ----------------------------------------------

/**
 * The claim. This is the duplicate-send guard: the UPDATE only matches a row
 * that is still DRAFTED, so of two concurrent scheduler runs exactly one gets
 * the row and the other gets zero rows and moves on.
 */
export async function claimMessage(messageId: string): Promise<boolean> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const res = await tx.query<{ id: string }>(
      `UPDATE messages SET status = 'SENDING', error = NULL
        WHERE id = $1 AND status = 'DRAFTED'
        RETURNING id`,
      [messageId],
    );
    return res.rowCount === 1;
  });
}

/** Status change and provider id are written together, or not at all. */
async function markSent(messageId: string, providerMessageId: string): Promise<void> {
  const db = await getDb();
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE messages
          SET status = 'SENT', provider_message_id = $2, sent_at = now(), error = NULL
        WHERE id = $1 AND status = 'SENDING'`,
      [messageId, providerMessageId],
    );
  });
}

/**
 * A claimed message that failed every attempt is FAILED, never returned to
 * DRAFTED.
 *
 * This is deliberate and asymmetric. A provider timeout is ambiguous — the
 * email may well have gone out — so re-queueing it risks sending a real
 * business the same email twice. Not sending costs one lead; double-sending
 * costs trust and is the exact failure this layer exists to prevent. Retries
 * happen inside the claim (sendWithRetry) and nowhere else; an operator can
 * requeue a FAILED row deliberately after looking at it.
 */
async function releaseMessage(messageId: string, err: unknown): Promise<void> {
  const db = await getDb();
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE messages SET status = 'FAILED', error = $2 WHERE id = $1 AND status = 'SENDING'`,
      [messageId, `${isRetryable(err) ? 'RETRIES_EXHAUSTED:' : ''}${truncate(String(err), 480)}`],
    );
  });
}

/** A message we will never send. Recorded with a SKIPPED: prefix so the health
 *  check can tell a policy decision apart from an infrastructure failure. */
async function skipMessage(messageId: string, reason: string): Promise<void> {
  const db = await getDb();
  await db.query(`UPDATE messages SET status = 'FAILED', error = $2 WHERE id = $1`, [
    messageId,
    `SKIPPED:${reason}`,
  ]);
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

// --- provider call with backoff ---------------------------------------------

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff, but only for errors the provider marked retryable. */
export async function sendWithRetry(message: ComposedMessage & { inReplyTo?: string; references?: string }) {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_SEND_ATTEMPTS; attempt += 1) {
    try {
      return await sendEmail({
        to: message.to,
        subject: message.subject,
        text: message.text,
        headers: message.headers,
        inReplyTo: message.inReplyTo,
        references: message.references,
      });
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === MAX_SEND_ATTEMPTS - 1) break;
      await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new AppError(String(lastError), 'SEND_FAILED');
}

// --- the per-message guard ---------------------------------------------------

export type SendOutcome = 'SENT' | 'SKIPPED' | 'FAILED' | 'CLAIM_LOST';

function rebuildMessage(row: SendableRow, email: string): ComposedMessage {
  // Headers are regenerated from the recipient rather than trusted from the
  // stored draft, so a tampered row cannot produce a mismatched opt-out link.
  return withHeaders(email, row.subject, row.body);
}

/**
 * Guard rails for exactly one message. Every check here runs immediately before
 * the provider call — not at draft time, not "earlier in the job".
 */
export async function sendOneMessage(row: SendableRow, cfg: Config): Promise<{ outcome: SendOutcome; simulated: boolean }> {
  const rawEmail = row.contact_email ?? '';
  const email = normalizeEmail(rawEmail);

  if (email === '') {
    await skipMessage(row.id, 'NO_RECIPIENT');
    return { outcome: 'SKIPPED', simulated: false };
  }

  if (!isCountryAllowed(row.country, cfg.allowedOutreachCountries)) {
    await suppress({ email, reason: 'COUNTRY_NOT_ALLOWED', notes: `country=${row.country ?? 'unknown'}` });
    await skipMessage(row.id, 'COUNTRY_NOT_ALLOWED');
    return { outcome: 'SKIPPED', simulated: false };
  }

  if (row.prospect_status === 'SUPPRESSED' || row.prospect_status === 'BOUNCED') {
    await skipMessage(row.id, `PROSPECT_${row.prospect_status}`);
    return { outcome: 'SKIPPED', simulated: false };
  }

  // Re-checked here, in the last moment before the provider call.
  if (await isSuppressed(email)) {
    await skipMessage(row.id, 'SUPPRESSED');
    return { outcome: 'SKIPPED', simulated: false };
  }

  // CROSS-CAMPAIGN FATIGUE. One real business is one company, and an
  // unrelated experiment does not get to email it again inside the cooldown.
  //
  // An auto-reply (sequence_step < 0) answers somebody who wrote to US, which
  // is not cold outreach — so only a TERMINAL NEVER_CONTACT stops that. Cold
  // outreach and follow-ups are stopped by any fatigue verdict.
  const companyKey = companyKeyFor({ domain: row.domain, email });
  const eligibility = await canContactCompanyForCampaign(companyKey, row.campaign_id);
  if (!eligibility.allowed && (eligibility.state === 'NEVER_CONTACT' || row.sequence_step >= 0)) {
    const reason = `COMPANY_${eligibility.state}:${eligibility.reason ?? 'blocked'}`;
    await skipMessage(row.id, reason.slice(0, 400));
    await recordAudit({
      entityType: 'message',
      entityId: row.id,
      eventType: 'DECISION',
      actor: 'outreach:send_due_messages',
      reason: `skipped: ${reason}`,
      detail: {
        campaignId: row.campaign_id,
        companyKey,
        contactState: eligibility.state,
        cooldownUntil: eligibility.cooldownUntil?.toISOString() ?? null,
      },
    });
    logger.info('company fatigue: not emailing this business', { companyKey, reason });
    return { outcome: 'SKIPPED', simulated: false };
  }

  const message = rebuildMessage(row, email);
  try {
    assertCompliant(message, cfg);
  } catch (err) {
    if (err instanceof ComplianceError) {
      logger.error('refusing to send a non-compliant message', { messageId: row.id, violations: err.violations });
      await skipMessage(row.id, `COMPLIANCE:${err.violations.join('|')}`);
      return { outcome: 'SKIPPED', simulated: false };
    }
    throw err;
  }

  // Daily cap. Throws BudgetExceededError, which halts the campaign loop.
  await assertBudget('EMAIL_DAILY', 1);

  if (!(await claimMessage(row.id))) {
    logger.info('message was already claimed by another run', { messageId: row.id });
    return { outcome: 'CLAIM_LOST', simulated: false };
  }

  try {
    const threadRef = await threadReferenceFor(row);
    const result = await sendWithRetry({ ...message, ...threadRef });
    await markSent(row.id, result.providerMessageId);
    if (row.prospect_id) await markProspectContacted(row.prospect_id);
    // Starts the domain warm-up clock on the very first real hand-off.
    await recordFirstSend();
    await recordSendBookkeeping(row, email, companyKey);
    await recordAudit({
      entityType: 'message',
      entityId: row.id,
      eventType: 'SEND',
      actor: 'outreach:send_due_messages',
      reason: `step ${row.sequence_step}`,
      detail: {
        campaignId: row.campaign_id,
        prospectId: row.prospect_id,
        provider: result.provider,
        simulated: result.simulated,
      },
    });
    return { outcome: 'SENT', simulated: result.simulated };
  } catch (err) {
    logger.error('send failed', { messageId: row.id, err: String(err) });
    await releaseMessage(row.id, err);
    return { outcome: 'FAILED', simulated: false };
  }
}

/** Follow-ups and auto-replies thread onto the first message of the sequence. */
async function threadReferenceFor(row: SendableRow): Promise<{ inReplyTo?: string; references?: string }> {
  if (row.sequence_step === 0 || !row.thread_id) return {};
  const parent = await one<{ provider_message_id: string | null }>(
    `SELECT provider_message_id FROM messages
      WHERE thread_id = $1 AND provider_message_id IS NOT NULL AND id <> $2
      ORDER BY created_at ASC LIMIT 1`,
    [row.thread_id, row.id],
  );
  if (!parent?.provider_message_id) return {};
  return { inReplyTo: parent.provider_message_id, references: parent.provider_message_id };
}

/**
 * Everything that has to be remembered about a message that actually went out:
 * the company was contacted (fatigue), the contact role got one more data
 * point, and the conversation is now waiting on them.
 *
 * Bookkeeping must never be able to undo a send, so a failure here is logged
 * and swallowed — the email has already left.
 */
async function recordSendBookkeeping(row: SendableRow, email: string, companyKey: string): Promise<void> {
  try {
    await upsertCompany({ companyKey });
    // Cold outreach and follow-ups age the company; an auto-reply does not.
    if (row.sequence_step >= 0) {
      await recordContact({ companyKey, campaignId: row.campaign_id });
    }
    await recordRoleOutcomeFor({ campaignId: row.campaign_id, email }, { sent: 1 });
    if (row.prospect_id) {
      await recordOutboundTurn({
        campaignId: row.campaign_id,
        prospectId: row.prospect_id,
        awaitingReply: true,
      });
    }
  } catch (err) {
    logger.warn('post-send bookkeeping failed', { messageId: row.id, err: String(err) });
  }
}

async function markProspectContacted(prospectId: string): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE prospects
        SET status = CASE WHEN status IN ('QUALIFIED','DISCOVERED','QUALIFYING') THEN 'CONTACTED' ELSE status END,
            updated_at = now()
      WHERE id = $1`,
    [prospectId],
  );
}

// --- the job -----------------------------------------------------------------

async function loadSendableRows(campaignId: string, limit: number): Promise<SendableRow[]> {
  if (limit <= 0) return [];
  return many<SendableRow>(
    `SELECT ${SENDABLE_COLUMNS}
       FROM messages m
       LEFT JOIN prospects p ON p.id = m.prospect_id
      WHERE m.campaign_id = $1
        AND m.direction = 'OUTBOUND'
        AND m.status = 'DRAFTED'
        AND m.sequence_step >= 0
      ORDER BY m.sequence_step ASC, m.created_at ASC
      LIMIT $2`,
    [campaignId, limit],
  );
}

function emptyResult(campaignId: string, haltedReason: string | null, attempted = 0, simulated = true): SendResult {
  return { campaignId, attempted, sent: 0, failed: 0, simulated, haltedReason };
}

async function sendForCampaign(campaign: CampaignRow, dailyRemaining: number, cfg: Config): Promise<SendResult> {
  const window = sendingWindowStatus(new Date(), cfg);
  if (!window.ok) {
    logger.info('outside the sending window; nothing sent', {
      campaignId: campaign.id,
      reason: window.reason,
      localHour: window.localHour,
      weekday: window.weekday,
    });
    return emptyResult(campaign.id, window.reason);
  }

  if (dailyRemaining <= 0) return emptyResult(campaign.id, 'DAILY_CAP_REACHED');

  let state = campaign.state;

  // A batch review is a hard gate: the next batch only happens if the previous
  // one was healthy. An unhealthy campaign is HALTED, not slowed down.
  if (state === 'BATCH_1_REVIEW' || state === 'BATCH_2_REVIEW') {
    const health = await checkCampaignHealth(campaign.id);
    if (!health.healthy) {
      await setCampaignState(campaign.id, state, 'HALTED', `health check failed: ${health.reason}`, health.reason ?? 'UNHEALTHY');
      return emptyResult(campaign.id, `HALTED:${health.reason ?? 'UNHEALTHY'}`);
    }
    const next: CampaignState = state === 'BATCH_1_REVIEW' ? 'BATCH_2' : 'SCALING';
    await setCampaignState(campaign.id, state, next, 'batch health passed');
    state = next;
  }

  const target = cumulativeTargetForState(state, cfg);
  const alreadySent = await sentCountFor(campaign.id);
  if (alreadySent >= target) {
    const next = reviewStateAfter(state);
    if (next) await setCampaignState(campaign.id, state, next, `batch quota reached (${alreadySent}/${target})`);
    return emptyResult(campaign.id, next ? `BATCH_COMPLETE:${next}` : 'BATCH_QUOTA_REACHED');
  }

  // VOLUME IS EARNED. The lifecycle above says which batch we are in; this
  // says how much of it we have actually earned the right to send. One ramp
  // step is unlocked per healthy batch, and never more than one per run.
  await maybeAdvanceRamp(campaign.id);
  const earned = await getSendAllowance(campaign.id);
  if (earned.allowed <= 0) {
    logger.info('nothing earned yet for this campaign', {
      campaignId: campaign.id,
      reason: earned.reason,
      campaignCap: earned.campaignCap,
      domainCapToday: earned.domainCapToday,
      warmupDay: earned.warmupDay,
    });
    return emptyResult(campaign.id, earned.reason ?? 'NO_ALLOWANCE');
  }

  const allowance = Math.max(0, Math.min(target - alreadySent, dailyRemaining, earned.allowed));
  const rows = await loadSendableRows(campaign.id, allowance);

  // SHADOW MODE. The drafts stay exactly as they are, fully inspectable, and
  // the provider is never contacted. This is checked here as well as inside
  // src/lib/email so there are two independent stops, not one.
  if (isShadowMode(cfg)) {
    logger.info('SHADOW MODE: refusing to send', { campaignId: campaign.id, wouldSend: rows.length });
    return { campaignId: campaign.id, attempted: rows.length, sent: 0, failed: 0, simulated: true, haltedReason: 'SHADOW_MODE' };
  }

  if (rows.length === 0) return emptyResult(campaign.id, 'NOTHING_DUE');

  if (state === 'READY') {
    await setCampaignState(campaign.id, state, 'BATCH_1', 'first batch starting');
    state = 'BATCH_1';
    await startValidating(campaign.opportunity_id, campaign.id);
  }

  let sent = 0;
  let failed = 0;
  let sawRealSend = false;
  let haltedReason: string | null = null;

  for (const row of rows) {
    try {
      const { outcome, simulated } = await sendOneMessage(row, cfg);
      if (outcome === 'SENT') {
        sent += 1;
        if (!simulated) sawRealSend = true;
      } else if (outcome === 'FAILED') {
        failed += 1;
      }
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        haltedReason = 'EMAIL_DAILY_BUDGET';
        logger.warn('daily email budget reached mid-batch; stopping', { campaignId: campaign.id });
        break;
      }
      throw err;
    }
  }

  const totalSent = alreadySent + sent;
  if (totalSent >= target) {
    const next = reviewStateAfter(state);
    if (next) await setCampaignState(campaign.id, state, next, `batch complete (${totalSent}/${target})`);
  }

  return {
    campaignId: campaign.id,
    attempted: rows.length,
    sent,
    failed,
    simulated: !sawRealSend,
    haltedReason,
  };
}

/** First real batch means the opportunity is now being validated. */
async function startValidating(opportunityId: string, campaignId: string): Promise<void> {
  try {
    await transitionOpportunity({
      opportunityId,
      to: 'VALIDATING',
      actor: 'outreach:send_due_messages',
      reason: `campaign ${campaignId} started sending`,
    });
  } catch (err) {
    // The opportunity may already be VALIDATING, or another job may own it.
    // A failed bookkeeping transition must never stop or duplicate a send.
    logger.warn('could not move opportunity to VALIDATING', { opportunityId, err: String(err) });
  }
}

export async function sendDueMessages(): Promise<SendResult[]> {
  const cfg = getConfig();
  if (cfg.killSwitch) {
    logger.warn('KILL_SWITCH is on; not sending anything');
    return [];
  }

  // Domain reputation is judged BETWEEN batches, before anything else goes
  // out. A breach pauses the whole domain — this is control plane, and there
  // is no model, flag or caller that can wave it through.
  const deliverability = await evaluateDeliverability();
  if (deliverability.shouldPause) {
    logger.error('deliverability breach; sending is paused', { reason: deliverability.reason });
  }
  await resumeSendingIfRecovered();
  const pause = await isSendingPaused();
  if (pause.paused) {
    logger.warn('sending is paused', { until: pause.until?.toISOString(), reason: pause.reason });
    return [];
  }

  const placeholders = SENDABLE_STATES.map((_, i) => `$${i + 1}`).join(',');
  const campaigns = await many<CampaignRow>(
    `SELECT id, opportunity_id, state, landing_slug
       FROM campaigns
      WHERE state IN (${placeholders})
      ORDER BY created_at ASC`,
    [...SENDABLE_STATES],
  );

  const results: SendResult[] = [];
  let dailyRemaining = await remainingDailyEmailQuota();

  for (const campaign of campaigns) {
    const result = await sendForCampaign(campaign, dailyRemaining, cfg);
    dailyRemaining = Math.max(0, dailyRemaining - result.sent);
    results.push(result);
  }
  return results;
}

/**
 * Sends auto-reply drafts that could not go out at the moment they were
 * written — shadow mode, outside the sending window, or the daily cap was
 * already reached.
 *
 * Auto-replies are deliberately excluded from `sendDueMessages`, because an
 * answer to someone who wrote to US is not cold outreach and must not consume
 * a campaign's batch quota. That left them with nothing to flush them, so a
 * reply drafted at 6pm would simply never be sent. This closes that gap while
 * keeping them off the campaign budget; every other rule (window, daily cap,
 * suppression, shadow mode) is still enforced by sendDraftedMessageNow.
 */
export async function flushPendingAutoReplies(limit = 25): Promise<{
  attempted: number;
  sent: number;
  skipped: number;
}> {
  const cfg = getConfig();
  if (cfg.killSwitch || isShadowMode(cfg)) return { attempted: 0, sent: 0, skipped: 0 };
  if ((await isSendingPaused()).paused) return { attempted: 0, sent: 0, skipped: 0 };

  const rows = await many<{ id: string }>(
    `SELECT id FROM messages
      WHERE direction = 'OUTBOUND'
        AND status = 'DRAFTED'
        AND sequence_step < 0
      ORDER BY created_at ASC
      LIMIT $1`,
    [limit],
  );

  let sent = 0;
  let skipped = 0;
  for (const row of rows) {
    const outcome = await sendDraftedMessageNow(row.id);
    if (outcome.sent) {
      sent += 1;
    } else {
      skipped += 1;
      // A cap or closed window is not an error — the next run picks it up.
      if (outcome.reason === 'DAILY_CAP_REACHED' || outcome.reason === 'EMAIL_DAILY_BUDGET') break;
    }
  }
  return { attempted: rows.length, sent, skipped };
}

/**
 * Sends a single already-drafted message (used by the auto-reply path).
 * Subject to the identical rules: window, daily cap, suppression, shadow mode.
 */
export async function sendDraftedMessageNow(messageId: string): Promise<{ sent: boolean; reason: string | null }> {
  const cfg = getConfig();
  if (cfg.killSwitch) return { sent: false, reason: 'KILL_SWITCH' };
  if (isShadowMode(cfg)) return { sent: false, reason: 'SHADOW_MODE' };

  const window = sendingWindowStatus(new Date(), cfg);
  if (!window.ok) return { sent: false, reason: window.reason };

  // A paused domain sends nothing at all — not even a reply to someone who
  // wrote to us. Reputation damage is not selective.
  const pause = await isSendingPaused();
  if (pause.paused) return { sent: false, reason: `DELIVERABILITY_PAUSED:${pause.reason ?? 'UNKNOWN'}` };

  if ((await remainingDailyEmailQuota()) <= 0) return { sent: false, reason: 'DAILY_CAP_REACHED' };

  const row = await one<SendableRow>(
    `SELECT ${SENDABLE_COLUMNS}
       FROM messages m
       LEFT JOIN prospects p ON p.id = m.prospect_id
      WHERE m.id = $1 AND m.direction = 'OUTBOUND' AND m.status = 'DRAFTED'`,
    [messageId],
  );
  if (!row) return { sent: false, reason: 'NOT_DRAFTED' };

  try {
    const { outcome } = await sendOneMessage(row, cfg);
    return { sent: outcome === 'SENT', reason: outcome === 'SENT' ? null : outcome };
  } catch (err) {
    if (err instanceof BudgetExceededError) return { sent: false, reason: 'EMAIL_DAILY_BUDGET' };
    throw err;
  }
}
