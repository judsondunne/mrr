/**
 * Staged research depth — the main token-cost reduction in the system.
 *
 * Five stages, cheapest first, and an opportunity only ever moves ONE stage at
 * a time:
 *
 *   0  deterministic filtering        no search, no fetch, no LLM, zero spend
 *   1  cheap marketplace/search       one cached search, or nothing at all
 *   2  fast-model classification      fast tier, short structured output
 *   3  review/complaint analysis      fast tier, only when reviews exist
 *   4  reasoner                       FINALISTS ONLY
 *
 * `opportunities.research_stage` holds the NEXT stage to run. It starts at 0,
 * so reaching 4 is proof that 0–3 were all run and all survived. Elimination
 * parks the row at `ELIMINATED_RESEARCH_STAGE` and nothing can advance from
 * there — which is what makes "an eliminated candidate never costs reasoner
 * tokens" a structural property rather than a promise.
 *
 * What the models here decide: whether to keep SPENDING on an opportunity.
 * What they never decide: whether it is validated. That remains the pure
 * deterministic gate, which this file neither imports nor influences.
 */
import { z } from 'zod';
import { recordAudit } from '../../lib/audit';
import { getConfig } from '../../lib/config';
import { getDb, toNumber, type Db } from '../../lib/db';
import { AppError, BudgetExceededError } from '../../lib/errors';
import { newId } from '../../lib/hash';
import { llmComplete } from '../../lib/llm/index';
import { createLogger } from '../../lib/logger';
import { getSearchProvider, search } from '../../lib/search/index';
import { DEAD_STATES, isOpportunityState } from '../../lib/state-machine';
import {
  estimateBuildDays,
  evaluateRejectionRules,
  type RejectionSubject,
} from '../../pipeline/verification/rejection-rules';

const logger = createLogger('autonomy:staging');

// --- the ladder ---------------------------------------------------------------

export const RESEARCH_STAGES = [0, 1, 2, 3, 4] as const;
export type ResearchStage = (typeof RESEARCH_STAGES)[number];

/** The last stage that runs. Only a finalist ever reaches it. */
export const MAX_RESEARCH_STAGE = 4;

/** Survived every stage. No further research spend is owed. */
export const COMPLETE_RESEARCH_STAGE = 5;

/** Killed during staged research. Terminal for this ladder. */
export const ELIMINATED_RESEARCH_STAGE = -1;

/** Stages that may call an LLM at all. Everything below is free. */
export const FIRST_LLM_STAGE = 2;

/** The one stage allowed to use the reasoner tier. */
export const REASONER_STAGE = 4;

/** PURE. The ladder may only be climbed one rung at a time. */
export function canEnterStage(from: number, to: number): boolean {
  if (to === ELIMINATED_RESEARCH_STAGE) return from >= 0 && from <= MAX_RESEARCH_STAGE;
  if (from < 0 || from > MAX_RESEARCH_STAGE) return false;
  return to === from + 1 && to <= COMPLETE_RESEARCH_STAGE;
}

function assertStageProgression(opportunityId: string, from: number, to: number): void {
  if (canEnterStage(from, to)) return;
  throw new AppError(
    `research stage ${from} -> ${to} skips the ladder`,
    'RESEARCH_STAGE_SKIPPED',
    false,
    { opportunityId, from, to },
  );
}

// --- thresholds (deterministic, no model input) -------------------------------

export const MIN_DESCRIPTION_CHARS = 20;
export const MIN_COMPETITORS_FOR_STAGE_1 = 1;
export const MIN_SEARCH_RESULTS_FOR_STAGE_1 = 2;
export const MAX_COMPETITOR_CORPUS_CHARS = 6_000;
export const MAX_REVIEW_CORPUS_CHARS = 6_000;

// --- rows ----------------------------------------------------------------------

interface OpportunityRow {
  id: string;
  name: string;
  ecosystem: string;
  category: string;
  description: string;
  source_url: string | null;
  state: string;
  research_stage: number;
}

interface CompetitorFactsRow {
  name: string;
  url: string;
  current_pricing: string | null;
  has_permanent_free_tier: boolean | null;
  review_count: number | null;
}

async function readOpportunity(db: Db, id: string): Promise<OpportunityRow | null> {
  const res = await db.query<OpportunityRow>(
    `SELECT id, name, ecosystem, category, description, source_url, state, research_stage
       FROM opportunities WHERE id = $1`,
    [id],
  );
  return res.rows[0] ?? null;
}

