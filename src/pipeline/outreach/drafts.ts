/**
 * Draft rows.
 *
 * Every outbound email exists as a `messages` row with status='DRAFTED' before
 * anything is sent, which is what makes shadow mode useful: the drafts are
 * complete, inspectable, and byte-identical to what would have gone out.
 *
 * The deterministic idempotency key is the spine of the whole no-duplicate
 * guarantee — it is a UNIQUE index in the schema, so a second attempt to draft
 * the same (campaign, prospect, step) is a database-level no-op.
 */
import { getDb } from '../../lib/db';
import { newId } from '../../lib/hash';
import type { ComposedMessage, ProspectContext } from './compose';

export interface ProspectRow {
  id: string;
  company_name: string;
  domain: string;
  contact_email: string | null;
  contact_name_if_public: string | null;
  public_evidence_url: string | null;
  qualification_reason: string | null;
  country: string | null;
  status: string;
}

/** Deterministic. Two scheduler runs compute the same key for the same email. */
export function idempotencyKeyFor(campaignId: string, prospectId: string, step: number): string {
  return `${campaignId}:${prospectId}:${step}`;
}

export function autoReplyIdempotencyKey(inboundMessageId: string): string {
  return `autoreply:${inboundMessageId}`;
}

export function prospectContextFromRow(row: ProspectRow): ProspectContext | null {
  if (!row.contact_email || row.contact_email.trim() === '') return null;
  return {
    id: row.id,
    companyName: row.company_name,
    domain: row.domain,
    contactEmail: row.contact_email,
    contactName: row.contact_name_if_public,
    publicEvidenceUrl: row.public_evidence_url,
    qualificationReason: row.qualification_reason,
  };
}

export interface DraftParams {
  campaignId: string;
  prospectId: string | null;
  step: number;
  message: ComposedMessage;
  idempotencyKey: string;
  threadId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
}

/**
 * Inserts a DRAFTED outbound row. Returns null when an identical draft already
 * existed (ON CONFLICT on the unique idempotency key), which is what makes
 * prepareCampaigns / scheduleFollowups safe to run repeatedly.
 */
export async function insertDraftMessage(params: DraftParams): Promise<string | null> {
  const db = await getDb();
  const id = newId('msg');
  const metadata = {
    headers: params.message.headers,
    unsubscribeUrl: params.message.unsubscribeUrl,
    inReplyTo: params.inReplyTo ?? null,
    references: params.references ?? null,
  };
  const res = await db.query<{ id: string }>(
    `INSERT INTO messages
       (id, campaign_id, prospect_id, direction, sequence_step, subject, body,
        status, idempotency_key, thread_id, raw_provider_metadata_json)
     VALUES ($1,$2,$3,'OUTBOUND',$4,$5,$6,'DRAFTED',$7,$8,$9)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      id,
      params.campaignId,
      params.prospectId,
      params.step,
      params.message.subject,
      params.message.text,
      params.idempotencyKey,
      params.threadId ?? id,
      JSON.stringify(metadata),
    ],
  );
  return res.rows[0]?.id ?? null;
}
