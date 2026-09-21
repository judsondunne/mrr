/**
 * Outcome recording and the reward function.
 *
 * THE ONE RULE: a strategy is judged by what prospects DID, never by how
 * persuasive the system's own output sounded and never by engagement
 * telemetry. An email being rendered by a mail client is not evidence that
 * anybody wants to pay for anything, so no such signal is an input here —
 * not as a term, not as a tie-breaker, not as a multiplier. The weights come
 * from `config.learning.rewardWeights` and rank, strongest first:
 *
 *   strong commitment > price acceptance > pilot signup > strong reply > qualified reply
 *
 * The score is normalised per delivered volume. Without that, a 400-message
 * campaign would out-score a 40-message campaign that converted twice as well,
 * and the bandit would learn "send more", which is not a strategy.
 */
import { getConfig } from '../../lib/config';
import { getDb } from '../../lib/db';
import { newId } from '../../lib/hash';
import { createLogger } from '../../lib/logger';
import type { OutcomeInput, OutcomeResults, StrategyDimension } from '../types';
import { updateArm } from './bandit';
import { clamp01 } from './util';

const logger = createLogger('strategy:outcomes');

/**
 * Weighted downstream value per 100 delivered messages that counts as a
 * perfect result. A campaign that clears the READY_TO_BUILD gate lands around
 * 0.6-0.9; a campaign with a handful of polite replies lands near 0.05.
 */
export const REWARD_SATURATION_PER_100_DELIVERED = 10;

/**
 * Floor on the denominator. Three delivered messages and one enthusiastic
 * reply is not a 100%-effective strategy, it is an anecdote.
 */
export const MIN_EFFECTIVE_DELIVERED = 25;