async function readCompetitors(opportunityId: string): Promise<CompetitorFactsRow[]> {
  const db = await getDb();
  const res = await db.query<CompetitorFactsRow>(
    `SELECT name, url, current_pricing, has_permanent_free_tier, review_count
       FROM competitors WHERE opportunity_id = $1 ORDER BY name LIMIT 12`,
    [opportunityId],
  );
  return res.rows;
}

async function readReviewTexts(opportunityId: string): Promise<string[]> {
  const db = await getDb();
  const res = await db.query<{ text: string }>(
    `SELECT r.text
       FROM reviews r
       JOIN competitors c ON c.id = r.competitor_id
      WHERE c.opportunity_id = $1 AND r.text <> ''
      ORDER BY r.review_date DESC NULLS LAST
      LIMIT 25`,
    [opportunityId],
  );
  return res.rows.map((r) => r.text);
}

function competitorCorpus(rows: CompetitorFactsRow[]): string {
  return rows
    .map((c) =>
      [
        c.name,
        c.current_pricing ?? 'pricing not stated',
        c.has_permanent_free_tier === true ? 'has a permanent free tier' : '',
        c.review_count !== null ? `${c.review_count} reviews` : '',
      ]
        .filter(Boolean)
        .join(' — '),
    )
    .join('\n')
    .slice(0, MAX_COMPETITOR_CORPUS_CHARS);
}

// --- stage outcomes --------------------------------------------------------------

interface StageOutcome {
  survived: boolean;
  reason: string;
  /** LLM/search dollars this stage actually committed. */
  spendUsd: number;
  detail: Record<string, unknown>;
}

// --- stage 0: deterministic filtering (zero spend) --------------------------------

/**
 * Reads only what is already in the database. Reuses the verification layer's
 * rejection rules and build estimator rather than inventing a second opinion.
 */
async function stageDeterministicFilter(opp: OpportunityRow): Promise<StageOutcome> {
  const competitors = await readCompetitors(opp.id);
  const description = (opp.description ?? '').trim();

  if (description.length < MIN_DESCRIPTION_CHARS && !opp.source_url) {
    return {
      survived: false,
      reason: 'nothing to research: no description and no source URL',
      spendUsd: 0,
      detail: { descriptionChars: description.length },
    };
  }

  const subject: RejectionSubject = {
    name: opp.name,
    category: opp.category,
    description,
    corpus: competitorCorpus(competitors),
    competitorCount: competitors.length,
    paidCompetitorCount: competitors.filter((c) => c.has_permanent_free_tier === false).length,
  };
  const estimate = estimateBuildDays(subject);
  const verdict = evaluateRejectionRules({ ...subject, estimatedBuildDays: estimate.days });

  if (verdict.rejected) {
    return {
      survived: false,
      reason: `deterministic rule ${verdict.ruleId ?? 'unknown'}: ${verdict.detail}`,
      spendUsd: 0,
      detail: {
        ruleId: verdict.ruleId,
        rejectionReason: verdict.reason,
        penalty: verdict.penalty,
        estimatedBuildDays: estimate.days,
      },
    };
  }

  return {
    survived: true,
    reason: 'passed the deterministic filter',
    spendUsd: 0,
    detail: { estimatedBuildDays: estimate.days, competitorCount: competitors.length },
  };
}

// --- stage 1: cheap marketplace / search extraction -------------------------------

/**
 * Cache-first: if discovery already extracted competitors we spend nothing at
 * all. Only a bare opportunity costs one cached search.
 */
async function stageCheapExtraction(opp: OpportunityRow): Promise<StageOutcome> {
  const competitors = await readCompetitors(opp.id);
  if (competitors.length >= MIN_COMPETITORS_FOR_STAGE_1) {
    return {
      survived: true,
      reason: `${competitors.length} competitor record(s) already extracted`,
      spendUsd: 0,
      detail: { competitorCount: competitors.length, searched: false },
    };
  }

  const topic = `${opp.ecosystem} app ${opp.category.replace(/-/g, ' ')} pricing`;
  let results;
  try {
    results = await search(topic, 10);
  } catch (err) {
    if (err instanceof BudgetExceededError) throw err;
    logger.warn('stage 1 search failed', { opportunityId: opp.id, err: String(err) });
    return {
      survived: false,
      reason: 'no marketplace evidence and the search failed',
      spendUsd: 0,
      detail: { topic, error: String(err).slice(0, 200) },
    };
  }

  // `search()` is cache-first, so this is an upper bound on what the query
  // could have cost. It is booked to RESEARCH for sub-budget attribution, and
  // priced exactly the way the search layer prices it, so a mock run stays $0.
  const spendUsd = getSearchProvider().name === 'mock' ? 0 : getConfig().braveSearchCostPerCall;
  const survived = results.length >= MIN_SEARCH_RESULTS_FOR_STAGE_1;
  return {
    survived,
    reason: survived
      ? `${results.length} search results indicate an existing market`
      : `only ${results.length} search result(s): nobody appears to build for this`,
    spendUsd,
    detail: { topic, resultCount: results.length, searched: true },
  };
}

