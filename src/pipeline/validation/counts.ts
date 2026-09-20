/**
 * Campaign counting. Pure SQL.
 *
 * RESEARCH IS NOT VALIDATION, and neither is a model's opinion: every number
 * here is COUNT() over rows a real human action created.
 *
 * Rules encoded below and nowhere else:
 *   - Every commitment metric counts UNIQUE COMPANIES (commitments.company_key).
 *     Five replies from one company are one company.
 *   - `delivered` counts OUTBOUND messages with delivered_at IS NOT NULL.
 *   - Opens are NEVER counted. Clicks are recorded upstream but never read here,
 *     so they cannot gate anything.
 */
import { getDb, toNumber } from '../../lib/db.js';
import {
  ACTION_COMMITMENT_TYPES,
  MONETARY_COMMITMENT_TYPES,
  PRICE_ACCEPTANCE_TYPES,
  type CommitmentType,
} from '../../lib/contracts.js';
import { EMPTY_COUNTS, type CampaignCounts } from './types.js';

/** Prospect statuses that mean "this business passed ICP qualification". */
export const QUALIFIED_PROSPECT_STATUSES: readonly string[] = [
  'QUALIFIED',
  'CONTACTED',
  'REPLIED',
  'COMMITTED',
  'SUPPRESSED',
  'BOUNCED',
];

/**
 * Reply classifications counted as positive. Deliberately generous: this number
 * is only ever used to keep a campaign ALIVE, never to advance it.
 */
export const POSITIVE_REPLY_CLASSIFICATIONS: readonly string[] = [
  'INTERESTED_WEAK',
  'INTERESTED_STRONG',
  'PRICE_ACCEPTED',
  'WANTS_PILOT',
];

export const NEGATIVE_REPLY_CLASSIFICATIONS: readonly string[] = ['NOT_INTERESTED', 'UNSUBSCRIBE'];

/** Builds a positional-parameter accumulator so nothing is interpolated into SQL. */
function binder() {
  const params: unknown[] = [];
  const one = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const many = (values: readonly unknown[]): string => values.map(one).join(', ');
  return { params, one, many };
}

function sorted(set: ReadonlySet<CommitmentType>): CommitmentType[] {
  return [...set].sort();
}

export async function getOpportunityIdForCampaign(campaignId: string): Promise<string | null> {
  const db = await getDb();
  const res = await db.query<{ opportunity_id: string }>(
    'SELECT opportunity_id FROM campaigns WHERE id = $1',
    [campaignId],
  );
  return res.rows[0]?.opportunity_id ?? null;
}

/** The campaign the gate reads for an opportunity: the most recently created one. */
export async function getLatestCampaignId(opportunityId: string): Promise<string | null> {
  const db = await getDb();
  const res = await db.query<{ id: string }>(
    `SELECT id FROM campaigns
      WHERE opportunity_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [opportunityId],
  );
  return res.rows[0]?.id ?? null;
}

export async function getQualifiedProspectCount(opportunityId: string): Promise<number> {
  const db = await getDb();
  const b = binder();
  const sql = `SELECT COUNT(*) AS n FROM prospects
                WHERE opportunity_id = ${b.one(opportunityId)}
                  AND status IN (${b.many(QUALIFIED_PROSPECT_STATUSES)})`;
  const res = await db.query<{ n: string | number }>(sql, b.params);
  return toNumber(res.rows[0]?.n, 0);
}

/** Outbound messages that actually left the system (the health denominator). */
export async function getAttemptedCount(campaignId: string): Promise<number> {
  const db = await getDb();
  const res = await db.query<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM messages
      WHERE campaign_id = $1 AND direction = 'OUTBOUND' AND sent_at IS NOT NULL`,
    [campaignId],
  );
  return toNumber(res.rows[0]?.n, 0);
}

interface CountsRow {
  qualified_prospects: string | number;
  delivered: string | number;
  replied: string | number;
  positive_replies: string | number;
  negative_replies: string | number;
  hard_bounced: string | number;
  complained: string | number;
  unsubscribed: string | number;
  unique_strong: string | number;
  unique_price: string | number;
  unique_action: string | number;
  unique_monetary: string | number;
}

/**
 * Every number the gate is allowed to look at, in one query.
 *
 * `positiveIntentRate` = unique companies with any strong commitment / delivered,
 * and is 0 when nothing has been delivered (never NaN, never Infinity).
 */
