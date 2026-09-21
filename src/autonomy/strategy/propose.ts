/**
 * Hypothesis intake: the LLM proposes, CODE admits.
 *
 * The model is allowed to be imaginative here because it cannot act. Every
 * candidate it returns goes through `checkEligibility`, which is deterministic,
 * cheap, and runs BEFORE anything is spent on the idea. A proposal is refused
 * when it:
 *
 *   - names a control-plane field (that is an attempted privilege escalation,
 *     whether or not the model meant it that way);
 *   - duplicates a hypothesis already on record;
 *   - is structurally the same as something that already failed, with no
 *     material change;
 *   - has no budget to run in;
 *   - targets a test population that does not exist.
 *
 * Only proposals that survive all five get a strategy version, and therefore
 * only those can ever influence what the system does.
 */
import { z } from 'zod';
import { getConfig } from '../../lib/config';
import { count, getDb } from '../../lib/db';
import { hashObject, newId, slugify } from '../../lib/hash';
import { createLogger } from '../../lib/logger';
import { llmComplete } from '../../lib/llm/index';
import { hasBudget, monthStart } from '../../lib/cost';
import { recordAudit } from '../../lib/audit';
import { DEAD_STATES } from '../../lib/state-machine';
import { HypothesisProposal, STRATEGY_DIMENSIONS } from '../types';
import type { EligibilityVerdict, StrategyDimension } from '../types';
import { findForbiddenFields, findForbiddenMentions } from '../guard';
import { ensureArm } from './bandit';
import { findSimilarFailure, getSuccessBias, isAvoidedCategory } from './memory';
import { recordStrategyVersion } from './store';
import { normalizeTokens } from './util';

const logger = createLogger('strategy:propose');

export const PROPOSE_PROMPT_ID = 'strategy.propose';
export const PROPOSE_PROMPT_VERSION = 1;

/** Dimensions that can only be tested against live prospects. */
const LIVE_EXPERIMENT_DIMENSIONS: ReadonlySet<StrategyDimension> = new Set<StrategyDimension>([
  'ICP_SEGMENT',
  'POSITIONING',
  'PRICE_POINT',
  'MESSAGE_VARIANT',
  'CONTACT_ROLE',
  'SEND_TIME',
]);

// --- candidate extraction -----------------------------------------------------

function normalizeKey(key: string): string {
  return key.replace(/[\s_-]+/g, '').toLowerCase();
}

