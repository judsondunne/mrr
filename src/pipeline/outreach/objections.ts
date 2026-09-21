/**
 * Structured objections.
 *
 * "Nobody wants this" is the most valuable thing this system can learn, and it
 * is also the thing a language model is most likely to soften into "promising
 * early signal with some concerns". So:
 *
 *   - EXTRACTION is deterministic. Regex over the reply text, corroborated by
 *     the fields the classifier already produced. No extra model call, nothing
 *     to talk around.
 *   - AGGREGATION is plain SQL. `aggregateObjections` is a GROUP BY. There is
 *     no summariser, no narrative and no place to insert one, so overwhelming
 *     negative feedback shows up as a count and stays a count.
 */
import { getDb, many, toNumber } from '../../lib/db';
import { newId } from '../../lib/hash';
import { createLogger } from '../../lib/logger';
import type { ReplyAnalysis } from '../../lib/contracts';

const logger = createLogger('outreach:objections');

export const OBJECTION_KINDS = [
  'TOO_EXPENSIVE',
  'HAPPY_WITH_COMPETITOR',
  'MISSING_FEATURE',
  'TRUST',
  'NO_NEED',
  'TIMING',
  'PLATFORM_INCOMPATIBLE',
  'WRONG_CONTACT',
  'PRIVACY_SECURITY',
  'OTHER',
] as const;
export type ObjectionKind = (typeof OBJECTION_KINDS)[number];

export interface ExtractedObjection {
  kind: ObjectionKind;
  detail: string;
}

