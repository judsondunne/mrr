/**
 * Follow-ups.
 *
 * The entire sequence is: initial, follow-up 1, follow-up 2, stop. There is a
 * hard code ceiling of two follow-ups that MAX_FOLLOWUPS can lower but cannot
 * raise — a configuration mistake must not turn this into a pestering machine.
 *
 * A prospect drops out of the sequence the moment they reply, bounce, commit,
 * complain, or land on the suppression list.
 */
import { getConfig } from '../../lib/config';
import { many } from '../../lib/db';
import { createLogger } from '../../lib/logger';
import { assertCompliant, composeFollowupMessage } from './compose';
import { ComplianceError } from './errors';
import { idempotencyKeyFor, insertDraftMessage, prospectContextFromRow, type ProspectRow } from './drafts';
import { offerFromRow, type OfferContext } from './offer';
import { isCountryAllowed } from './suppression';

const logger = createLogger('outreach:followups');

/** Absolute ceiling. MAX_FOLLOWUPS may lower this; nothing may raise it. */
export const MAX_SEQUENCE_FOLLOWUPS = 2;

interface EligibleRow extends ProspectRow {
  initial_id: string;
  campaign_id: string;
  thread_id: string | null;
  opportunity_id: string;
  landing_slug: string;
  price_monthly: string | number;
  landing_copy_json: unknown;
}

export function delayDaysForStep(step: number, cfg: { followup1DelayDays: number; followup2DelayDays: number }): number {
  return step === 1 ? cfg.followup1DelayDays : cfg.followup2DelayDays;
}

/**
 * Everything that has to be true before another email is allowed. Expressed as
 * SQL so it is one atomic read rather than a sequence of racy checks.
 */
async function findEligible(step: number, delayDays: number): Promise<EligibleRow[]> {
  return many<EligibleRow>(
    `SELECT m.id AS initial_id, m.campaign_id, m.thread_id,
            p.id, p.company_name, p.domain, p.contact_email, p.contact_name_if_public,
            p.public_evidence_url, p.qualification_reason, p.country, p.status,
            c.opportunity_id, c.landing_slug, c.price_monthly, c.landing_copy_json
       FROM messages m
       JOIN prospects p ON p.id = m.prospect_id
       JOIN campaigns c ON c.id = m.campaign_id
      WHERE m.direction = 'OUTBOUND'
        AND m.sequence_step = 0
        AND m.delivered_at IS NOT NULL
        AND m.bounced_at IS NULL
        AND m.complained_at IS NULL
        AND m.delivered_at <= now() - ($1::int * interval '1 day')
        AND p.status NOT IN ('SUPPRESSED','BOUNCED','COMMITTED','REPLIED','DISQUALIFIED')
        AND p.suppressed_at IS NULL
        AND p.contact_email IS NOT NULL
        AND c.state NOT IN ('HALTED','FAILED','COMPLETE','DRAFT')
        AND NOT EXISTS (
              SELECT 1 FROM messages r
               WHERE r.prospect_id = p.id AND r.direction = 'INBOUND')
        AND NOT EXISTS (
              SELECT 1 FROM messages f
               WHERE f.campaign_id = c.id AND f.prospect_id = p.id AND f.sequence_step = $2)
        AND NOT EXISTS (
              SELECT 1 FROM commitments cm WHERE cm.prospect_id = p.id)
        AND NOT EXISTS (
              SELECT 1 FROM suppression_list s
               WHERE (s.email IS NOT NULL AND s.email = lower(p.contact_email))
                  OR (s.domain IS NOT NULL AND s.domain = lower(p.domain)))
        AND ($2 = 1 OR EXISTS (
              SELECT 1 FROM messages prev
               WHERE prev.campaign_id = c.id AND prev.prospect_id = p.id
                 AND prev.sequence_step = $2 - 1
                 AND prev.sent_at IS NOT NULL
                 AND prev.status IN ('SENT','DELIVERED')))
      ORDER BY m.delivered_at ASC
      LIMIT 500`,
    [delayDays, step],
  );
}

function offerFor(row: EligibleRow): OfferContext | null {
  return offerFromRow({
    id: row.campaign_id,
    opportunity_id: row.opportunity_id,
    landing_slug: row.landing_slug,
    price_monthly: row.price_monthly,
    landing_copy_json: row.landing_copy_json,
  });
}

/**
 * Drafts (never sends) the follow-ups that are due. Idempotent: the unique
 * idempotency key means a second run in the same window drafts nothing.
 */
export async function scheduleFollowups(): Promise<{ queued: number }> {
  const cfg = getConfig();
  const maxFollowups = Math.min(cfg.maxFollowups, MAX_SEQUENCE_FOLLOWUPS);
  if (maxFollowups <= 0) return { queued: 0 };

  let queued = 0;
  for (let step = 1; step <= maxFollowups; step += 1) {
    const delayDays = delayDaysForStep(step, cfg);
    const rows = await findEligible(step, delayDays);

    for (const row of rows) {
      const prospect = prospectContextFromRow(row);
      if (!prospect) continue;
      if (!isCountryAllowed(row.country, cfg.allowedOutreachCountries)) continue;

      const offer = offerFor(row);
      if (!offer) {
        logger.warn('campaign has unusable landing copy; not following up', { campaignId: row.campaign_id });
        continue;
      }

      const message = composeFollowupMessage(step === 1 ? 1 : 2, prospect, offer);
      try {
        assertCompliant(message, cfg);
      } catch (err) {
        if (err instanceof ComplianceError) {
          logger.error('follow-up failed compliance; not drafted', {
            prospectId: prospect.id,
            violations: err.violations,
          });
          continue;
        }
        throw err;
      }

      const id = await insertDraftMessage({
        campaignId: row.campaign_id,
        prospectId: prospect.id,
        step,
        message,
        idempotencyKey: idempotencyKeyFor(row.campaign_id, prospect.id, step),
        threadId: row.thread_id ?? row.initial_id,
      });
      if (id) queued += 1;
    }
  }

  if (queued > 0) logger.info('follow-ups queued', { queued });
  return { queued };
}