export async function getCampaignCounts(campaignId: string): Promise<CampaignCounts> {
  const opportunityId = (await getOpportunityIdForCampaign(campaignId)) ?? '';
  const db = await getDb();
  const b = binder();

  const sql = `
    SELECT
      (SELECT COUNT(*) FROM prospects
         WHERE opportunity_id = ${b.one(opportunityId)}
           AND status IN (${b.many(QUALIFIED_PROSPECT_STATUSES)})) AS qualified_prospects,

      (SELECT COUNT(*) FROM messages
         WHERE campaign_id = ${b.one(campaignId)}
           AND direction = 'OUTBOUND'
           AND delivered_at IS NOT NULL) AS delivered,

      (SELECT COUNT(*) FROM messages
         WHERE campaign_id = ${b.one(campaignId)}
           AND direction = 'INBOUND') AS replied,

      (SELECT COUNT(*) FROM messages
         WHERE campaign_id = ${b.one(campaignId)}
           AND direction = 'INBOUND'
           AND classification IN (${b.many(POSITIVE_REPLY_CLASSIFICATIONS)})) AS positive_replies,

      (SELECT COUNT(*) FROM messages
         WHERE campaign_id = ${b.one(campaignId)}
           AND direction = 'INBOUND'
           AND classification IN (${b.many(NEGATIVE_REPLY_CLASSIFICATIONS)})) AS negative_replies,

      (SELECT COUNT(*) FROM messages
         WHERE campaign_id = ${b.one(campaignId)}
           AND direction = 'OUTBOUND'
           AND bounced_at IS NOT NULL
           AND bounce_type = 'HARD') AS hard_bounced,

      (SELECT COUNT(*) FROM messages
         WHERE campaign_id = ${b.one(campaignId)}
           AND complained_at IS NOT NULL) AS complained,

      (SELECT COUNT(DISTINCT p.id) FROM prospects p
         WHERE p.opportunity_id = ${b.one(opportunityId)}
           AND EXISTS (SELECT 1 FROM messages m
                        WHERE m.campaign_id = ${b.one(campaignId)} AND m.prospect_id = p.id)
           AND (
             EXISTS (SELECT 1 FROM suppression_list s
                      WHERE s.reason = 'UNSUBSCRIBE'
                        AND s.email IS NOT NULL
                        AND s.email = p.contact_email)
             OR EXISTS (SELECT 1 FROM messages im
                         WHERE im.campaign_id = ${b.one(campaignId)}
                           AND im.prospect_id = p.id
                           AND im.direction = 'INBOUND'
                           AND im.classification = 'UNSUBSCRIBE')
           )) AS unsubscribed,

      (SELECT COUNT(DISTINCT company_key) FROM commitments
         WHERE campaign_id = ${b.one(campaignId)}) AS unique_strong,

      (SELECT COUNT(DISTINCT company_key) FROM commitments
         WHERE campaign_id = ${b.one(campaignId)}
           AND type IN (${b.many(sorted(PRICE_ACCEPTANCE_TYPES))})) AS unique_price,

      (SELECT COUNT(DISTINCT company_key) FROM commitments
         WHERE campaign_id = ${b.one(campaignId)}
           AND type IN (${b.many(sorted(ACTION_COMMITMENT_TYPES))})) AS unique_action,

      (SELECT COUNT(DISTINCT company_key) FROM commitments
         WHERE campaign_id = ${b.one(campaignId)}
           AND type IN (${b.many(sorted(MONETARY_COMMITMENT_TYPES))})) AS unique_monetary
  `;

  const res = await db.query<CountsRow>(sql, b.params);
  const row = res.rows[0];
  if (!row) return { ...EMPTY_COUNTS };

  const delivered = toNumber(row.delivered, 0);
  const uniqueStrong = toNumber(row.unique_strong, 0);

  return {
    qualifiedProspects: toNumber(row.qualified_prospects, 0),
    delivered,
    replied: toNumber(row.replied, 0),
    positiveReplies: toNumber(row.positive_replies, 0),
    negativeReplies: toNumber(row.negative_replies, 0),
    hardBounced: toNumber(row.hard_bounced, 0),
    complained: toNumber(row.complained, 0),
    unsubscribed: toNumber(row.unsubscribed, 0),
    uniqueStrongCommitmentCompanies: uniqueStrong,
    uniquePriceAcceptanceCompanies: toNumber(row.unique_price, 0),
    uniqueActionCommitmentCompanies: toNumber(row.unique_action, 0),
    uniqueMonetaryCommitmentCompanies: toNumber(row.unique_monetary, 0),
    positiveIntentRate: delivered > 0 ? uniqueStrong / delivered : 0,
  };
}

/** Unique companies per commitment type. Used by the owner email breakdown. */
export async function getCommitmentCompaniesByType(
  campaignId: string,
): Promise<Record<string, number>> {
  const db = await getDb();
  const res = await db.query<{ type: string; n: string | number }>(
    `SELECT type, COUNT(DISTINCT company_key) AS n
       FROM commitments WHERE campaign_id = $1 GROUP BY type`,
    [campaignId],
  );
  const out: Record<string, number> = {};
  for (const row of res.rows) out[row.type] = toNumber(row.n, 0);
  return out;
}

