/**
 * PUBLIC API — OWNER NOTIFICATION LAYER. Owned by the validation agent.
 *
 * The owner hears from this system for exactly six reasons and no others:
 * one validated opportunity, and five ways the machine broke.
 *
 * There is deliberately no function for "found a promising idea", "research
 * complete", "campaign started", "50 emails sent" or "10 people replied". That
 * is what the logs and the dashboard are for. If you are about to add one,
 * don't: an owner who gets progress emails stops reading the one that matters.
 */
import { getConfig } from '../../lib/config';
import { getDb } from '../../lib/db';
import { newId } from '../../lib/hash';
import { createLogger, errorToFields } from '../../lib/logger';
import { recordAudit } from '../../lib/audit';
import { sendEmail } from '../../lib/email/index';
import type { NotificationKind } from '../../lib/contracts';
import { renderReadyToBuildEmail } from './render';
import { assertNoGuaranteeLanguage } from './claims';

const logger = createLogger('notify');
const ACTOR = 'notify_validated_opportunities';

export { renderReadyToBuildEmail } from './render';
export {
  assertNoGuaranteeLanguage,
  containsClaimLanguage,
  findClaimLanguage,
  FORBIDDEN_CLAIM_PATTERNS,
} from './claims';

export function readyToBuildDedupeKey(opportunityId: string): string {
  return `READY_TO_BUILD:${opportunityId}`;
}

interface NotificationRow {
  id: string;
  sent_at: string | Date | null;
}

/**
 * Claims the right to send exactly one notification for `dedupeKey`.
 *
 * The unique index on owner_notifications.dedupe_key is the lock: two
 * concurrent jobs cannot both win the insert. A claimed-but-unsent row is
 * retried on the next run, so a transport failure never loses the alert.
 */
async function claimNotification(params: {
  kind: NotificationKind;
  subject: string;
  body: string;
  dedupeKey: string;
  detail: Record<string, unknown>;
}): Promise<{ id: string; alreadySent: boolean }> {
  const db = await getDb();
  const id = newId('own');
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO owner_notifications (id, kind, subject, body, dedupe_key, detail_json)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [id, params.kind, params.subject, params.body, params.dedupeKey, JSON.stringify(params.detail)],
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id, alreadySent: false };

  const existing = await db.query<NotificationRow>(
    'SELECT id, sent_at FROM owner_notifications WHERE dedupe_key = $1',
    [params.dedupeKey],
  );
  const row = existing.rows[0];
  if (!row) return { id, alreadySent: true };
  return { id: row.id, alreadySent: row.sent_at !== null };
}

/** Cheap pre-check so an already-notified opportunity is not re-rendered. */
async function alreadySent(dedupeKey: string): Promise<boolean> {
  const db = await getDb();
  const res = await db.query<NotificationRow>(
    'SELECT id, sent_at FROM owner_notifications WHERE dedupe_key = $1',
    [dedupeKey],
  );
  const row = res.rows[0];
  return row !== undefined && row.sent_at !== null;
}

async function markSent(id: string): Promise<void> {
  const db = await getDb();
  await db.query('UPDATE owner_notifications SET sent_at = now() WHERE id = $1', [id]);
}

async function updateContent(id: string, subject: string, body: string): Promise<void> {
  const db = await getDb();
  await db.query('UPDATE owner_notifications SET subject = $2, body = $3 WHERE id = $1', [
    id,
    subject,
    body,
  ]);
}

/**
 * Sends the ONE routine email this system produces: a specific product, a
 * specific price, and the real businesses that said they will pay it.
 *
 * Idempotent: the dedupe key is the opportunity, so re-running notifies nobody
 * a second time.
 */
