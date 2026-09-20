/**
 * PUBLIC API — PROSPECTING LAYER. Owned by the wedge/prospecting agent.
 *
 * This layer answers one question: are the customers this wedge needs actually
 * DISCOVERABLE and REACHABLE through public information? A brilliant idea with
 * inaccessible customers is worthless to this system, so failing that question
 * kills the opportunity instead of quietly continuing.
 */
import type { RejectionReason, Wedge } from '../../lib/contracts';
import { getConfig } from '../../lib/config';
import { getDb, toNumber } from '../../lib/db';
import { hasBudget } from '../../lib/cost';
import { recordAudit, transitionOpportunity } from '../../lib/audit';
import { createLogger, errorToFields } from '../../lib/logger';
import { BudgetExceededError } from '../../lib/errors';
import { loadWedgeFor } from '../wedge/index';
import { discoverProspectsFor, type DiscoverOutcome } from './discover';
import { buildIcpSignals, qualifyProspect, type ProspectToQualify } from './qualify';

const logger = createLogger('prospecting');

export interface ProspectingResult {
  opportunityId: string;
  discovered: number;
  qualified: number;
  rejected: boolean;
  rejectionDetail: string | null;
}

export const DISCOVER_ACTOR = 'discover_prospects';
export const QUALIFY_ACTOR = 'qualify_prospects';

const DISCOVERY_PASS = 'PROSPECT_DISCOVERY_PASS';
const QUALIFY_PASS = 'PROSPECT_QUALIFY_PASS';

/** How many discover/qualify rounds a single opportunity may consume. */
export const MAX_PROSPECTING_PASSES = 3;
/** Work cap per qualification run, so one opportunity cannot hog a job slot. */
export const MAX_QUALIFY_PER_PASS = 120;

interface OpportunityRow {
  id: string;
  ecosystem: string;
  category: string;
  state: string;
}

async function selectOpportunities(states: readonly string[], limit: number): Promise<OpportunityRow[]> {
  const db = await getDb();
  const placeholders = states.map((_s, i) => `$${i + 1}`).join(',');
  const res = await db.query<OpportunityRow>(
    `SELECT id, ecosystem, category, state
       FROM opportunities
      WHERE state IN (${placeholders})
      ORDER BY updated_at ASC
      LIMIT $${states.length + 1}`,
    [...states, limit],
  );
  return res.rows;
}

export interface ProspectCounts {
  total: number;
  pending: number;
  /** Fits the ICP AND has a public business address — the number that matters. */
  qualifiedReachable: number;
  /** Fits the ICP, reachable or not. Distinguishes "wrong market" from "dark market". */
  icpFit: number;
}

export async function getProspectCounts(opportunityId: string): Promise<ProspectCounts> {
  const db = await getDb();
  const res = await db.query<{
    total: string | number;
    pending: string | number;
    qualified_reachable: string | number;
    icp_fit: string | number;
  }>(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE status IN ('DISCOVERED','QUALIFYING')) AS pending,
            COUNT(*) FILTER (WHERE status = 'QUALIFIED'
                             AND contact_email IS NOT NULL
                             AND email_is_public) AS qualified_reachable,
            COUNT(*) FILTER (WHERE evidence_json->>'icpFit' = 'true') AS icp_fit
       FROM prospects
      WHERE opportunity_id = $1`,
    [opportunityId],
  );
  const row = res.rows[0];
  return {
    total: toNumber(row?.total, 0),
    pending: toNumber(row?.pending, 0),
    qualifiedReachable: toNumber(row?.qualified_reachable, 0),
    icpFit: toNumber(row?.icp_fit, 0),
  };
}

function parseDetail(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
}

async function countPasses(opportunityId: string, reason: string): Promise<number> {
  const db = await getDb();
  const res = await db.query<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM audit_events
      WHERE entity_type = 'opportunity' AND entity_id = $1
        AND event_type = 'DECISION' AND reason = $2`,
    [opportunityId, reason],
  );
  return toNumber(res.rows[0]?.n, 0);
}

