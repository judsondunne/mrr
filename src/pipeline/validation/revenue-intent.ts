/**
 * THE SECOND TIER.
 *
 * The ten-check gate in ./gate.ts decides VALIDATED_COMMITMENT: real companies
 * said, in writing, that they will pay. That gate is correct and this file does
 * not touch it. What it adds is a STRICTLY STRONGER label above it —
 * VALIDATED_REVENUE_INTENT — for the case where companies did more than agree.
 *
 * Strictly stronger, mechanically:
 *   1. the ten-check gate must already have passed, and
 *   2. at least `revenueIntent.minPriceAcceptedReservations` unique companies
 *      reserved a pilot AT the displayed price, and
 *   3. at least one of
 *        - `minDeposits` unique companies paid a transparent refundable deposit
 *        - `minPaymentMethods` unique companies supplied a payment method
 *        - `minImmediateInstallRequests` unique companies asked for the install
 *          to be sent immediately.
 *
 * VALIDATED_COMMITMENT never implies VALIDATED_REVENUE_INTENT. The only way to
 * the stronger label is to clear every line above.
 *
 * Everything here is deterministic code over rows a real human action created,
 * and every metric counts UNIQUE COMPANIES (commitments.company_key), never
 * rows and never messages.
 */
import { getConfig } from '../../lib/config';
import { getDb } from '../../lib/db';
import type { ValidationLevel } from '../../autonomy/types';
import { getExtremeValidationCounts, getLatestCampaignId } from './counts';
import { evaluateGate } from './gate';
import {
  REVENUE_INTENT_CHECK_IDS,
  type GateCheck,
  type GateEvaluation,
  type RevenueIntentCounts,
  type RevenueIntentEvaluation,
} from './types';

/**
 * "Send the install immediately" is a real, verifiable request, so it is
 * recognised by two independent factors rather than by sentiment: the company
 * must have an INSTALL_REQUEST commitment, AND the words it actually wrote must
 * name installation and name a time that is now.
 *
 * Both patterns are matched against commitments.evidence_text — a verbatim
 * slice of what the company sent us — so nothing here is a judgement call.
 */
export const INSTALL_INTENT_PATTERN = /\binstall(?:s|ed|ing|ation)?\b/i;
export const IMMEDIACY_PATTERN =
  /\b(?:immediately|right away|straight away|asap|today|tonight|now|this week)\b/i;

export function isImmediateInstallRequest(evidenceText: string): boolean {
  return INSTALL_INTENT_PATTERN.test(evidenceText) && IMMEDIACY_PATTERN.test(evidenceText);
}

interface InstallRow {
  company_key: string;
  evidence_text: string;
}

/**
 * Unique companies that asked for the install to be sent immediately.
 *
 * The row filter is SQL; the wording test is the deterministic pair of patterns
 * above. Counting is by DISTINCT company_key, so a company that asked three
 * times is one company.
 */
export async function getImmediateInstallRequestCompanies(campaignId: string): Promise<number> {
  const db = await getDb();
  const res = await db.query<InstallRow>(
    `SELECT company_key, evidence_text FROM commitments
      WHERE campaign_id = $1 AND type = 'INSTALL_REQUEST'`,
    [campaignId],
  );
  const companies = new Set<string>();
  for (const row of res.rows) {
    if (isImmediateInstallRequest(row.evidence_text)) companies.add(row.company_key);
  }
  return companies.size;
}

export async function getRevenueIntentCounts(campaignId: string): Promise<RevenueIntentCounts> {
  const [monetary, immediateInstallRequests] = await Promise.all([
    getExtremeValidationCounts(campaignId),
    getImmediateInstallRequestCompanies(campaignId),
  ]);
  return {
    priceAcceptedReservations: monetary.pricedPilotReservations,
    deposits: monetary.deposits,
    paymentMethods: monetary.paymentMethods,
    immediateInstallRequests,
  };
}

export const EMPTY_REVENUE_INTENT_COUNTS: RevenueIntentCounts = {
  priceAcceptedReservations: 0,
  deposits: 0,
  paymentMethods: 0,
  immediateInstallRequests: 0,
};

export interface RevenueIntentInputs {
  opportunityId: string;
  campaignId: string | null;
  /** The ten-check gate's verdict. The stronger tier sits ON TOP of it. */
  gatePassed: boolean;
  counts: RevenueIntentCounts;
}

function check(
  id: string,
  label: string,
  passed: boolean,
  detail: string,
  actual: number | string,
  required: number | string,
): GateCheck {
  return { id, label, passed, detail, actual, required };
}

function companies(n: number): string {
  return `${n} unique ${n === 1 ? 'company' : 'companies'}`;
}

/**
 * The decision. Pure function of counts and configured thresholds — no I/O and
 * no model, exactly like the tier below it.
 */
