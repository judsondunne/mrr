/**
 * PUBLIC API — DELIVERABILITY ENGINE. Owned by the outreach agent.
 *
 * Volume is EARNED. A new sending domain does not get 75/day on day one, and
 * a campaign does not jump to 150. Crossing a bounce/complaint ceiling pauses
 * sending with no AI override.
 *
 * Two independent earned budgets, and the send path takes the MINIMUM:
 *
 *   1. PER CAMPAIGN — `campaigns.ramp_step` indexes `config.deliverability
 *      .rampSteps` (10, 25, 50, 75). A step is advanced exactly one at a time,
 *      and only after the previous batch came back healthy from the single
 *      canonical `checkCampaignHealth`. Campaign LIFECYCLE still lives in
 *      `campaigns.state`; this is purely VOLUME.
 *   2. PER DOMAIN — `sending_reputation.first_send_at` gives the warm-up day,
 *      and `config.deliverability.warmupSchedule` gives today's ceiling for the
 *      whole sending domain. A brand-new domain sends 10/day, not 75.
 *
 * And one hard stop: crossing the hard-bounce or complaint ceiling writes
 * `sending_reputation.paused_until`. This is CONTROL PLANE. There is
 * deliberately no `unpause()`, no override flag and no model in the loop; the
 * only way back is `resumeSendingIfRecovered()`, which needs BOTH the cooldown
 * to have elapsed AND the measured metrics to be healthy again.
 */
import { getConfig, type Config } from '../lib/config';
import { getDb, one, toNumber } from '../lib/db';
import { getBudgetSnapshot } from '../lib/cost';
import { recordAudit } from '../lib/audit';
import { createLogger } from '../lib/logger';
import { checkCampaignHealth } from '../lib/campaign-health';

const logger = createLogger('autonomy:deliverability');

export interface SendAllowance {
  /** How many emails may be sent right now, across everything. */
  allowed: number;
  domainCapToday: number;
  campaignCap: number;
  warmupDay: number;
  reason: string | null;
}

const MS_PER_DAY = 86_400_000;

/**
 * Reputation is measured over a rolling window rather than over all time, so a
 * domain that was paused can actually recover by sending clean volume. The
 * cooldown is what prevents an early resume; the window is what prevents a
 * permanent one.
 */
const REPUTATION_WINDOW_DAYS = 7;

/** Statuses that mean the provider accepted the message. Matches campaign-health. */
const ATTEMPTED_STATUSES = "('SENDING','SENT','DELIVERED','BOUNCED','COMPLAINED')";

interface ReputationRow {
  domain: string | null;
  first_send_at: string | Date | null;
  warmup_day: number | string;
  paused_until: string | Date | null;
  pause_reason: string | null;
}

async function readReputation(): Promise<ReputationRow | null> {
  return one<ReputationRow>(
    `SELECT domain, first_send_at, warmup_day, paused_until, pause_reason
       FROM sending_reputation WHERE id = 1`,
  );
}

function asDate(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(d.getTime()) ? d : null;
}

/** Day 1 is the day of the first send. No first send yet is also day 1. */
export function warmupDayFor(firstSendAt: string | Date | null, now: Date = new Date()): number {
  const first = asDate(firstSendAt);
  if (!first) return 1;
  const elapsed = now.getTime() - first.getTime();
  if (elapsed < 0) return 1;
  return Math.floor(elapsed / MS_PER_DAY) + 1;
}

/**
 * Today's ceiling for the sending DOMAIN. Past the end of the schedule the
 * normal daily cap applies — the warm-up may only ever be more restrictive
 * than MAX_EMAILS_PER_DAY, never less.
 */
export function warmupCapFor(warmupDay: number, cfg: Config = getConfig()): number {
  for (const step of cfg.deliverability.warmupSchedule) {
    if (warmupDay <= step.throughDay) return Math.max(0, Math.min(step.maxPerDay, cfg.maxEmailsPerDay));
  }
  return cfg.maxEmailsPerDay;
}