/**
 * Unique companies across an arbitrary set of commitment types.
 * Summing per-type counts would double-count a company that did two things.
 */
export async function getUniqueCompanyCountForTypes(
  campaignId: string,
  types: readonly string[],
): Promise<number> {
  if (types.length === 0) return 0;
  const db = await getDb();
  const b = binder();
  const sql = `SELECT COUNT(DISTINCT company_key) AS n FROM commitments
                WHERE campaign_id = ${b.one(campaignId)} AND type IN (${b.many(types)})`;
  const res = await db.query<{ n: string | number }>(sql, b.params);
  return toNumber(res.rows[0]?.n, 0);
}

export interface ExtremeValidationCounts {
  /** Unique companies that reserved a pilot AT the displayed price. */
  pricedPilotReservations: number;
  /** Unique companies that voluntarily supplied a payment method. */
  paymentMethods: number;
  /** Unique companies that paid a refundable pilot deposit. */
  deposits: number;
}

export async function getExtremeValidationCounts(
  campaignId: string,
): Promise<ExtremeValidationCounts> {
  const db = await getDb();
  const res = await db.query<{ priced_pilots: string | number; methods: string | number; deposits: string | number }>(
    `SELECT
       (SELECT COUNT(DISTINCT company_key) FROM commitments
          WHERE campaign_id = $1 AND type = 'PILOT_SIGNUP' AND price_monthly IS NOT NULL) AS priced_pilots,
       (SELECT COUNT(DISTINCT company_key) FROM commitments
          WHERE campaign_id = $1 AND type = 'PAYMENT_METHOD_ADDED') AS methods,
       (SELECT COUNT(DISTINCT company_key) FROM commitments
          WHERE campaign_id = $1 AND type = 'DEPOSIT') AS deposits`,
    [campaignId],
  );
  const row = res.rows[0];
  return {
    pricedPilotReservations: toNumber(row?.priced_pilots, 0),
    paymentMethods: toNumber(row?.methods, 0),
    deposits: toNumber(row?.deposits, 0),
  };
}

export interface SnapshotExtras {
  sent: number;
  bounced: number;
  landingVisits: number;
  pilotSignups: number;
  explicitPriceAcceptances: number;
  strongCommitmentRows: number;
}

/** Extra raw totals the campaign_metrics table stores but the gate never reads. */
export async function getSnapshotExtras(campaignId: string): Promise<SnapshotExtras> {
  const db = await getDb();
  const res = await db.query<Record<string, string | number>>(
    `SELECT
       (SELECT COUNT(*) FROM messages
          WHERE campaign_id = $1 AND direction = 'OUTBOUND' AND sent_at IS NOT NULL) AS sent,
       (SELECT COUNT(*) FROM messages
          WHERE campaign_id = $1 AND direction = 'OUTBOUND' AND bounced_at IS NOT NULL) AS bounced,
       (SELECT COUNT(*) FROM landing_visits WHERE campaign_id = $1) AS landing_visits,
       (SELECT COUNT(DISTINCT company_key) FROM commitments
          WHERE campaign_id = $1 AND type = 'PILOT_SIGNUP') AS pilot_signups,
       (SELECT COUNT(DISTINCT company_key) FROM commitments
          WHERE campaign_id = $1 AND type = 'EXPLICIT_PRICE_ACCEPTANCE') AS explicit_price_acceptances,
       (SELECT COUNT(*) FROM commitments WHERE campaign_id = $1) AS strong_commitment_rows`,
    [campaignId],
  );
  const row = res.rows[0];
  return {
    sent: toNumber(row?.sent, 0),
    bounced: toNumber(row?.bounced, 0),
    landingVisits: toNumber(row?.landing_visits, 0),
    pilotSignups: toNumber(row?.pilot_signups, 0),
    explicitPriceAcceptances: toNumber(row?.explicit_price_acceptances, 0),
    strongCommitmentRows: toNumber(row?.strong_commitment_rows, 0),
  };
}

/** Inbound replies whose extraction says the prospect rejected the price. */
export async function getPriceRejectionCount(campaignId: string): Promise<number> {
  const db = await getDb();
  const res = await db.query<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM messages
      WHERE campaign_id = $1 AND direction = 'INBOUND'
        AND extraction_json->>'priceReaction' = 'TOO_HIGH'`,
    [campaignId],
  );
  return toNumber(res.rows[0]?.n, 0);
}

/** Inbound replies that say we emailed the wrong kind of business/person. */
export async function getWrongPersonCount(campaignId: string): Promise<number> {
  const db = await getDb();
  const res = await db.query<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM messages
      WHERE campaign_id = $1 AND direction = 'INBOUND' AND classification = 'WRONG_PERSON'`,
    [campaignId],
  );
  return toNumber(res.rows[0]?.n, 0);
}