async function lastPassDetail(
  opportunityId: string,
  reason: string,
): Promise<Record<string, unknown> | null> {
  const db = await getDb();
  const res = await db.query<{ detail_json: unknown }>(
    `SELECT detail_json FROM audit_events
      WHERE entity_type = 'opportunity' AND entity_id = $1
        AND event_type = 'DECISION' AND reason = $2
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [opportunityId, reason],
  );
  const row = res.rows[0];
  return row ? parseDetail(row.detail_json) : null;
}

// --- discovery ---------------------------------------------------------------

/** Finds candidate businesses for opportunities in WEDGE_GENERATED/PROSPECTING. */
export async function discoverProspects(limit: number): Promise<ProspectingResult[]> {
  if (limit <= 0) return [];
  const cfg = getConfig();
  const opportunities = await selectOpportunities(['WEDGE_GENERATED', 'PROSPECTING'], limit);
  const out: ProspectingResult[] = [];

  for (const opp of opportunities) {
    try {
      const wedge = await loadWedgeFor(opp.id);
      if (!wedge) {
        out.push({
          opportunityId: opp.id,
          discovered: 0,
          qualified: 0,
          rejected: false,
          rejectionDetail: 'no wedge recorded; cannot target prospects',
        });
        continue;
      }

      if (opp.state === 'WEDGE_GENERATED') {
        await transitionOpportunity({
          opportunityId: opp.id,
          to: 'PROSPECTING',
          actor: DISCOVER_ACTOR,
          reason: 'prospect discovery started',
          detail: { wedge: wedge.statement },
        });
      }

      const before = await getProspectCounts(opp.id);
      const target = Math.max(0, cfg.preferredQualifiedProspects - before.total);

      let outcome: DiscoverOutcome;
      if (target === 0) {
        outcome = {
          opportunityId: opp.id,
          searchesUsed: 0,
          resultsSeen: 0,
          inserted: 0,
          duplicates: 0,
          skipped: 0,
          budgetExhausted: false,
          queriesExhausted: true,
        };
      } else {
        outcome = await discoverProspectsFor({
          opportunityId: opp.id,
          wedge,
          ecosystem: opp.ecosystem,
          category: opp.category,
          options: { targetNewProspects: target },
        });
      }

      await recordAudit({
        entityType: 'opportunity',
        entityId: opp.id,
        eventType: 'DECISION',
        actor: DISCOVER_ACTOR,
        reason: DISCOVERY_PASS,
        detail: { ...outcome, existingBefore: before.total },
      });

      const after = await getProspectCounts(opp.id);
      out.push({
        opportunityId: opp.id,
        discovered: outcome.inserted,
        qualified: after.qualifiedReachable,
        rejected: false,
        rejectionDetail: outcome.budgetExhausted ? 'search budget exhausted this pass' : null,
      });
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      logger.error('prospect discovery failed', { opportunityId: opp.id, ...errorToFields(err) });
      await recordAudit({
        entityType: 'opportunity',
        entityId: opp.id,
        eventType: 'ERROR',
        actor: DISCOVER_ACTOR,
        reason: 'prospect discovery error',
        detail: errorToFields(err),
      });
      out.push({
        opportunityId: opp.id,
        discovered: 0,
        qualified: 0,
        rejected: false,
        rejectionDetail: `error: ${String(err)}`.slice(0, 500),
      });
    }
  }
  return out;
}

// --- qualification -----------------------------------------------------------

async function loadPending(opportunityId: string, limit: number): Promise<ProspectToQualify[]> {
  const db = await getDb();
  const res = await db.query<ProspectToQualify>(
    `SELECT id, domain, company_name, public_evidence_url
       FROM prospects
      WHERE opportunity_id = $1 AND status IN ('DISCOVERED','QUALIFYING')
      ORDER BY created_at ASC, id ASC
      LIMIT $2`,
    [opportunityId, limit],
  );
  return res.rows;
}

export function rejectionReasonForProspectability(counts: ProspectCounts, minimum: number): RejectionReason {
  if (counts.total === 0) return 'ICP_DISCOVERY_FAILED';
  if (counts.icpFit >= minimum && counts.qualifiedReachable < minimum) return 'PROSPECTS_NOT_REACHABLE';
  return 'INSUFFICIENT_PROSPECTS';
}

/**
 * Verifies candidates against their real site (not search snippets) and finds
 * a PUBLIC business email. Moves the opportunity to CAMPAIGN_READY once the
 * configured minimum is reached, or PROSPECTABILITY_REJECTED if unreachable.
 */
export async function qualifyProspects(limit: number): Promise<ProspectingResult[]> {
  if (limit <= 0) return [];
  const cfg = getConfig();
  const opportunities = await selectOpportunities(['PROSPECTING'], limit);
  const out: ProspectingResult[] = [];

  for (const opp of opportunities) {
    try {
      out.push(await qualifyOne(opp, cfg.minQualifiedProspects, cfg.preferredQualifiedProspects));
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      logger.error('prospect qualification failed', { opportunityId: opp.id, ...errorToFields(err) });
      await recordAudit({
        entityType: 'opportunity',
        entityId: opp.id,
        eventType: 'ERROR',
        actor: QUALIFY_ACTOR,
        reason: 'prospect qualification error',
        detail: errorToFields(err),
      });
      out.push({
        opportunityId: opp.id,
        discovered: 0,
        qualified: 0,
        rejected: false,
        rejectionDetail: `error: ${String(err)}`.slice(0, 500),
      });
    }
  }
  return out;
}

async function qualifyOne(
  opp: OpportunityRow,
  minimum: number,
  preferred: number,
): Promise<ProspectingResult> {
  const wedge: Wedge | null = await loadWedgeFor(opp.id);
  if (!wedge) {
    return {
      opportunityId: opp.id,
      discovered: 0,
      qualified: 0,
      rejected: false,
      rejectionDetail: 'no wedge recorded; cannot qualify prospects',
    };
  }

  const signals = buildIcpSignals(wedge, opp.ecosystem);
  const pending = await loadPending(opp.id, MAX_QUALIFY_PER_PASS);
  let processed = 0;
  let newlyQualified = 0;

  for (const prospect of pending) {
    try {
      const outcome = await qualifyProspect({
        prospect,
        wedge,
        ecosystem: opp.ecosystem,
        signals,
      });
      processed += 1;
      if (outcome.status === 'QUALIFIED') newlyQualified += 1;
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      // One unreadable merchant must not abort the pass; it stays pending and
      // the bounded pass counter stops us retrying forever.
      logger.warn('prospect qualification error', {
        prospectId: prospect.id,
        domain: prospect.domain,
        err: String(err),
      });
    }
  }

  const counts = await getProspectCounts(opp.id);
  const priorPasses = await countPasses(opp.id, QUALIFY_PASS);
  const lastDiscovery = await lastPassDetail(opp.id, DISCOVERY_PASS);
  const searchBudgetGone = !(await hasBudget('SEARCH', getConfig().braveSearchCostPerCall));

  await recordAudit({
    entityType: 'opportunity',
    entityId: opp.id,
    eventType: 'DECISION',
    actor: QUALIFY_ACTOR,
    reason: QUALIFY_PASS,
    detail: { processed, newlyQualified, ...counts, pass: priorPasses + 1 },
  });

  if (counts.qualifiedReachable >= minimum) {
    const score = Math.min(1, Math.round((counts.qualifiedReachable / Math.max(1, preferred)) * 1000) / 1000);
    await transitionOpportunity({
      opportunityId: opp.id,
      to: 'CAMPAIGN_READY',
      actor: QUALIFY_ACTOR,
      reason: `${counts.qualifiedReachable} qualified, reachable prospects (minimum ${minimum})`,
      detail: { ...counts, minimum },
      set: { prospectability_score: score },
    });
    return {
      opportunityId: opp.id,
      discovered: counts.total,
      qualified: counts.qualifiedReachable,
      rejected: false,
      rejectionDetail: null,
    };
  }

  const lastInserted = lastDiscovery === null ? null : toNumber(lastDiscovery['inserted'], 0);
  const discoveryDry = lastInserted !== null && lastInserted === 0;
  const exhausted = counts.pending === 0 && discoveryDry;
  const outOfPasses = priorPasses + 1 >= MAX_PROSPECTING_PASSES;
  const giveUp = searchBudgetGone || exhausted || outOfPasses;

  if (!giveUp) {
    return {
      opportunityId: opp.id,
      discovered: counts.total,
      qualified: counts.qualifiedReachable,
      rejected: false,
      rejectionDetail: null,
    };
  }

  const reason = rejectionReasonForProspectability(counts, minimum);
  const why = searchBudgetGone
    ? 'search budget exhausted'
    : exhausted
      ? 'discovery produced no new candidates and nothing is left to qualify'
      : `no path to ${minimum} qualified prospects after ${MAX_PROSPECTING_PASSES} passes`;
  const detailText = `${reason}: ${counts.qualifiedReachable} qualified and reachable of ${counts.total} discovered (${counts.icpFit} fit the ICP); minimum is ${minimum}; ${why}`;

  await transitionOpportunity({
    opportunityId: opp.id,
    to: 'PROSPECTABILITY_REJECTED',
    actor: QUALIFY_ACTOR,
    reason: detailText,
    detail: { ...counts, minimum, passes: priorPasses + 1, searchBudgetGone, exhausted },
    set: {
      rejection_reason: reason,
      prospectability_score: Math.min(
        1,
        Math.round((counts.qualifiedReachable / Math.max(1, minimum)) * 1000) / 1000,
      ),
    },
  });

  logger.warn('opportunity killed: prospects not reachable', {
    opportunityId: opp.id,
    reason,
    ...counts,
  });

  return {
    opportunityId: opp.id,
    discovered: counts.total,
    qualified: counts.qualifiedReachable,
    rejected: true,
    rejectionDetail: detailText,
  };
}

export { normalizeDomain, isDisallowedProspectDomain, registrableDomain } from './domain';
export { buildProspectQueries, discoverProspectsFor } from './discover';
export { buildIcpSignals, deterministicIcpCheck, qualifyProspect } from './qualify';
export { findPublicContact, classifyEmail, extractEmailCandidates, detectCountry } from './contact';