const TEXT_RULES: ReadonlyArray<{ kind: ObjectionKind; pattern: RegExp; detail: string }> = [
  {
    kind: 'TOO_EXPENSIVE',
    pattern:
      /\b(too (expensive|pricey|much)|can'?t afford|out of (our|my) budget|no budget|pric(e|ing) is (high|steep)|cheaper (option|elsewhere)|not worth \$?\d|that'?s a lot for)\b/i,
    detail: 'price objection in the reply text',
  },
  {
    kind: 'HAPPY_WITH_COMPETITOR',
    pattern:
      /\b(we (already )?(use|have|are using|are on)\b|happy with (our|the) current|already (paying for|subscribed)|we'?re on [a-z0-9]|switched to|sticking with)\b/i,
    detail: 'already using another product',
  },
  {
    kind: 'MISSING_FEATURE',
    pattern:
      /\b(only if it|we(?:'| wo)?uld need|needs to (also )?(do|support|handle)|does it (also )?(do|support|handle)|deal ?breaker|must (have|support)|no good without)\b/i,
    detail: 'conditional on a capability',
  },
  {
    kind: 'TRUST',
    pattern:
      /\b(never heard of|who are you|is this (a )?(scam|spam|phishing)|sounds like spam|not sure (you'?re|this is) (real|legit)|any (references|case studies|reviews))\b/i,
    detail: 'credibility objection',
  },
  {
    kind: 'NO_NEED',
    pattern:
      /\b(we don'?t (need|have) (this|that|a )|not (a )?problem for us|doesn'?t apply to us|we handle (this|that) (manually|fine)|no (real )?need)\b/i,
    detail: 'no problem to solve',
  },
  {
    kind: 'TIMING',
    pattern:
      /\b(not (right )?now|maybe (later|next (year|quarter|month))|check back|bad timing|too busy|revisit (this )?(later|in)|circle back)\b/i,
    detail: 'timing objection',
  },
  {
    kind: 'PLATFORM_INCOMPATIBLE',
    pattern:
      /\b(we'?re (not on|on) (woo|wordpress|bigcommerce|magento|squarespace|wix|etsy|amazon)|not (a )?shopify|we don'?t use shopify|different platform|custom (built|platform))\b/i,
    detail: 'not on the target platform',
  },
  {
    kind: 'WRONG_CONTACT',
    pattern:
      /\b(wrong person|not the right person|you'?ll want to (talk|speak) to|forward(ed|ing) (this )?to|no longer (with|at) (the )?(company|us))\b/i,
    detail: 'reached the wrong person',
  },
  {
    kind: 'PRIVACY_SECURITY',
    pattern:
      /\b(where did you get (my|our)|how did you (get|find) (my|our) (email|address)|data (privacy|protection|retention)|security review|gdpr|do not (store|keep) (our|my) data|unsubscribe me from your database)\b/i,
    detail: 'privacy or security objection',
  },
];

/**
 * Deterministic extraction. The classifier's structured fields are treated as
 * corroboration, never as the sole source — the words have to be there, or the
 * classifier has to have produced a hard structured signal.
 */
export function extractObjections(params: { text: string; analysis: ReplyAnalysis }): ExtractedObjection[] {
  const text = (params.text ?? '').slice(0, 20_000);
  const { analysis } = params;
  const found = new Map<ObjectionKind, string>();

  for (const rule of TEXT_RULES) {
    if (rule.pattern.test(text)) found.set(rule.kind, rule.detail);
  }

  // Structured signals the classifier already produced.
  if (analysis.priceReaction === 'TOO_HIGH') found.set('TOO_EXPENSIVE', 'classifier: priceReaction=TOO_HIGH');
  if (analysis.competitorMentioned && analysis.competitorMentioned.trim() !== '') {
    found.set('HAPPY_WITH_COMPETITOR', `competitor: ${analysis.competitorMentioned.trim().slice(0, 120)}`);
  }
  if (analysis.classification === 'WRONG_PERSON') found.set('WRONG_CONTACT', 'classified as WRONG_PERSON');
  if (analysis.classification === 'FEATURE_REQUIREMENT' && analysis.requestedFeature) {
    found.set('MISSING_FEATURE', `requested: ${analysis.requestedFeature.trim().slice(0, 160)}`);
  }
  if (analysis.classification === 'NOT_INTERESTED' && found.size === 0) {
    found.set('NO_NEED', 'declined without a stated reason');
  }
  if (analysis.timing && analysis.timing.trim() !== '' && analysis.classification !== 'WANTS_PILOT') {
    found.set('TIMING', `timing: ${analysis.timing.trim().slice(0, 120)}`);
  }

  return [...found.entries()].map(([kind, detail]) => ({ kind, detail }));
}

/**
 * Writes objections. `UNIQUE (message_id, kind)` means one reply contributes
 * each objection at most once, however many times it is reprocessed.
 */
export async function recordObjections(params: {
  campaignId: string | null;
  opportunityId: string | null;
  prospectId: string | null;
  messageId: string | null;
  companyKey: string | null;
  objections: readonly ExtractedObjection[];
  evidenceText: string;
}): Promise<number> {
  if (params.objections.length === 0) return 0;
  const db = await getDb();
  let created = 0;
  for (const objection of params.objections) {
    const res = await db.query<{ id: string }>(
      `INSERT INTO objections
         (id, campaign_id, opportunity_id, prospect_id, message_id, company_key, kind, detail, evidence_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (message_id, kind) DO NOTHING
       RETURNING id`,
      [
        newId('obj'),
        params.campaignId,
        params.opportunityId,
        params.prospectId,
        params.messageId,
        params.companyKey,
        objection.kind,
        objection.detail.slice(0, 480),
        params.evidenceText.slice(0, 2000),
      ],
    );
    if (res.rows[0]?.id) created += 1;
  }
  if (created > 0) logger.info('objections recorded', { created, opportunityId: params.opportunityId });
  return created;
}

export interface ObjectionSummary {
  kind: ObjectionKind;
  count: number;
  uniqueCompanies: number;
}

/**
 * Plain SQL. No model, no narrative, no "but on the other hand". If 14 of 20
 * replies say TOO_EXPENSIVE, the output says 14.
 */
export async function aggregateObjections(opportunityId: string): Promise<ObjectionSummary[]> {
  const rows = await many<{ kind: string; n: string | number; companies: string | number }>(
    `SELECT kind,
            COUNT(*) AS n,
            COUNT(DISTINCT COALESCE(company_key, prospect_id, id)) AS companies
       FROM objections
      WHERE opportunity_id = $1
      GROUP BY kind
      ORDER BY COUNT(DISTINCT COALESCE(company_key, prospect_id, id)) DESC, kind ASC`,
    [opportunityId],
  );
  return rows.map((row) => ({
    kind: row.kind as ObjectionKind,
    count: toNumber(row.n),
    uniqueCompanies: toNumber(row.companies),
  }));
}

/** The same aggregation scoped to one campaign. */
export async function aggregateCampaignObjections(campaignId: string): Promise<ObjectionSummary[]> {
  const rows = await many<{ kind: string; n: string | number; companies: string | number }>(
    `SELECT kind,
            COUNT(*) AS n,
            COUNT(DISTINCT COALESCE(company_key, prospect_id, id)) AS companies
       FROM objections
      WHERE campaign_id = $1
      GROUP BY kind
      ORDER BY COUNT(DISTINCT COALESCE(company_key, prospect_id, id)) DESC, kind ASC`,
    [campaignId],
  );
  return rows.map((row) => ({
    kind: row.kind as ObjectionKind,
    count: toNumber(row.n),
    uniqueCompanies: toNumber(row.companies),
  }));
}
