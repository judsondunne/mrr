/**
 * Campaign send health — the SINGLE definition of "is this campaign damaging
 * inboxes?".
 *
 * It lives in lib/ rather than in a pipeline layer because two layers need it
 * and they must never disagree: the outreach layer gates batch progression on
 * it, and the validation layer kills a campaign early on it. They previously
 * had separate implementations that divided by different denominators and used
 * different boundary operators, so a borderline campaign could be halted by one
 * and passed by the other.
 *
 * Semantics here follow the spec literally: "hard bounce rate < 5%" means >= 5%
 * is unhealthy.
 *
 * Batch 1 (25) is a probe. We only earn the right to send batch 2 (50), and
 * then the rest (up to 150), by proving the previous batch did not damage
 * anyone's inbox or our sending reputation.
 *
 * Deterministic SQL only. No model, no score, no judgement call.
 */
import { getConfig } from './config';
import { one, toNumber } from './db';

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

  // Collect every breach rather than returning on the first: the operator
  // reading a halted campaign wants the whole picture, not one symptom.
  const reasons: string[] = [];
  if (hardBounceRate >= cfg.health.maxHardBounceRate) {
    reasons.push(
      `hard bounce rate ${pct(hardBounceRate)} (${hardBounced}/${sent}) reaches the ${pct(cfg.health.maxHardBounceRate)} ceiling`,
    );
  }
  if (complaintRate > cfg.health.maxComplaintRate) {
    reasons.push(
      `complaint rate ${pct(complaintRate)} (${complained}/${delivered}) exceeds the ${pct(cfg.health.maxComplaintRate)} ceiling`,
    );
  }
  if (unsubscribeRate > cfg.health.maxUnsubscribeRate) {
    reasons.push(
      `unsubscribe rate ${pct(unsubscribeRate)} (${unsubscribed}/${delivered}) exceeds the ${pct(cfg.health.maxUnsubscribeRate)} ceiling`,
    );
  }
  if (infrastructureFailureRate > MAX_INFRASTRUCTURE_FAILURE_RATE) {
    reasons.push(
      `infrastructure failures ${pct(infrastructureFailureRate)} (${infraFailed}/${sent + infraFailed}) exceed the ${pct(MAX_INFRASTRUCTURE_FAILURE_RATE)} ceiling`,
    );
  }

  if (reasons.length === 0) return verdict;
  return { ...verdict, healthy: false, reason: reasons.join('; ') };
}

/**
 * A send failing repeatedly is our problem, not the recipient's. Above this
 * share of attempts we stop rather than keep hammering the provider.
 */
const MAX_INFRASTRUCTURE_FAILURE_RATE = 0.2;

function pct(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}