// --- stage 2: fast-model classification ---------------------------------------------

const CategoryClassification = z.object({
  looksLikeRecurringBusinessJob: z.boolean(),
  audienceIsBusinesses: z.boolean(),
  paidCompetitorsMentioned: z.boolean(),
  narrowEnoughForASmallApp: z.boolean(),
  note: z.string().max(300),
});

export const STAGE2_PROMPT_ID = 'research.stage2_category_classification';
export const STAGE2_PROMPT_VERSION = 1;

const STAGE2_SYSTEM = [
  'You classify ONE software category from evidence already collected.',
  'Answer only the booleans asked for, from what the evidence literally says.',
  'You are not scoring or ranking anything and no number you emit is used.',
  'If the evidence does not say, answer false.',
].join(' ');

async function stageFastClassification(opp: OpportunityRow): Promise<StageOutcome> {
  const competitors = await readCompetitors(opp.id);

  const res = await llmComplete({
    tier: 'fast',
    task: 'research.stage2_classification',
    promptId: STAGE2_PROMPT_ID,
    promptVersion: STAGE2_PROMPT_VERSION,
    phase: 'RESEARCH',
    opportunityId: opp.id,
    schemaName: 'CategoryClassification',
    schema: CategoryClassification,
    maxTokens: 400,
    system: STAGE2_SYSTEM,
    user: [
      `Category: ${opp.category}`,
      `Ecosystem: ${opp.ecosystem}`,
      `Our own one-line description: ${opp.description || '(none)'}`,
      `Competitor records on file: ${competitors.length}`,
    ].join('\n'),
    untrusted: { competitor_listings: competitorCorpus(competitors) || '(none collected)' },
  });

  const c = res.data;
  // The model classifies. This line decides. Deterministic, auditable, and
  // unchanged by anything the model writes in `note`.
  const survived =
    c.looksLikeRecurringBusinessJob &&
    c.audienceIsBusinesses &&
    (c.paidCompetitorsMentioned || c.narrowEnoughForASmallApp);

  return {
    survived,
    reason: survived
      ? 'classified as a recurring paid business job'
      : 'classification found no recurring paid business job',
    spendUsd: res.estimatedCost,
    detail: { ...c, cached: res.cached, model: res.model },
  };
}

// --- stage 3: review / complaint analysis --------------------------------------------

const ComplaintSignal = z.object({
  recurringComplaintPresent: z.boolean(),
  complaintIsAboutTheJobNotTheVendor: z.boolean(),
  switchingIntentExpressed: z.boolean(),
  strongestComplaintTheme: z.string().max(160),
});

export const STAGE3_PROMPT_ID = 'research.stage3_complaint_analysis';
export const STAGE3_PROMPT_VERSION = 1;

const STAGE3_SYSTEM = [
  'You read customer reviews of existing paid software and report whether they',
  'contain a RECURRING complaint about the job itself rather than about one',
  'vendor being bad at support. Answer only the booleans asked for, from what',
  'the reviews literally say. If they do not say, answer false.',
].join(' ');

async function stageComplaintAnalysis(opp: OpportunityRow): Promise<StageOutcome> {
  const reviews = await readReviewTexts(opp.id);
  if (reviews.length === 0) {
    // Free elimination: no customer voice, nothing to analyse, nothing spent.
    return {
      survived: false,
      reason: 'no customer reviews on file to analyse',
      spendUsd: 0,
      detail: { reviewCount: 0 },
    };
  }

  const corpus = reviews.join('\n---\n').slice(0, MAX_REVIEW_CORPUS_CHARS);
  const res = await llmComplete({
    tier: 'fast',
    task: 'research.stage3_complaints',
    promptId: STAGE3_PROMPT_ID,
    promptVersion: STAGE3_PROMPT_VERSION,
    phase: 'RESEARCH',
    opportunityId: opp.id,
    schemaName: 'ComplaintSignal',
    schema: ComplaintSignal,
    maxTokens: 400,
    system: STAGE3_SYSTEM,
    user: [`Category: ${opp.category}`, `Reviews supplied: ${reviews.length}`].join('\n'),
    untrusted: { customer_reviews: corpus },
  });

  const c = res.data;
  const survived = c.recurringComplaintPresent && c.complaintIsAboutTheJobNotTheVendor;
  return {
    survived,
    reason: survived
      ? `recurring complaint about the job: ${c.strongestComplaintTheme}`
      : 'no recurring complaint about the job itself',
    spendUsd: res.estimatedCost,
    detail: { ...c, reviewCount: reviews.length, cached: res.cached },
  };
}

