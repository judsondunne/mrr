/**
 * THE VALIDATION LADDER — what a candidate has actually earned.
 *
 * `opportunities.state` says where the work is. This says how much a real
 * buyer has told us, and it is the only thing allowed to declare something
 * validated.
 *
 * A candidate climbs ONLY on real prospect behaviour. None of the following
 * moves it one rung:
 *   - Reddit users complaining
 *   - an incumbent existing, or being expensive
 *   - opens, clicks, or replies as such
 *   - "sounds interesting", "that's a real pain", "great idea"
 *   - a high model score
 *
 * The distinction between PAYMENT_INTENT and REVENUE is preserved everywhere:
 * nobody has paid until money has actually moved, and the system must never
 * blur the two.
 */
import { getDb } from '../../lib/db';
import { newId } from '../../lib/hash';
import { createLogger } from '../../lib/logger';
import { recordAudit } from '../../lib/audit';
import { COMMERCIAL_INTENTS, STRONG_SIGNAL_INTENTS, type ReplyIntent } from '../outreach/intent';

const logger = createLogger('validation:ladder');

export const VALIDATION_STAGES = [
  'RESEARCHED',
  'EVIDENCE_BACKED',
  'OUTREACH_TESTING',
  'PAIN_CONFIRMED',
  'COMMERCIAL_SIGNAL',
  'PAYMENT_INTENT',
  'VALIDATED',
  'REJECTED',
] as const;
export type ValidationStage = (typeof VALIDATION_STAGES)[number];

function order(stage: ValidationStage): number {
  return VALIDATION_STAGES.indexOf(stage);
}

/**
 * The gate. Conservative by construction and stated in one place so it can be
 * read and argued with.
 *
 * VALIDATED requires EITHER
 *   (A) two independent qualified companies explicitly willing to pay, or
 *   (B) one company making a concrete commitment (invoice/PO/paid pilot) AND
 *       one further independent company showing strong commercial intent.
 *
 * Because no payment infrastructure exists yet, clearing this gate is recorded
 * as PAYMENT_INTENT_VALIDATED, never REVENUE_VALIDATED. Written intent is not
 * revenue.
 */
export interface GateThresholds {
  minWillingToPayCompanies: number;
  minCommitmentCompanies: number;
  minSupportingCompanies: number;
  minPainConfirmedCompanies: number;
}

export const DEFAULT_THRESHOLDS: GateThresholds = {
  minWillingToPayCompanies: 2,
  minCommitmentCompanies: 1,
  minSupportingCompanies: 1,
  minPainConfirmedCompanies: 2,
};

export interface CompanySignal {
  companyKey: string;
  intent: ReplyIntent;
  qualified: boolean;
  statedAmountUsd: number | null;
  messageId: string | null;
  quote: string;
}

export interface LadderVerdict {
  stage: ValidationStage;
  /** Human-readable justification naming the companies and their words. */
  reason: string;
  willingToPayCompanies: string[];
  commitmentCompanies: string[];
  strongSignalCompanies: string[];
  painConfirmedCompanies: string[];
  /** Every signal that counted, for the audit record. */
  supporting: CompanySignal[];
  /** True once the gate is cleared. Intent only — no money has moved. */
  paymentIntentValidated: boolean;
  /** Reserved: becomes true only when a real payment is recorded. */
  revenueValidated: boolean;
}

/**
 * Collapses many replies into ONE verdict per company.
 *
 * Two employees at the same company are one company; five replies from one
 * person are one company. The unit of evidence is the business, because the
 * business is what would buy.
 */
export function strongestPerCompany(signals: readonly CompanySignal[]): Map<string, CompanySignal> {
  const best = new Map<string, CompanySignal>();
  for (const s of signals) {
    if (!s.qualified) continue;
    const existing = best.get(s.companyKey);
    if (!existing) {
      best.set(s.companyKey, s);
      continue;
    }
    const rankOf = (i: ReplyIntent): number =>
      COMMERCIAL_INTENTS.has(i) ? 3 : STRONG_SIGNAL_INTENTS.has(i) ? 2 : i === 'PAIN_CONFIRMED' ? 1 : 0;
    if (rankOf(s.intent) > rankOf(existing.intent)) best.set(s.companyKey, s);
  }
  return best;
}

/**
 * Evaluates the ladder from the signals gathered so far. Pure: easy to test,
 * and impossible for a prompt to talk around.
 */