/** Cumulative ceiling for a campaign's current ramp step (10/25/50/75...). */
export function campaignRampCap(rampStep: number): number {
  const cfg = getConfig();
  const steps = cfg.deliverability.rampSteps;
  if (steps.length === 0) return cfg.maxEmailsPerCampaign;
  const index = Math.min(Math.max(0, Math.floor(rampStep)), steps.length - 1);
  const cap = steps[index] ?? steps[steps.length - 1] ?? cfg.maxEmailsPerCampaign;
  // A ramp step may never exceed the campaign ceiling the control plane set.
  return Math.max(0, Math.min(cap, cfg.maxEmailsPerCampaign));
}

/**
 * The most a single campaign can EVER attempt.
 *
 * The ramp's final step is a hard ceiling — `maybeAdvanceRamp` reports
 * RAMP_AT_MAX and stops — so when the last configured step is below
 * MAX_EMAILS_PER_CAMPAIGN, that step is the real limit, not the config value.
 *
 * Anything that asks "has this campaign spent its allowance?" must compare
 * against THIS number. Comparing against MAX_EMAILS_PER_CAMPAIGN livelocked a
 * campaign: the SCALING lifecycle target and the exhaustion kill both waited
 * for 150 delivered while the ramp refused to let more than 75 be attempted,
 * so an inconclusive campaign never completed, never failed, and held one of
 * the MAX_ACTIVE_VALIDATIONS slots permanently. Two of those and the system
 * stops starting experiments for good.
 *
 * This raises no sending limit. It only lets "exhausted" mean what it can.
 */
export function campaignVolumeCeiling(cfg: Config = getConfig()): number {
  const steps = cfg.deliverability.rampSteps;
  if (steps.length === 0) return cfg.maxEmailsPerCampaign;
  const lastStepCap = campaignRampCap(steps.length - 1);
  return Math.max(0, Math.min(cfg.maxEmailsPerCampaign, lastStepCap));
}

/** Domain-level warm-up ceiling for today. */
export async function domainDailyCap(): Promise<{ cap: number; warmupDay: number }> {
  const row = await readReputation();
  const warmupDay = warmupDayFor(row?.first_send_at ?? null);
  return { cap: warmupCapFor(warmupDay), warmupDay };
}

/**
 * Called the first time anything is actually handed to the provider. Starts
 * the warm-up clock; idempotent, because `first_send_at` is only ever set when
 * it is still null.
 */
export async function recordFirstSend(): Promise<void> {
  const cfg = getConfig();
  const db = await getDb();
  await db.query(
    `INSERT INTO sending_reputation (id, domain, first_send_at, warmup_day, updated_at)
     VALUES (1, $1, now(), 1, now())
     ON CONFLICT (id) DO UPDATE
        SET domain        = COALESCE(sending_reputation.domain, EXCLUDED.domain),
            first_send_at = COALESCE(sending_reputation.first_send_at, EXCLUDED.first_send_at),
            updated_at    = now()`,
    [cfg.sendingDomain === '' ? null : cfg.sendingDomain],
  );
  const row = await readReputation();
  const warmupDay = warmupDayFor(row?.first_send_at ?? null);
  if (toNumber(row?.warmup_day) !== warmupDay) {
    await db.query('UPDATE sending_reputation SET warmup_day = $1, updated_at = now() WHERE id = 1', [warmupDay]);
  }
}

/** True while the control plane has sending stopped. */
export async function isSendingPaused(now: Date = new Date()): Promise<{ paused: boolean; until: Date | null; reason: string | null }> {
  const row = await readReputation();
  const until = asDate(row?.paused_until ?? null);
  if (!until || until.getTime() <= now.getTime()) return { paused: false, until, reason: row?.pause_reason ?? null };
  return { paused: true, until, reason: row?.pause_reason ?? 'PAUSED' };
}