// --- stage 4: the reasoner, finalists only ---------------------------------------------

const FinalistAssessment = z.object({
  evidenceOfExistingSpend: z.boolean(),
  incumbentChargesMoney: z.boolean(),
  wedgeIsNarrowEnoughForATwoWeekBuild: z.boolean(),
  blockingRisk: z.string().max(300),
});

export const STAGE4_PROMPT_ID = 'research.stage4_finalist_assessment';
export const STAGE4_PROMPT_VERSION = 1;

const STAGE4_SYSTEM = [
  'You assess ONE finalist category that has already survived four cheaper',
  'filters. Report only what the collected evidence literally supports.',
  'Research is not validation: nothing you say moves this opportunity forward',
  'on its own, and you are never asked for a score.',
].join(' ');

async function stageFinalistAnalysis(opp: OpportunityRow): Promise<StageOutcome> {
  const competitors = await readCompetitors(opp.id);
  const reviews = await readReviewTexts(opp.id);

  const res = await llmComplete({
    tier: 'reasoner',
    task: 'research.stage4_finalist',
    promptId: STAGE4_PROMPT_ID,
    promptVersion: STAGE4_PROMPT_VERSION,
    phase: 'RESEARCH',
    opportunityId: opp.id,
    schemaName: 'FinalistAssessment',
    schema: FinalistAssessment,
    maxTokens: 900,
    system: STAGE4_SYSTEM,
    user: [
      `Category: ${opp.category}`,
      `Ecosystem: ${opp.ecosystem}`,
      `Competitors on file: ${competitors.length}`,
      `Reviews on file: ${reviews.length}`,
    ].join('\n'),
    untrusted: {
      competitor_listings: competitorCorpus(competitors) || '(none collected)',
      customer_reviews: reviews.join('\n---\n').slice(0, MAX_REVIEW_CORPUS_CHARS) || '(none collected)',
    },
  });

  const a = res.data;
  const survived = a.evidenceOfExistingSpend && a.incumbentChargesMoney && a.wedgeIsNarrowEnoughForATwoWeekBuild;
  return {
    survived,
    reason: survived
      ? 'finalist assessment found existing spend and a narrow wedge'
      : 'finalist assessment found no proof of existing spend on a narrow job',
    spendUsd: res.estimatedCost,
    detail: { ...a, cached: res.cached, model: res.model },
  };
}

const RUNNERS: Readonly<Record<ResearchStage, (opp: OpportunityRow) => Promise<StageOutcome>>> = {
  0: stageDeterministicFilter,
  1: stageCheapExtraction,
  2: stageFastClassification,
  3: stageComplaintAnalysis,
  4: stageFinalistAnalysis,
};

function isResearchStage(value: number): value is ResearchStage {
  return (RESEARCH_STAGES as readonly number[]).includes(value);
}

// --- spend attribution --------------------------------------------------------------