export function evaluateLadder(
  signals: readonly CompanySignal[],
  opts: { hasOutreach: boolean; thresholds?: GateThresholds } = { hasOutreach: false },
): LadderVerdict {
  const t = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const perCompany = strongestPerCompany(signals);
  const companies = [...perCompany.values()];

  const commitment = companies.filter((c) => c.intent === 'PAYMENT_COMMITMENT');
  const willing = companies.filter((c) => COMMERCIAL_INTENTS.has(c.intent));
  const strong = companies.filter((c) => STRONG_SIGNAL_INTENTS.has(c.intent));
  const pain = companies.filter(
    (c) => c.intent === 'PAIN_CONFIRMED' || STRONG_SIGNAL_INTENTS.has(c.intent) || COMMERCIAL_INTENTS.has(c.intent),
  );

  const keys = (list: CompanySignal[]): string[] => list.map((c) => c.companyKey);
  const base = {
    willingToPayCompanies: keys(willing),
    commitmentCompanies: keys(commitment),
    strongSignalCompanies: keys(strong),
    painConfirmedCompanies: keys(pain),
    supporting: companies,
    revenueValidated: false,
  };

  // Route A: two independent companies explicitly willing to pay.
  if (willing.length >= t.minWillingToPayCompanies) {
    return {
      ...base,
      stage: 'VALIDATED',
      paymentIntentValidated: true,
      reason:
        `${willing.length} independent qualified companies stated willingness to pay ` +
        `(${keys(willing).join(', ')}). No money has moved: PAYMENT_INTENT_VALIDATED, not revenue.`,
    };
  }

  // Route B: one concrete commitment plus one independent supporting company.
  if (commitment.length >= t.minCommitmentCompanies) {
    const others = companies.filter(
      (c) => !commitment.some((k) => k.companyKey === c.companyKey) &&
        (COMMERCIAL_INTENTS.has(c.intent) || STRONG_SIGNAL_INTENTS.has(c.intent)),
    );
    if (others.length >= t.minSupportingCompanies) {
      return {
        ...base,
        stage: 'VALIDATED',
        paymentIntentValidated: true,
        reason:
          `${keys(commitment).join(', ')} made a concrete commercial commitment and ` +
          `${keys(others).join(', ')} independently showed strong commercial intent. ` +
          'No money has moved: PAYMENT_INTENT_VALIDATED, not revenue.',
      };
    }
    return {
      ...base,
      stage: 'PAYMENT_INTENT',
      paymentIntentValidated: false,
      reason:
        `${keys(commitment).join(', ')} committed, but no second independent company has ` +
        'corroborated it yet. One buyer is an anecdote.',
    };
  }

  if (willing.length > 0) {
    return {
      ...base,
      stage: 'PAYMENT_INTENT',
      paymentIntentValidated: false,
      reason: `${keys(willing).join(', ')} stated willingness to pay; ${t.minWillingToPayCompanies} independent companies are required.`,
    };
  }

  if (strong.length > 0) {
    return {
      ...base,
      stage: 'COMMERCIAL_SIGNAL',
      paymentIntentValidated: false,
      reason: `${keys(strong).join(', ')} showed pilot or price interest without stating willingness to pay.`,
    };
  }

  if (pain.length >= t.minPainConfirmedCompanies) {
    return {
      ...base,
      stage: 'PAIN_CONFIRMED',
      paymentIntentValidated: false,
      reason: `${pain.length} independent companies confirmed the problem. Nobody has discussed paying for it.`,
    };
  }

  if (opts.hasOutreach) {
    return {
      ...base,
      stage: 'OUTREACH_TESTING',
      paymentIntentValidated: false,
      reason:
        pain.length > 0
          ? `${pain.length} company confirmed the problem; ${t.minPainConfirmedCompanies} independent confirmations are required.`
          : 'Outreach is in flight and no qualifying reply has arrived yet.',
    };
  }

  return {
    ...base,
    stage: 'EVIDENCE_BACKED',
    paymentIntentValidated: false,
    reason: 'Public evidence only. No prospect has been contacted, so nothing is validated.',
  };
}

// --- persistence -------------------------------------------------------------

export async function readStage(opportunityId: string): Promise<ValidationStage> {
  const db = await getDb();
  const res = await db.query<{ validation_stage: string }>(
    'SELECT validation_stage FROM opportunities WHERE id = $1',
    [opportunityId],
  );
  const raw = res.rows[0]?.validation_stage ?? 'RESEARCHED';
  return (VALIDATION_STAGES as readonly string[]).includes(raw) ? (raw as ValidationStage) : 'RESEARCHED';
}