/** Everything handed to, or possibly handed to, the provider for one campaign. */
export async function campaignAttemptedCount(campaignId: string): Promise<number> {
  const row = await one<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM messages
      WHERE campaign_id = $1 AND direction = 'OUTBOUND' AND status IN ${ATTEMPTED_STATUSES}`,
    [campaignId],
  );
  return toNumber(row?.n);
}

/**
 * The single place that decides how much may go out right now. The answer is
 * the MINIMUM of every independent limit, so adding a limit can only ever make
 * the system quieter.
 */
export async function getSendAllowance(campaignId: string): Promise<SendAllowance> {
  const cfg = getConfig();
  const { cap: domainCapToday, warmupDay } = await domainDailyCap();

  const campaign = await one<{ ramp_step: number | string }>(
    'SELECT ramp_step FROM campaigns WHERE id = $1',
    [campaignId],
  );
  if (!campaign) {
    return { allowed: 0, domainCapToday, campaignCap: 0, warmupDay, reason: 'CAMPAIGN_NOT_FOUND' };
  }

  const campaignCap = campaignRampCap(toNumber(campaign.ramp_step));
  const attempted = await campaignAttemptedCount(campaignId);
  const snapshot = await getBudgetSnapshot();

  const limits: Array<{ reason: string; remaining: number }> = [
    { reason: 'CAMPAIGN_RAMP', remaining: campaignCap - attempted },
    { reason: 'DOMAIN_WARMUP', remaining: domainCapToday - snapshot.emailsSentToday },
    { reason: 'DAILY_QUOTA', remaining: snapshot.maxEmailsPerDay - snapshot.emailsSentToday },
    { reason: 'CAMPAIGN_MAX', remaining: cfg.maxEmailsPerCampaign - attempted },
  ];

  let binding = limits[0]!;
  for (const limit of limits) if (limit.remaining < binding.remaining) binding = limit;
  const allowed = Math.max(0, binding.remaining);

  const pause = await isSendingPaused();
  if (pause.paused) {
    return {
      allowed: 0,
      domainCapToday,
      campaignCap,
      warmupDay,
      reason: `DELIVERABILITY_PAUSED:${pause.reason ?? 'UNKNOWN'}`,
    };
  }

  return { allowed, domainCapToday, campaignCap, warmupDay, reason: binding.reason };
}

// --- reputation measurement ---------------------------------------------------

export interface DeliverabilityVerdict {
  healthy: boolean;
  reason: string | null;
  shouldPause: boolean;
}

export interface ReputationMetrics {
  sent: number;
  delivered: number;
  hardBounced: number;
  complained: number;
  hardBounceRate: number;
  complaintRate: number;
}

/**
 * Account-level rollup across every campaign. This is NOT a second opinion on
 * `checkCampaignHealth` — that answers "is THIS campaign damaging inboxes?",
 * this answers "is the whole sending DOMAIN in trouble?" — but it deliberately
 * uses the same two ceilings and the same boundary operators, so the two can
 * never disagree about what a breach is.
 */
export async function measureDeliverability(): Promise<ReputationMetrics> {
  const row = await one<{
    sent: string | number;
    delivered: string | number;
    hard_bounced: string | number;
    complained: string | number;
  }>(
    `SELECT
        COUNT(*) FILTER (WHERE status IN ('SENT','DELIVERED','BOUNCED','COMPLAINED')) AS sent,
        COUNT(*) FILTER (WHERE delivered_at IS NOT NULL)                              AS delivered,
        COUNT(*) FILTER (WHERE bounce_type = 'HARD')                                  AS hard_bounced,
        COUNT(*) FILTER (WHERE complained_at IS NOT NULL)                             AS complained
       FROM messages
      WHERE direction = 'OUTBOUND'
        AND COALESCE(sent_at, created_at) >= now() - ($1::int * interval '1 day')`,
    [REPUTATION_WINDOW_DAYS],
  );

  const sent = toNumber(row?.sent);
  const delivered = toNumber(row?.delivered);
  const hardBounced = toNumber(row?.hard_bounced);
  const complained = toNumber(row?.complained);
  return {
    sent,
    delivered,
    hardBounced,
    complained,
    hardBounceRate: hardBounced / Math.max(sent, 1),
    complaintRate: complained / Math.max(delivered, 1),
  };
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

/** Evaluated between batches. A breach pauses; it never asks an LLM. */
export async function evaluateDeliverability(): Promise<DeliverabilityVerdict> {
  const cfg = getConfig();
  const metrics = await measureDeliverability();
  const db = await getDb();

  await db.query(
    `INSERT INTO sending_reputation (id, hard_bounce_rate, complaint_rate, updated_at)
     VALUES (1, $1, $2, now())
     ON CONFLICT (id) DO UPDATE
        SET hard_bounce_rate = EXCLUDED.hard_bounce_rate,
            complaint_rate   = EXCLUDED.complaint_rate,
            updated_at       = now()`,
    [round4(metrics.hardBounceRate), round4(metrics.complaintRate)],
  );

  if (metrics.sent === 0) return { healthy: true, reason: null, shouldPause: false };

  // Same operators as src/lib/campaign-health.ts: ">=" for hard bounces
  // (the spec reads "hard bounce rate < 5%"), ">" for complaints.
  const reasons: string[] = [];
  if (metrics.hardBounceRate >= cfg.health.maxHardBounceRate) {
    reasons.push(
      `domain hard bounce rate ${pct(metrics.hardBounceRate)} (${metrics.hardBounced}/${metrics.sent}) reaches the ${pct(cfg.health.maxHardBounceRate)} ceiling`,
    );
  }
  if (metrics.complaintRate > cfg.health.maxComplaintRate) {
    reasons.push(
      `domain complaint rate ${pct(metrics.complaintRate)} (${metrics.complained}/${metrics.delivered}) exceeds the ${pct(cfg.health.maxComplaintRate)} ceiling`,
    );
  }

  if (reasons.length === 0) return { healthy: true, reason: null, shouldPause: false };

  const reason = reasons.join('; ');
  // The pause happens HERE, not in a caller that might forget.
  await pauseSending(reason);
  return { healthy: false, reason, shouldPause: true };
}

/**
 * Stops all sending for the configured cooldown. Never shortens an existing
 * pause — a second breach can only ever push the resume time further out.
 */
export async function pauseSending(reason: string): Promise<void> {
  const cfg = getConfig();
  const db = await getDb();
  const hours = Math.max(1, cfg.deliverability.pauseCooldownHours);
  await db.query(
    `INSERT INTO sending_reputation (id, paused_until, pause_reason, updated_at)
     VALUES (1, now() + ($1::int * interval '1 hour'), $2, now())
     ON CONFLICT (id) DO UPDATE
        SET paused_until = GREATEST(
              COALESCE(sending_reputation.paused_until, to_timestamp(0)),
              EXCLUDED.paused_until),
            pause_reason = EXCLUDED.pause_reason,
            updated_at   = now()`,
    [hours, reason.slice(0, 480)],
  );
  logger.error('SENDING PAUSED', { reason, cooldownHours: hours });
  await recordAudit({
    entityType: 'system',
    entityId: 'sending_reputation',
    eventType: 'DECISION',
    actor: 'autonomy:deliverability',
    reason: `sending paused: ${reason}`,
    detail: { cooldownHours: hours },
  });
}

/**
 * The ONLY way out of a pause, and it is deliberately hard: the cooldown must
 * have fully elapsed AND the measured metrics must be healthy again. There is
 * no flag, no override and no model that can shortcut either half.
 */
export async function resumeSendingIfRecovered(): Promise<{ resumed: boolean; reason: string }> {
  const row = await readReputation();
  const until = asDate(row?.paused_until ?? null);
  if (!until) return { resumed: false, reason: 'NOT_PAUSED' };

  const now = new Date();
  if (until.getTime() > now.getTime()) {
    return { resumed: false, reason: `COOLDOWN_ACTIVE_UNTIL:${until.toISOString()}` };
  }

  const cfg = getConfig();
  const metrics = await measureDeliverability();
  if (metrics.sent > 0) {
    if (metrics.hardBounceRate >= cfg.health.maxHardBounceRate) {
      return { resumed: false, reason: `STILL_UNHEALTHY:HARD_BOUNCE_RATE:${pct(metrics.hardBounceRate)}` };
    }
    if (metrics.complaintRate > cfg.health.maxComplaintRate) {
      return { resumed: false, reason: `STILL_UNHEALTHY:COMPLAINT_RATE:${pct(metrics.complaintRate)}` };
    }
  }

  const db = await getDb();
  await db.query(
    `UPDATE sending_reputation
        SET paused_until = NULL, pause_reason = NULL, updated_at = now()
      WHERE id = 1 AND paused_until IS NOT NULL AND paused_until <= now()`,
  );
  logger.info('sending resumed after cooldown and healthy metrics');
  await recordAudit({
    entityType: 'system',
    entityId: 'sending_reputation',
    eventType: 'DECISION',
    actor: 'autonomy:deliverability',
    reason: 'sending resumed: cooldown elapsed and metrics healthy',
    detail: { hardBounceRate: metrics.hardBounceRate, complaintRate: metrics.complaintRate },
  });
  return { resumed: true, reason: 'RECOVERED' };
}

/** Advances a campaign to the next ramp step only if the last batch was healthy. */
export async function maybeAdvanceRamp(campaignId: string): Promise<{
  advanced: boolean;
  rampStep: number;
  reason: string;
}> {
  const cfg = getConfig();
  const steps = cfg.deliverability.rampSteps;
  const row = await one<{ ramp_step: number | string }>(
    'SELECT ramp_step FROM campaigns WHERE id = $1',
    [campaignId],
  );
  if (!row) return { advanced: false, rampStep: 0, reason: 'CAMPAIGN_NOT_FOUND' };

  const step = Math.max(0, Math.floor(toNumber(row.ramp_step)));
  if (steps.length === 0 || step >= steps.length - 1) {
    return { advanced: false, rampStep: step, reason: 'RAMP_AT_MAX' };
  }

  const pause = await isSendingPaused();
  if (pause.paused) return { advanced: false, rampStep: step, reason: 'DELIVERABILITY_PAUSED' };

  // A step is EARNED by completing the previous batch, not by time passing.
  const attempted = await campaignAttemptedCount(campaignId);
  if (attempted <= 0) return { advanced: false, rampStep: step, reason: 'NO_BATCH_YET' };
  if (attempted < campaignRampCap(step)) {
    return { advanced: false, rampStep: step, reason: 'BATCH_IN_PROGRESS' };
  }

  // The single canonical health check. Never forked, never second-guessed.
  const health = await checkCampaignHealth(campaignId);
  if (!health.healthy) {
    return { advanced: false, rampStep: step, reason: `UNHEALTHY:${health.reason ?? 'UNKNOWN'}` };
  }

  const next = step + 1;
  const db = await getDb();
  const res = await db.query(
    'UPDATE campaigns SET ramp_step = $2, updated_at = now() WHERE id = $1 AND ramp_step = $3',
    [campaignId, next, step],
  );
  if (res.rowCount === 0) return { advanced: false, rampStep: step, reason: 'RAMP_ALREADY_ADVANCED' };

  logger.info('campaign ramp advanced', { campaignId, from: step, to: next, cap: campaignRampCap(next) });
  await recordAudit({
    entityType: 'campaign',
    entityId: campaignId,
    eventType: 'DECISION',
    actor: 'autonomy:deliverability',
    reason: `ramp advanced to step ${next} (cap ${campaignRampCap(next)}) after a healthy batch`,
    detail: { fromStep: step, toStep: next, attempted },
  });
  return { advanced: true, rampStep: next, reason: 'HEALTHY_BATCH' };
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}