function currentPeriod(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/**
 * Books this stage's spend to the RESEARCH sub-budget. A zero-dollar row is
 * still written: "stage 0 cost nothing" is exactly the fact the ledger should
 * be able to prove.
 */
async function recordResearchSpend(
  opportunityId: string,
  spendUsd: number,
  detail: { stage: number },
): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO phase_spend (id, period, phase, opportunity_id, spend_usd)
     VALUES ($1,$2,'RESEARCH',$3,$4)`,
    [newId('phs'), currentPeriod(), opportunityId, Math.max(0, spendUsd)],
  );
  if (spendUsd > 0) {
    await db.query(
      `UPDATE opportunities
          SET research_spend_usd = research_spend_usd + $2, updated_at = now()
        WHERE id = $1`,
      [opportunityId, spendUsd],
    );
  }
  logger.debug('research spend recorded', { opportunityId, stage: detail.stage, spendUsd });
}

// --- the public entry points -----------------------------------------------------------

export interface AdvanceResult {
  fromStage: number;
  toStage: number;
  survived: boolean;
  reason: string;
}

/**
 * Runs the opportunity's CURRENT stage and moves it exactly one rung, or kills
 * it. Never skips, never re-enters a finished ladder, never writes
 * `opportunities.state`.
 */
export async function advanceResearchStage(opportunityId: string): Promise<AdvanceResult> {
  const db = await getDb();
  const opp = await readOpportunity(db, opportunityId);
  if (!opp) throw new AppError(`no opportunity ${opportunityId}`, 'OPPORTUNITY_NOT_FOUND');

  const fromStage = Number(opp.research_stage);

  if (fromStage === ELIMINATED_RESEARCH_STAGE) {
    return {
      fromStage,
      toStage: fromStage,
      survived: false,
      reason: 'already eliminated during staged research',
    };
  }
  if (fromStage >= COMPLETE_RESEARCH_STAGE) {
    return { fromStage, toStage: fromStage, survived: true, reason: 'all research stages complete' };
  }
  if (!isResearchStage(fromStage)) {
    throw new AppError(
      `opportunity ${opportunityId} has an out-of-range research stage ${fromStage}`,
      'RESEARCH_STAGE_INVALID',
    );
  }
  if (isOpportunityState(opp.state) && DEAD_STATES.has(opp.state)) {
    return {
      fromStage,
      toStage: fromStage,
      survived: false,
      reason: `opportunity is in the dead state ${opp.state}; no research spend`,
    };
  }

  const outcome = await RUNNERS[fromStage](opp);
  const toStage = outcome.survived ? fromStage + 1 : ELIMINATED_RESEARCH_STAGE;
  assertStageProgression(opportunityId, fromStage, toStage);

  await db.query(
    `UPDATE opportunities
        SET research_stage = $2, updated_at = now()
      WHERE id = $1`,
    [opportunityId, toStage],
  );

  await recordResearchSpend(opportunityId, outcome.spendUsd, { stage: fromStage });

  await recordAudit({
    entityType: 'opportunity',
    entityId: opportunityId,
    eventType: outcome.survived ? 'DECISION' : 'REJECTION',
    actor: 'research_staging',
    reason: outcome.reason.slice(0, 500),
    detail: {
      fromStage,
      toStage,
      survived: outcome.survived,
      spendUsd: outcome.spendUsd,
      ...outcome.detail,
    },
  });

  logger.info('research stage complete', {
    opportunityId,
    fromStage,
    toStage,
    survived: outcome.survived,
    spendUsd: outcome.spendUsd,
  });
  return { fromStage, toStage, survived: outcome.survived, reason: outcome.reason };
}

/**
 * Processes a batch, deepest-first: finishing a finalist is worth more than
 * starting the next unknown, and the cheap stages are cheap precisely so they
 * can wait.
 */
export async function runResearchStages(limit: number): Promise<{
  advanced: number;
  eliminated: number;
}> {
  const cfg = getConfig();
  const result = { advanced: 0, eliminated: 0 };
  if (cfg.killSwitch) {
    logger.warn('KILL_SWITCH is on; research staging skipped');
    return result;
  }
  const cap = Math.max(0, Math.trunc(limit));
  if (cap === 0) return result;

  const db = await getDb();
  const dead = [...DEAD_STATES];
  const placeholders = dead.map((_s, i) => `$${i + 3}`).join(',');
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM opportunities
      WHERE research_stage >= 0 AND research_stage <= $1
        AND state NOT IN (${placeholders})
      ORDER BY research_stage DESC, rank_score DESC, created_at ASC
      LIMIT $2`,
    [MAX_RESEARCH_STAGE, cap, ...dead],
  );

  for (const row of rows.rows) {
    try {
      const out = await advanceResearchStage(row.id);
      if (out.toStage === ELIMINATED_RESEARCH_STAGE) result.eliminated += 1;
      else if (out.toStage > out.fromStage) result.advanced += 1;
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        logger.warn('budget exhausted; research staging stopped', {
          opportunityId: row.id,
          processed: result.advanced + result.eliminated,
        });
        break;
      }
      logger.error('research stage failed', { opportunityId: row.id, err: String(err) });
    }
  }

  logger.info('research staging batch complete', result);
  return result;
}

/** Current ladder position for an opportunity. -1 eliminated, 5 complete. */
export async function researchStageOf(opportunityId: string): Promise<number> {
  const db = await getDb();
  const res = await db.query<{ research_stage: number }>(
    'SELECT research_stage FROM opportunities WHERE id = $1',
    [opportunityId],
  );
  return toNumber(res.rows[0]?.research_stage, 0);
}