/**
 * Moves an opportunity up the ladder and records WHY, citing the message that
 * earned it. A rung is never claimed without the evidence that justifies it.
 *
 * Never moves backwards except into REJECTED: a company that said it would pay
 * does not un-say it because a later reply was lukewarm.
 */
export async function recordStage(params: {
  opportunityId: string;
  to: ValidationStage;
  verdict: LadderVerdict;
  messageId?: string | null;
  companyKey?: string | null;
  evidenceQuote?: string | null;
}): Promise<{ moved: boolean; from: ValidationStage }> {
  const db = await getDb();
  const from = await readStage(params.opportunityId);

  const forward = order(params.to) > order(from);
  const rejecting = params.to === 'REJECTED';
  if (!forward && !rejecting) return { moved: false, from };

  await db.query('UPDATE opportunities SET validation_stage = $2, updated_at = now() WHERE id = $1', [
    params.opportunityId,
    params.to,
  ]);

  await db.query(
    `INSERT INTO validation_transitions
       (id, opportunity_id, from_stage, to_stage, reason, message_id, company_key, evidence_quote, detail_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      newId('vt'),
      params.opportunityId,
      from,
      params.to,
      params.verdict.reason,
      params.messageId ?? null,
      params.companyKey ?? null,
      params.evidenceQuote ?? null,
      JSON.stringify({
        willingToPayCompanies: params.verdict.willingToPayCompanies,
        commitmentCompanies: params.verdict.commitmentCompanies,
        strongSignalCompanies: params.verdict.strongSignalCompanies,
        painConfirmedCompanies: params.verdict.painConfirmedCompanies,
        paymentIntentValidated: params.verdict.paymentIntentValidated,
        revenueValidated: params.verdict.revenueValidated,
      }),
    ],
  );

  await recordAudit({
    entityType: 'opportunity',
    entityId: params.opportunityId,
    eventType: 'STATE_TRANSITION',
    actor: 'validation:ladder',
    fromState: from,
    toState: params.to,
    reason: params.verdict.reason,
    detail: { evidenceQuote: params.evidenceQuote ?? null, companyKey: params.companyKey ?? null },
  });

  logger.info('validation stage advanced', {
    opportunityId: params.opportunityId,
    from,
    to: params.to,
    reason: params.verdict.reason.slice(0, 200),
  });
  return { moved: true, from };
}

/** Every signal recorded for an opportunity, newest first. */
export async function signalsFor(opportunityId: string): Promise<CompanySignal[]> {
  const db = await getDb();
  const res = await db.query<{
    company_key: string;
    intent: string;
    qualified_company: boolean;
    stated_amount_usd: string | number | null;
    message_id: string | null;
    evidence_quote: string;
  }>(
    `SELECT company_key, intent, qualified_company, stated_amount_usd, message_id, evidence_quote
       FROM reply_insights
      WHERE opportunity_id = $1
      ORDER BY created_at DESC`,
    [opportunityId],
  );
  return res.rows.map((r) => ({
    companyKey: r.company_key,
    intent: r.intent as ReplyIntent,
    qualified: r.qualified_company,
    statedAmountUsd: r.stated_amount_usd === null ? null : Number(r.stated_amount_usd),
    messageId: r.message_id,
    quote: r.evidence_quote,
  }));
}

/** Re-evaluates the ladder for one opportunity from everything recorded. */
export async function reevaluate(
  opportunityId: string,
  opts: { hasOutreach: boolean },
): Promise<LadderVerdict> {
  const signals = await signalsFor(opportunityId);
  const verdict = evaluateLadder(signals, opts);
  const current = await readStage(opportunityId);
  if (order(verdict.stage) > order(current)) {
    const top =
      verdict.supporting.find((s) => COMMERCIAL_INTENTS.has(s.intent)) ??
      verdict.supporting.find((s) => STRONG_SIGNAL_INTENTS.has(s.intent)) ??
      verdict.supporting[0];
    await recordStage({
      opportunityId,
      to: verdict.stage,
      verdict,
      messageId: top?.messageId ?? null,
      companyKey: top?.companyKey ?? null,
      evidenceQuote: top?.quote ?? null,
    });
  }
  return verdict;
}