function pickString(record: Record<string, unknown>, names: readonly string[]): string | null {
  const wanted = new Set(names.map(normalizeKey));
  for (const [key, value] of Object.entries(record)) {
    if (!wanted.has(normalizeKey(key))) continue;
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function pickNumber(record: Record<string, unknown>, names: readonly string[]): number | null {
  const raw = pickString(record, names);
  if (raw === null) return null;
  const parsed = Number(raw.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export interface ProposalCandidate {
  category: string;
  icp: string | null;
  wedge: string;
  priceMonthly: number | null;
  armKey: string;
}

/** Reads the structured fields a proposal happens to carry, tolerantly. */
export function candidateFrom(p: HypothesisProposal): ProposalCandidate {
  const record = p.proposal ?? {};
  const category = pickString(record, ['category', 'categoryFamily', 'family', 'niche', 'vertical']) ?? '';
  const icp = pickString(record, ['icp', 'icpSegment', 'segment', 'targetCustomer', 'audience', 'customer']);
  const wedge =
    pickString(record, ['wedge', 'wedgeType', 'positioning', 'valueProposition', 'angle', 'offer']) ??
    p.hypothesis;
  const priceMonthly = pickNumber(record, ['price', 'priceMonthly', 'pricePoint', 'monthlyPrice', 'priceUsd']);
  const armKey =
    slugify(pickString(record, ['armKey', 'arm', 'key', 'name', 'variant']) ?? p.hypothesis) || 'unnamed';
  return { category, icp, wedge, priceMonthly, armKey };
}

/**
 * The dedupe key. Normalized so that re-wording the same idea does not buy it a
 * second run at the budget.
 */
export function contentKeyFor(p: HypothesisProposal): string {
  return hashObject({
    dimension: p.dimension,
    hypothesis: normalizeTokens(p.hypothesis).join(' '),
    proposal: p.proposal ?? {},
  });
}

// --- eligibility ---------------------------------------------------------------

async function populationProblem(p: HypothesisProposal): Promise<string | null> {
  const db = await getDb();

  if (LIVE_EXPERIMENT_DIMENSIONS.has(p.dimension)) {
    const dead = [...DEAD_STATES].map((s) => `'${s}'`).join(',');
    const alive = await count(
      `SELECT COUNT(*) AS n FROM opportunities WHERE state NOT IN (${dead})`,
    );
    if (alive === 0) {
      return 'the proposed test population does not exist: there is no live opportunity to run this experiment against';
    }
  }

  if (p.dimension === 'CONTACT_ROLE') {
    const reachable = await count(
      `SELECT COUNT(*) AS n FROM prospects WHERE contact_email IS NOT NULL AND email_is_public`,
    );
    if (reachable === 0) {
      return 'the proposed test population does not exist: no prospect has a public contact address to vary the role on';
    }
  }

  if (p.dimension === 'RESEARCH_SOURCE') {
    const named = pickString(p.proposal ?? {}, ['source', 'sourceName', 'name', 'registry']);
    if (named) {
      const res = await db.query<{ status: string; enabled: boolean }>(
        'SELECT status, enabled FROM source_registry WHERE lower(name) = lower($1)',
        [named],
      );
      const row = res.rows[0];
      if (row && (row.enabled !== true || row.status === 'REJECTED' || row.status === 'DISABLED')) {
        return `the proposed test population does not exist: source "${named}" is ${row.status.toLowerCase()} and disabled`;
      }
    }
  }
  return null;
}

async function budgetProblem(): Promise<string | null> {
  const cfg = getConfig();
  if (!(await hasBudget('LLM'))) {
    return 'no budget remains: the monthly LLM budget is exhausted';
  }
  const admittedThisMonth = await count(
    `SELECT COUNT(*) AS n FROM strategy_hypotheses
      WHERE status = 'ADMITTED' AND admitted_at >= $1`,
    [monthStart().toISOString()],
  );
  if (admittedThisMonth >= cfg.concurrency.maxMonthlyExperiments) {
    return `no budget remains: ${admittedThisMonth} experiments already admitted this month (cap ${cfg.concurrency.maxMonthlyExperiments})`;
  }
  return null;
}

/** Deterministic admission check. Runs BEFORE anything is spent on a proposal. */
export async function checkEligibility(p: HypothesisProposal): Promise<EligibilityVerdict> {
  const reasons: string[] = [];
  let similarTo: string | null = null;

  // 1. Control plane. Checked in the structured proposal AND in the prose,
  //    because "we should raise max emails per day" is the same request.
  const forbiddenKeys = findForbiddenFields(p.proposal ?? {});
  const forbiddenMentions = findForbiddenMentions(
    [p.hypothesis, p.reason, p.expectedBenefit, p.experimentScope].join(' \n '),
  );
  const forbidden = [...new Set([...forbiddenKeys, ...forbiddenMentions])];
  if (forbidden.length > 0) {
    reasons.push(
      `names control-plane field(s) the strategy plane may not touch: ${forbidden.join(', ')}`,
    );
  }

  // 2. Duplicate.
  const contentKey = contentKeyFor(p);
  const duplicates = await count('SELECT COUNT(*) AS n FROM strategy_hypotheses WHERE content_key = $1', [
    contentKey,
  ]);
  if (duplicates > 0) {
    reasons.push('duplicates a hypothesis already on record (same dimension, same idea)');
  }

  // 3. Structurally identical to a past failure, with nothing material changed.
  const candidate = candidateFrom(p);
  const similar = await findSimilarFailure({
    category: candidate.category,
    icp: candidate.icp,
    wedge: candidate.wedge,
    priceMonthly: candidate.priceMonthly,
  });
  if (similar) {
    similarTo = similar.failure.id;
    reasons.push(
      `substantially identical to failure ${similar.failure.id} ` +
        `(similarity ${similar.similarity.toFixed(2)}, failed: ${similar.failure.reasonFailed}) ` +
        'with no material change to ICP, price, wedge type or channel',
    );
  }
  if (candidate.category !== '') {
    const avoided = await isAvoidedCategory(candidate.category);
    if (avoided) {
      similarTo = similarTo ?? avoided.id;
      reasons.push(`category "${candidate.category}" was marked avoid-category by post-mortem ${avoided.id}`);
    }
  }

  // 4. Budget.
  const budget = await budgetProblem();
  if (budget) reasons.push(budget);

  // 5. Test population.
  const population = await populationProblem(p);
  if (population) reasons.push(population);

  return { eligible: reasons.length === 0, reasons, similarTo };
}

// --- proposal generation --------------------------------------------------------

const ProposalBatch = z.object({
  proposals: z.array(HypothesisProposal),
});

function systemPrompt(): string {
  return [
    'You propose experiments for an autonomous micro-SaaS validation system.',
    '',
    'You are proposing STRATEGY only. The strategy plane is: which categories and',
    'query families to search, which ICP segment to aim at, how to position the',
    'offer, what price to test, message and landing variants, which contact role',
    'to write to, and what time to send.',
    '',
    'You may NEVER propose changing the control plane. That includes validation',
    'thresholds, budgets and cost ceilings, daily or per-campaign send limits,',
    'follow-up counts, allowed countries, bounce or complaint limits, suppression,',
    'cooldowns, credentials, or any safety switch. A proposal that names one is',
    'discarded by code before it is read, so naming one only wastes your slot.',
    '',
    'Ground every proposal in the MEASURED results supplied below. Reply rates and',
    'commitments are evidence. Your own confidence is not evidence, and no part of',
    'your answer is treated as proof that an idea is good — a deterministic gate',
    'admits or rejects each one, and only real downstream outcomes score it later.',
    '',
    'Each proposal must name a concrete, falsifiable change and the population it',
    'would be tested on. "Try better messaging" is not a hypothesis.',
  ].join('\n');
}

interface ProposeContext {
  failures: Array<{ category: string; reason: string; sampleSize: number }>;
  successTokens: string[];
  armSummary: Array<{ dimension: string; arms: number; bestMean: number | null }>;
}

async function loadContext(): Promise<ProposeContext> {
  const db = await getDb();
  const failures = await db.query<{ category: string; reason_failed: string; sample_size: string | number }>(
    'SELECT category, reason_failed, sample_size FROM failure_memory ORDER BY created_at DESC LIMIT 20',
  );
  const arms = await db.query<{ dimension: string; n: string | number; best: string | number | null }>(
    `SELECT dimension, COUNT(*) AS n, MAX(alpha / (alpha + beta)) AS best
       FROM bandit_arms WHERE enabled GROUP BY dimension`,
  );
  const bias = await getSuccessBias();
  return {
    failures: failures.rows.map((r) => ({
      category: r.category,
      reason: r.reason_failed,
      sampleSize: Number(r.sample_size),
    })),
    successTokens: bias.tokens,
    armSummary: arms.rows.map((r) => ({
      dimension: r.dimension,
      arms: Number(r.n),
      bestMean: r.best === null ? null : Number(r.best),
    })),
  };
}

function userPrompt(limit: number, ctx: ProposeContext): string {
  const failureLines = ctx.failures.length
    ? ctx.failures
        .map((f) => `- ${f.category}: ${f.reason} (sample ${f.sampleSize})`)
        .join('\n')
    : '- (nothing has failed yet)';
  const armLines = ctx.armSummary.length
    ? ctx.armSummary
        .map(
          (a) =>
            `- ${a.dimension}: ${a.arms} arm(s), best posterior mean ${
              a.bestMean === null ? 'n/a' : a.bestMean.toFixed(3)
            }`,
        )
        .join('\n')
    : '- (no arms have been tried yet)';

  return [
    `Propose at most ${limit} experiments, each on one of these dimensions:`,
    STRATEGY_DIMENSIONS.join(', '),
    '',
    'Ideas that have already been tested and died (do not re-propose these unless',
    'you change the ICP, the price by at least half, the wedge type, or the channel):',
    failureLines,
    '',
    'Current allocation state, measured from downstream commitments:',
    armLines,
    '',
    ctx.successTokens.length
      ? `Patterns that have actually produced commitments: ${ctx.successTokens.slice(0, 25).join(', ')}.`
      : 'Nothing has produced a commitment yet, so no pattern is established.',
    '',
    'For each proposal set: dimension, hypothesis, reason, expectedBenefit,',
    'experimentScope, and a `proposal` object holding the concrete configuration',
    '(for example: category, icp, positioning, price, armKey).',
  ].join('\n');
}

export async function proposeHypotheses(limit: number): Promise<{
  proposed: number;
  admitted: number;
  rejected: Array<{ hypothesis: string; reasons: string[] }>;
}> {
  const rejected: Array<{ hypothesis: string; reasons: string[] }> = [];
  if (!Number.isFinite(limit) || limit <= 0) return { proposed: 0, admitted: 0, rejected };

  // Never spend the generation call when there is nothing left to spend it on.
  const budget = await budgetProblem();
  if (budget) {
    logger.warn('skipping hypothesis generation', { reason: budget });
    return { proposed: 0, admitted: 0, rejected };
  }

  const ctx = await loadContext();
  let candidates: HypothesisProposal[] = [];
  try {
    const res = await llmComplete({
      tier: 'reasoner',
      task: PROPOSE_PROMPT_ID,
      promptId: PROPOSE_PROMPT_ID,
      promptVersion: PROPOSE_PROMPT_VERSION,
      phase: 'RESEARCH',
      schemaName: 'StrategyProposalBatch',
      schema: ProposalBatch,
      system: systemPrompt(),
      user: userPrompt(limit, ctx),
      maxTokens: 2000,
      // Each run should look at the newest measured state, not replay a cached
      // answer produced before the last three campaigns finished.
      cacheable: false,
    });
    candidates = res.data.proposals.slice(0, limit);
  } catch (err) {
    logger.warn('hypothesis generation failed; no proposals this round', { err: String(err) });
    return { proposed: 0, admitted: 0, rejected };
  }

  let admitted = 0;
  for (const proposal of candidates) {
    const verdict = await checkEligibility(proposal);
    const stored = await storeHypothesis(proposal, verdict);
    if (!stored) {
      rejected.push({ hypothesis: proposal.hypothesis, reasons: ['duplicates a hypothesis already on record'] });
      continue;
    }
    if (!verdict.eligible) {
      rejected.push({ hypothesis: proposal.hypothesis, reasons: verdict.reasons });
      continue;
    }
    const applied = await admit(stored, proposal);
    if (applied) admitted += 1;
    else rejected.push({ hypothesis: proposal.hypothesis, reasons: ['could not be applied to the strategy plane'] });
  }

  logger.info('hypothesis round complete', {
    proposed: candidates.length,
    admitted,
    rejected: rejected.length,
  });
  return { proposed: candidates.length, admitted, rejected };
}

/** Writes the proposal down whatever the verdict. A rejection with no record is not a memory. */
async function storeHypothesis(p: HypothesisProposal, verdict: EligibilityVerdict): Promise<string | null> {
  const db = await getDb();
  const id = newId('hyp');
  const res = await db.query<{ id: string }>(
    `INSERT INTO strategy_hypotheses
       (id, dimension, proposal_json, hypothesis, reason, expected_benefit, experiment_scope,
        proposed_by, status, rejection_reason, similarity_to, content_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (content_key) DO NOTHING
     RETURNING id`,
    [
      id,
      p.dimension,
      JSON.stringify(p.proposal ?? {}),
      p.hypothesis,
      p.reason,
      p.expectedBenefit,
      p.experimentScope,
      `llm:${PROPOSE_PROMPT_ID}@${PROPOSE_PROMPT_VERSION}`,
      verdict.eligible ? 'PROPOSED' : 'REJECTED',
      verdict.eligible ? null : verdict.reasons.join(' | '),
      verdict.similarTo ?? null,
      contentKeyFor(p),
    ],
  );
  const stored = res.rows[0]?.id ?? null;
  if (stored && !verdict.eligible) {
    await recordAudit({
      entityType: 'system',
      eventType: 'REJECTION',
      actor: 'strategy:propose',
      reason: verdict.reasons.join(' | '),
      detail: { hypothesisId: stored, dimension: p.dimension, similarTo: verdict.similarTo ?? null },
    });
  }
  return stored;
}

/** Admission: an arm to allocate to, and a versioned config describing it. */
async function admit(hypothesisId: string, p: HypothesisProposal): Promise<boolean> {
  const candidate = candidateFrom(p);
  try {
    await recordStrategyVersion({
      dimension: p.dimension,
      armKey: candidate.armKey,
      config: p.proposal ?? {},
      reason: p.reason,
      hypothesisId,
    });
    await ensureArm(p.dimension, candidate.armKey);
  } catch (err) {
    logger.error('admitted hypothesis could not be applied', { hypothesisId, err: String(err) });
    const db = await getDb();
    await db.query(
      `UPDATE strategy_hypotheses SET status = 'REJECTED', rejection_reason = $2 WHERE id = $1`,
      [hypothesisId, `could not be applied: ${String(err)}`.slice(0, 500)],
    );
    return false;
  }
  const db = await getDb();
  await db.query(
    `UPDATE strategy_hypotheses SET status = 'ADMITTED', admitted_at = now() WHERE id = $1`,
    [hypothesisId],
  );
  await recordAudit({
    entityType: 'system',
    eventType: 'DECISION',
    actor: 'strategy:propose',
    reason: p.reason,
    detail: { hypothesisId, dimension: p.dimension, armKey: candidate.armKey },
  });
  return true;
}