export function decideRevenueIntent(inputs: RevenueIntentInputs): RevenueIntentEvaluation {
  const cfg = getConfig();
  const r = cfg.revenueIntent;
  const { counts } = inputs;
  const checks: GateCheck[] = [];

  // 1. The stronger tier is only ever reachable from a passing gate.
  checks.push(
    check(
      REVENUE_INTENT_CHECK_IDS.baseGate,
      'The deterministic commitment gate already passed',
      inputs.gatePassed,
      inputs.gatePassed
        ? 'every check of the commitment gate passed, so the stronger tier may be assessed'
        : 'the commitment gate has not passed, and the revenue-intent tier is strictly stronger than it',
      inputs.gatePassed ? 'passed' : 'not passed',
      'passed',
    ),
  );

  // 2. Price-accepted pilot reservations, by unique company.
  const reservationsOk = counts.priceAcceptedReservations >= r.minPriceAcceptedReservations;
  checks.push(
    check(
      REVENUE_INTENT_CHECK_IDS.priceAcceptedReservations,
      'Unique companies that reserved a pilot at the displayed price',
      reservationsOk,
      `${companies(counts.priceAcceptedReservations)} reserved a pilot at the displayed price, need ${r.minPriceAcceptedReservations}`,
      counts.priceAcceptedReservations,
      r.minPriceAcceptedReservations,
    ),
  );

  // 3. One of: a real deposit, payment methods, or immediate install requests.
  const depositsOk = counts.deposits >= r.minDeposits;
  const methodsOk = counts.paymentMethods >= r.minPaymentMethods;
  const installsOk = counts.immediateInstallRequests >= r.minImmediateInstallRequests;
  const monetaryOk = depositsOk || methodsOk || installsOk;
  checks.push(
    check(
      REVENUE_INTENT_CHECK_IDS.monetaryOrImmediate,
      'A monetary or immediate-access signal on top of the price acceptance',
      monetaryOk,
      `need one of: ${counts.deposits} transparent refundable ${counts.deposits === 1 ? 'deposit' : 'deposits'} (need ${r.minDeposits}), ` +
        `${companies(counts.paymentMethods)} supplied a payment method (need ${r.minPaymentMethods}), ` +
        `${companies(counts.immediateInstallRequests)} asked for the install immediately (need ${r.minImmediateInstallRequests})`,
      `${counts.deposits} deposits / ${counts.paymentMethods} payment methods / ${counts.immediateInstallRequests} immediate install requests`,
      `${r.minDeposits} deposits OR ${r.minPaymentMethods} payment methods OR ${r.minImmediateInstallRequests} immediate install requests`,
    ),
  );

  const unmetChecks = checks.filter((c) => !c.passed);
  const achieved = unmetChecks.length === 0;

  return {
    opportunityId: inputs.opportunityId,
    campaignId: inputs.campaignId,
    achieved,
    level: achieved ? 'VALIDATED_REVENUE_INTENT' : 'VALIDATED_COMMITMENT',
    checks,
    unmetChecks,
    counts,
    /** Whether the system is configured to actively solicit paid signals. */
    pursuitEnabled: r.enabled,
    evaluatedAt: new Date().toISOString(),
  };
}

/**
 * Reads the counts and decides, without transitioning or writing anything.
 * Safe to call from the dashboard, the owner email and the build spec.
 *
 * `gate` may be supplied by a caller that has already evaluated it, so the ten
 * checks are never run twice for one decision.
 */
export async function evaluateRevenueIntent(
  opportunityId: string,
  gate?: GateEvaluation,
): Promise<RevenueIntentEvaluation> {
  const evaluation = gate ?? (await evaluateGate(opportunityId));
  const campaignId = evaluation.campaignId ?? (await getLatestCampaignId(opportunityId));
  const counts = campaignId
    ? await getRevenueIntentCounts(campaignId)
    : { ...EMPTY_REVENUE_INTENT_COUNTS };

  return decideRevenueIntent({
    opportunityId,
    campaignId,
    gatePassed: evaluation.passed,
    counts,
  });
}

/**
 * Stores the achieved label on the opportunity.
 *
 * This column is a LABEL, not a lever: it records which tier the evidence
 * reached. It is never read back as an input to any threshold, and it cannot
 * move an opportunity between states — only ./gate.ts can do that.
 */
export async function persistValidationLevel(
  opportunityId: string,
  level: ValidationLevel,
): Promise<void> {
  const db = await getDb();
  await db.query('UPDATE opportunities SET validation_level = $2 WHERE id = $1', [
    opportunityId,
    level,
  ]);
}

export async function readValidationLevel(opportunityId: string): Promise<ValidationLevel | null> {
  const db = await getDb();
  const res = await db.query<{ validation_level: string | null }>(
    'SELECT validation_level FROM opportunities WHERE id = $1',
    [opportunityId],
  );
  const value = res.rows[0]?.validation_level ?? null;
  if (value === 'VALIDATED_COMMITMENT' || value === 'VALIDATED_REVENUE_INTENT') return value;
  return null;
}