export async function notifyValidatedOpportunities(): Promise<{ sent: number }> {
  const cfg = getConfig();
  const db = await getDb();
  const res = await db.query<{ id: string; name: string }>(
    `SELECT id, name FROM opportunities WHERE state = 'READY_TO_BUILD' ORDER BY updated_at ASC, id ASC`,
  );

  let sent = 0;
  for (const opportunity of res.rows) {
    const dedupeKey = readyToBuildDedupeKey(opportunity.id);
    try {
      if (await alreadySent(dedupeKey)) {
        logger.debug('owner already notified for this opportunity', { opportunityId: opportunity.id });
        continue;
      }
      const { subject, body } = await renderReadyToBuildEmail(opportunity.id);
      assertNoGuaranteeLanguage(body, `READY_TO_BUILD email for ${opportunity.id}`);

      const claim = await claimNotification({
        kind: 'READY_TO_BUILD',
        subject,
        body,
        dedupeKey,
        detail: { opportunityId: opportunity.id },
      });
      if (claim.alreadySent) {
        logger.debug('owner already notified for this opportunity', { opportunityId: opportunity.id });
        continue;
      }
      await updateContent(claim.id, subject, body);

      if (!cfg.ownerNotificationEmail) {
        logger.warn('OWNER_NOTIFICATION_EMAIL is not set; validated opportunity stored, not emailed', {
          opportunityId: opportunity.id,
          notificationId: claim.id,
        });
        continue;
      }

      await sendEmail({ to: cfg.ownerNotificationEmail, subject, text: body });
      await markSent(claim.id);
      sent += 1;

      await recordAudit({
        entityType: 'opportunity',
        entityId: opportunity.id,
        eventType: 'DECISION',
        actor: ACTOR,
        reason: 'owner notified of validated opportunity',
        detail: { notificationId: claim.id, dedupeKey },
      });
      logger.info('owner notified of validated opportunity', { opportunityId: opportunity.id });
    } catch (err) {
      logger.error('failed to notify owner of validated opportunity', {
        opportunityId: opportunity.id,
        ...errorToFields(err),
      });
      await recordAudit({
        entityType: 'opportunity',
        entityId: opportunity.id,
        eventType: 'ERROR',
        actor: ACTOR,
        reason: 'owner notification failed',
        detail: errorToFields(err),
      });
    }
  }

  return { sent };
}

/**
 * The only other alerts that exist: the machine cannot run, or is doing
 * something it must not. Deduped by key so a repeated failure produces ONE
 * actionable alert instead of a stream.
 */
export async function notifyOwner(params: {
  kind: Exclude<NotificationKind, 'READY_TO_BUILD'>;
  subject: string;
  body: string;
  dedupeKey: string;
  detail?: Record<string, unknown>;
}): Promise<{ sent: boolean; deduped: boolean }> {
  const cfg = getConfig();
  assertNoGuaranteeLanguage(params.body, `${params.kind} alert`);

  const claim = await claimNotification({
    kind: params.kind,
    subject: params.subject,
    body: params.body,
    dedupeKey: params.dedupeKey,
    detail: params.detail ?? {},
  });
  if (claim.alreadySent) {
    logger.debug('owner alert deduped', { kind: params.kind, dedupeKey: params.dedupeKey });
    return { sent: false, deduped: true };
  }

  if (!cfg.ownerNotificationEmail) {
    logger.warn('OWNER_NOTIFICATION_EMAIL is not set; alert stored, not emailed', {
      kind: params.kind,
      dedupeKey: params.dedupeKey,
    });
    return { sent: false, deduped: false };
  }

  try {
    await sendEmail({ to: cfg.ownerNotificationEmail, subject: params.subject, text: params.body });
    await markSent(claim.id);
    await recordAudit({
      entityType: 'system',
      entityId: null,
      eventType: 'DECISION',
      actor: 'notify_owner',
      reason: `owner alerted: ${params.kind}`,
      detail: { dedupeKey: params.dedupeKey },
    });
    return { sent: true, deduped: false };
  } catch (err) {
    logger.error('owner alert failed to send', { kind: params.kind, ...errorToFields(err) });
    return { sent: false, deduped: false };
  }
}

/** Every notification the owner has been sent. Used by the dashboard. */
export async function listOwnerNotifications(limit = 50): Promise<
  Array<{ id: string; kind: string; subject: string; sentAt: string | null; createdAt: string }>
> {
  const db = await getDb();
  const res = await db.query<{
    id: string;
    kind: string;
    subject: string;
    sent_at: string | Date | null;
    created_at: string | Date;
  }>(
    `SELECT id, kind, subject, sent_at, created_at FROM owner_notifications
      ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return res.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    subject: row.subject,
    sentAt: row.sent_at ? (row.sent_at instanceof Date ? row.sent_at.toISOString() : String(row.sent_at)) : null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }));
}
