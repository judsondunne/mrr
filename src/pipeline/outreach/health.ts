/**
 * Campaign send health.
 *
 * Batch 1 (25) is a probe. We only earn the right to send batch 2 (50), and
 * then the rest (up to 150), by proving the previous batch did not damage
 * anyone's inbox or our sending reputation.
 *
 * Deterministic SQL only. No model, no score, no judgement call.
 */
import { getConfig } from '../../lib/config.js';
import { one, toNumber } from '../../lib/db.js';

export interface HealthVerdict {
  healthy: boolean;
  reason: string | null;
  sent: number;
  delivered: number;
  hardBounceRate: number;
  complaintRate: number;
  unsubscribeRate: number;
  infrastructureFailureRate: number;
}

/** Statuses that mean the provider accepted the message. */
const ATTEMPTED_STATUSES = "('SENT','DELIVERED','BOUNCED','COMPLAINED')";

export async function checkCampaignHealth(campaignId: string): Promise<HealthVerdict> {
  const cfg = getConfig();
  const row = await one<{
    sent: string | number;
    delivered: string | number;
    hard_bounced: string | number;
    complained: string | number;
    infra_failed: string | number;
  }>(
    `SELECT
        COUNT(*) FILTER (WHERE status IN ${ATTEMPTED_STATUSES})                      AS sent,
        COUNT(*) FILTER (WHERE delivered_at IS NOT NULL)                             AS delivered,
        COUNT(*) FILTER (WHERE bounce_type = 'HARD')                                 AS hard_bounced,
        COUNT(*) FILTER (WHERE complained_at IS NOT NULL)                            AS complained,
        COUNT(*) FILTER (WHERE status = 'FAILED' AND COALESCE(error,'') NOT LIKE 'SKIPPED:%') AS infra_failed
       FROM messages
      WHERE campaign_id = $1 AND direction = 'OUTBOUND'`,
    [campaignId],
  );

  const sent = toNumber(row?.sent);
  const delivered = toNumber(row?.delivered);
  const hardBounced = toNumber(row?.hard_bounced);
  const complained = toNumber(row?.complained);
  const infraFailed = toNumber(row?.infra_failed);

  const unsubRow = await one<{ n: string | number }>(
    `SELECT COUNT(DISTINCT s.id) AS n
       FROM suppression_list s
       JOIN prospects p
         ON (s.email IS NOT NULL AND s.email = lower(p.contact_email))
         OR (s.domain IS NOT NULL AND s.domain = lower(p.domain))
      WHERE s.reason IN ('UNSUBSCRIBE','EXPLICIT_STOP')
        AND p.id IN (
          SELECT prospect_id FROM messages
           WHERE campaign_id = $1 AND direction = 'OUTBOUND' AND prospect_id IS NOT NULL
        )`,
    [campaignId],
  );
  const unsubscribed = toNumber(unsubRow?.n);

  const sentBase = Math.max(sent, 1);
  const deliveredBase = Math.max(delivered, 1);
  const hardBounceRate = hardBounced / sentBase;
  const complaintRate = complained / deliveredBase;
  const unsubscribeRate = unsubscribed / deliveredBase;
  const infrastructureFailureRate = infraFailed / Math.max(sent + infraFailed, 1);

  const verdict: HealthVerdict = {
    healthy: true,
    reason: null,
    sent,
    delivered,
    hardBounceRate,
    complaintRate,
    unsubscribeRate,
    infrastructureFailureRate,
  };

  // Nothing has been sent yet — there is nothing to judge, and refusing here
  // would deadlock the campaign.
  if (sent === 0) return verdict;

  if (hardBounceRate >= cfg.health.maxHardBounceRate) {
    return { ...verdict, healthy: false, reason: `HARD_BOUNCE_RATE ${pct(hardBounceRate)} >= ${pct(cfg.health.maxHardBounceRate)}` };
  }
  if (complaintRate > cfg.health.maxComplaintRate) {
    return { ...verdict, healthy: false, reason: `COMPLAINT_RATE ${pct(complaintRate)} > ${pct(cfg.health.maxComplaintRate)}` };
  }
  if (unsubscribeRate > cfg.health.maxUnsubscribeRate) {
    return { ...verdict, healthy: false, reason: `UNSUBSCRIBE_RATE ${pct(unsubscribeRate)} > ${pct(cfg.health.maxUnsubscribeRate)}` };
  }
  if (infrastructureFailureRate > 0.2) {
    return { ...verdict, healthy: false, reason: `INFRASTRUCTURE_FAILURES ${pct(infrastructureFailureRate)}` };
  }
  return verdict;
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}