function atLeastZero(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Computes the weighted downstream reward. Pure. */
export function computeReward(results: OutcomeResults): number {
  const weights = getConfig().learning.rewardWeights;
  const delivered = atLeastZero(results.delivered);

  // Commitments that prove the prospect ACTED, not merely agreed.
  const actions =
    atLeastZero(results.installRequests) +
    atLeastZero(results.onboardingDetails) +
    atLeastZero(results.paymentEvents);
  const priceAcceptances = atLeastZero(results.priceAcceptances);
  const pilotSignups = atLeastZero(results.pilotSignups);
  const strongReplies = atLeastZero(results.strongInterest);

  // Replies that engaged without hostility, minus the strong ones already
  // counted above, so one reply is never paid for twice.
  const positiveReplies = Math.max(
    0,
    (clamp01(results.replyRate) - clamp01(results.negativeRate)) * delivered,
  );
  const qualifiedReplies = Math.max(0, positiveReplies - strongReplies);

  const weighted =
    weights.strongCommitment * actions +
    weights.priceAcceptance * priceAcceptances +
    weights.pilotSignup * pilotSignups +
    weights.strongReply * strongReplies +
    weights.qualifiedReply * qualifiedReplies;

  const effectiveDelivered = Math.max(delivered, MIN_EFFECTIVE_DELIVERED);
  const saturation = (effectiveDelivered / 100) * REWARD_SATURATION_PER_100_DELIVERED;
  if (!(saturation > 0)) return 0;
  return clamp01(weighted / saturation);
}

/**
 * The (dimension, arm) pairs an outcome is evidence about. A campaign is one
 * experiment across several dimensions at once, so the same reward updates
 * each arm that took part in it.
 */
export function armsForOutcome(input: OutcomeInput): Array<{ dimension: StrategyDimension; armKey: string }> {
  const pairs: Array<[StrategyDimension, string | null]> = [
    ['RESEARCH_SOURCE', input.source],
    ['CATEGORY_FAMILY', input.category],
    ['ICP_SEGMENT', input.icp],
    ['POSITIONING', input.valueProposition],
    ['PRICE_POINT', input.priceMonthly === null ? null : `usd-${Math.round(input.priceMonthly)}`],
    ['MESSAGE_VARIANT', input.emailVariant],
    ['CONTACT_ROLE', input.contactRoleStrategy],
    ['SEND_TIME', input.sendTimeBucket],
    ['QUERY_FAMILY', input.queryFamily],
  ];
  return pairs
    .filter((pair): pair is [StrategyDimension, string] => typeof pair[1] === 'string' && pair[1].trim() !== '')
    .map(([dimension, armKey]) => ({ dimension, armKey: armKey.trim() }));
}

export async function recordOutcome(
  input: OutcomeInput,
  results: OutcomeResults,
): Promise<{ id: string; reward: number }> {
  const reward = computeReward(results);
  const id = newId('out');
  const db = await getDb();

  await db.query(
    `INSERT INTO strategy_outcomes (
       id, opportunity_id, campaign_id,
       ecosystem, category, problem_type, icp, source, query_family,
       competitor_profile, wedge_type, price_monthly, value_proposition,
       email_variant, landing_variant, contact_role_strategy, send_time_bucket,
       followup_strategy, strategy_version_ids,
       qualified_prospects, delivered, delivery_rate, bounce_rate, reply_rate, negative_rate,
       strong_interest, price_acceptances, pilot_signups, install_requests,
       onboarding_details, payment_events,
       time_to_first_interest_hours, time_to_first_commitment_hours,
       final_result, failure_reason, reward
     ) VALUES (
       $1,$2,$3,
       $4,$5,$6,$7,$8,$9,
       $10,$11,$12,$13,
       $14,$15,$16,$17,
       $18,$19,
       $20,$21,$22,$23,$24,$25,
       $26,$27,$28,$29,
       $30,$31,
       $32,$33,
       $34,$35,$36
     )`,
    [
      id,
      input.opportunityId,
      input.campaignId,
      input.ecosystem,
      input.category,
      input.problemType,
      input.icp,
      input.source,
      input.queryFamily,
      input.competitorProfile,
      input.wedgeType,
      input.priceMonthly,
      input.valueProposition,
      input.emailVariant,
      input.landingVariant,
      input.contactRoleStrategy,
      input.sendTimeBucket,
      input.followupStrategy,
      JSON.stringify(input.strategyVersionIds ?? []),
      Math.round(atLeastZero(results.qualifiedProspects)),
      Math.round(atLeastZero(results.delivered)),
      results.deliveryRate,
      results.bounceRate,
      results.replyRate,
      results.negativeRate,
      Math.round(atLeastZero(results.strongInterest)),
      Math.round(atLeastZero(results.priceAcceptances)),
      Math.round(atLeastZero(results.pilotSignups)),
      Math.round(atLeastZero(results.installRequests)),
      Math.round(atLeastZero(results.onboardingDetails)),
      Math.round(atLeastZero(results.paymentEvents)),
      results.timeToFirstInterestHours,
      results.timeToFirstCommitmentHours,
      results.finalResult,
      results.failureReason,
      reward,
    ],
  );

  const arms = armsForOutcome(input);
  for (const arm of arms) {
    await updateArm(arm.dimension, arm.armKey, reward);
  }
  await updateSegmentPerformance(input, results);

  logger.info('outcome recorded', {
    outcomeId: id,
    campaignId: input.campaignId,
    finalResult: results.finalResult,
    delivered: results.delivered,
    reward,
    armsUpdated: arms.length,
  });
  return { id, reward };
}

/** Rolling per-segment totals, used to rank where the next experiment should go. */
async function updateSegmentPerformance(input: OutcomeInput, results: OutcomeResults): Promise<void> {
  const parts = [input.ecosystem, input.category, input.icp].map((p) => (p ?? '').trim());
  if (parts.every((p) => p === '')) return;
  const segmentKey = parts.join('|');
  const delivered = Math.round(atLeastZero(results.delivered));
  const replies = Math.round(clamp01(results.replyRate) * delivered);
  const commitments =
    Math.round(atLeastZero(results.installRequests)) +
    Math.round(atLeastZero(results.onboardingDetails)) +
    Math.round(atLeastZero(results.paymentEvents)) +
    Math.round(atLeastZero(results.pilotSignups)) +
    Math.round(atLeastZero(results.priceAcceptances));

  const db = await getDb();
  await db.query(
    `INSERT INTO segment_performance
       (id, segment_key, ecosystem, category, icp, prospects, delivered, replies, commitments, price_acceptances)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (segment_key) DO UPDATE SET
       prospects = segment_performance.prospects + EXCLUDED.prospects,
       delivered = segment_performance.delivered + EXCLUDED.delivered,
       replies = segment_performance.replies + EXCLUDED.replies,
       commitments = segment_performance.commitments + EXCLUDED.commitments,
       price_acceptances = segment_performance.price_acceptances + EXCLUDED.price_acceptances,
       updated_at = now()`,
    [
      newId('seg'),
      segmentKey,
      input.ecosystem,
      input.category,
      input.icp,
      Math.round(atLeastZero(results.qualifiedProspects)),
      delivered,
      replies,
      commitments,
      Math.round(atLeastZero(results.priceAcceptances)),
    ],
  );
}
