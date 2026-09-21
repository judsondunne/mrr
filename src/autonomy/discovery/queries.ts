/**
 * Adaptive query families — how the system stops depending on a frozen list.
 *
 * Generation 0 is the curated Shopify seed list that discovery already ships
 * (imported, never copied). Every later generation is DERIVED from a family
 * that actually produced verified categories, so the search surface grows in
 * the direction the downstream funnel says is real.
 *
 * The division of labour is absolute:
 *   - the FAST LLM tier may invent SEARCH TEXT (synonyms, adjacent workflows,
 *     complaint phrasings, "alternative to X", "too expensive", ...).
 *   - nothing it returns is trusted as a number. Every score in this file is
 *     computed by `computeFamilyScore()` from counters the funnel wrote.
 *
 * A family that produces junk is DEPRIORITIZED, never deleted: its score falls
 * below `FAMILY_SELECTION_FLOOR` so `nextQueries()` stops picking it, and the
 * row stays so a later outcome can lift it back.
 */
import { z } from 'zod';
import { recordAudit } from '../../lib/audit';
import { getDb, toNumber, type Db } from '../../lib/db';
import { BudgetExceededError } from '../../lib/errors';
import { newId, slugify } from '../../lib/hash';
import { llmComplete } from '../../lib/llm/index';
import { createLogger } from '../../lib/logger';
import {
  SHOPIFY_ECOSYSTEM,
  SHOPIFY_SEED_CATEGORIES,
} from '../../pipeline/discovery/shopify';

const logger = createLogger('autonomy:queries');

// --- public shape -------------------------------------------------------------

export interface QueryFamily {
  id: string;
  family: string;
  ecosystem: string | null;
  template: string;
  seeds: string[];
  generation: number;
  enabled: boolean;
  score: number;
}

/** A family plus the counters the deterministic score is computed from. */
export interface QueryFamilyState extends QueryFamily {
  derivedFrom: string | null;
  queriesIssued: number;
  candidatesFound: number;
  categoriesVerified: number;
  commitments: number;
  junkRate: number;
}

// --- deterministic scoring ------------------------------------------------------

/**
 * Weights for the family score. Downstream truth outranks upstream volume:
 * a verified category is worth more than a pile of candidates, and a
 * commitment is worth more still per query issued.
 */
export const QUERY_SCORE_WEIGHTS = {
  verifiedPerQuery: 0.5,
  commitmentPerQuery: 0.3,
  candidatePerQuery: 0.2,
  junkPenalty: 0.6,
} as const;

/** An unproven family starts here: plausible, but beaten by anything proven. */
export const BASE_FAMILY_SCORE = 0.5;

/** Below this a family is parked. It is not deleted and can come back. */
export const FAMILY_SELECTION_FLOOR = 0.2;

/** Candidates-per-query that counts as a full-volume query. */
export const CANDIDATES_PER_QUERY_TARGET = 8;

/** Until this many queries have been issued the prior still carries weight. */
export const MIN_QUERIES_FOR_FULL_CONFIDENCE = 3;

/** A child inherits this fraction of its parent's proven score. */
export const CHILD_SCORE_INHERITANCE = 0.8;

/** Derivation depth ceiling, so expansion cannot wander forever. */
export const MAX_FAMILY_GENERATION = 4;

/** Parents considered per expansion pass. */
export const MAX_PARENTS_PER_EXPANSION = 3;

const SEED_TEMPLATE = '{seed}';

export interface QueryFamilyCounters {
  queriesIssued: number;
  candidatesFound: number;
  categoriesVerified: number;
  commitments: number;
  junkRate: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
function round(value: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}

/**
 * PURE. Same counters in, same score out, forever. No LLM, no randomness, no
 * clock. This is the only place a family's score is decided.
 */
export function computeFamilyScore(c: QueryFamilyCounters): number {
  const issued = Math.max(0, c.queriesIssued);
  if (issued === 0) return BASE_FAMILY_SCORE;

  const verifiedRate = clamp(c.categoriesVerified / issued, 0, 1);
  const commitmentRate = clamp(c.commitments / issued, 0, 1);
  const candidateRate = clamp(c.candidatesFound / (issued * CANDIDATES_PER_QUERY_TARGET), 0, 1);

  const earned =
    QUERY_SCORE_WEIGHTS.verifiedPerQuery * verifiedRate +
    QUERY_SCORE_WEIGHTS.commitmentPerQuery * commitmentRate +
    QUERY_SCORE_WEIGHTS.candidatePerQuery * candidateRate;

  // One barren query must not bury a family before it has had a fair trial,
  // so the prior decays in only as evidence accumulates.
  const confidence = clamp(issued / MIN_QUERIES_FOR_FULL_CONFIDENCE, 0, 1);
  const blended = BASE_FAMILY_SCORE * (1 - confidence) + earned * confidence;
  const penalty = QUERY_SCORE_WEIGHTS.junkPenalty * clamp(c.junkRate, 0, 1) * confidence;

  return round(clamp(blended - penalty, 0, 1), 5);
}

/** PURE. Where a newly derived family starts, given its parent's score. */
export function childInitialScore(parentScore: number): number {
  const inherited = clamp(parentScore, 0, 1) * CHILD_SCORE_INHERITANCE;
  return round(clamp(Math.max(inherited, FAMILY_SELECTION_FLOOR + 0.05), 0, 1), 5);
}

/** PURE. Running junk ratio over all candidates this family has produced. */
export function nextJunkRate(
  previousRate: number,
  previousCandidates: number,
  candidatesFound: number,
  junk: number,
): number {
  const observed = Math.max(0, Math.trunc(candidatesFound));
  const bad = clamp(Math.trunc(junk), 0, observed);
  const total = Math.max(0, previousCandidates) + observed;
  if (total === 0) return round(clamp(previousRate, 0, 1), 4);
  const previousBad = clamp(previousRate, 0, 1) * Math.max(0, previousCandidates);
  return round(clamp((previousBad + bad) / total, 0, 1), 4);
}

// --- rendering ------------------------------------------------------------------

const MAX_QUERY_CHARS = 200;

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** PURE. Renders one concrete search string from a family template + seed. */
export function renderQuery(template: string, seed: string): string {
  const base = template.includes('{seed}')
    ? template.split('{seed}').join(seed)
    : `${template} ${seed}`;
  return collapse(base).slice(0, MAX_QUERY_CHARS);
}

// --- persistence ----------------------------------------------------------------

interface FamilyRow {
  id: string;
  family: string;
  ecosystem: string | null;
  template: string;
  seeds_json: unknown;
  derived_from: string | null;
  generation: number;
  enabled: boolean;
  queries_issued: number;
  candidates_found: number;
  categories_verified: number;
  commitments: number;
  junk_rate: string | number;
  score: string | number;
}

function readSeeds(value: unknown): string[] {
  const raw = typeof value === 'string' ? safeParse(value) : value;
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map(collapse);
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

function toState(row: FamilyRow): QueryFamilyState {
  return {
    id: row.id,
    family: row.family,
    ecosystem: row.ecosystem,
    template: row.template,
    seeds: readSeeds(row.seeds_json),
    generation: Number(row.generation),
    enabled: row.enabled === true,
    score: toNumber(row.score, 0),
    derivedFrom: row.derived_from,
    queriesIssued: Number(row.queries_issued),
    candidatesFound: Number(row.candidates_found),
    categoriesVerified: Number(row.categories_verified),
    commitments: Number(row.commitments),
    junkRate: toNumber(row.junk_rate, 0),
  };
}

const SELECT_FAMILY = `SELECT id, family, ecosystem, template, seeds_json, derived_from, generation,
         enabled, queries_issued, candidates_found, categories_verified, commitments,
         junk_rate, score
    FROM research_query_families`;

/** Ordered best-first, with a stable tiebreak so selection is reproducible. */
export async function listQueryFamilies(
  opts: { enabledOnly?: boolean } = {},
): Promise<QueryFamilyState[]> {
  const db = await getDb();
  const where = opts.enabledOnly ? ' WHERE enabled' : '';
  const res = await db.query<FamilyRow>(
    `${SELECT_FAMILY}${where} ORDER BY score DESC, generation ASC, family ASC`,
  );
  return res.rows.map(toState);
}

async function readFamily(db: Db, familyId: string): Promise<QueryFamilyState | null> {
  const res = await db.query<FamilyRow>(`${SELECT_FAMILY} WHERE id = $1`, [familyId]);
  const row = res.rows[0];
  return row ? toState(row) : null;
}

// --- seeding ---------------------------------------------------------------------

export function familyKey(ecosystem: string, label: string): string {
  return `${ecosystem.trim().toLowerCase()}:${slugify(label)}`;
}

/**
 * Generation 0 from the existing curated Shopify seeds. The list is IMPORTED
 * from the discovery layer, never duplicated, so there is exactly one place a
 * human edits a seed category.
 *
 * Idempotent: `research_query_families.family` is UNIQUE, so a second call
 * creates nothing.
 */
export async function seedQueryFamilies(): Promise<{ created: number }> {
  const db = await getDb();
  let created = 0;

  for (const seed of SHOPIFY_SEED_CATEGORIES) {
    const key = familyKey(SHOPIFY_ECOSYSTEM, seed.slug);
    const res = await db.query<{ id: string }>(
      `INSERT INTO research_query_families
         (id, family, ecosystem, template, seeds_json, generation, score)
       VALUES ($1,$2,$3,$4,$5,0,$6)
       ON CONFLICT (family) DO NOTHING
       RETURNING id`,
      [newId('qf'), key, SHOPIFY_ECOSYSTEM, SEED_TEMPLATE, JSON.stringify([seed.query]), BASE_FAMILY_SCORE],
    );
    if (res.rows[0]) created += 1;
  }

  if (created > 0) {
    await recordAudit({
      entityType: 'system',
      eventType: 'DECISION',
      actor: 'seed_query_families',
      reason: 'generation 0 seeded from the curated marketplace seed list',
      detail: { created, ecosystem: SHOPIFY_ECOSYSTEM, source: 'SHOPIFY_SEED_CATEGORIES' },
    });
  }
  logger.info('query families seeded', { created });
  return { created };
}

// --- selection --------------------------------------------------------------------

/**
 * PURE. Largest-remainder apportionment of `cap` query slots across families,
 * weighted by score and capped by how many distinct seeds each family holds.
 */
export function allocateSlots(
  families: Array<{ id: string; score: number; seedCount: number }>,
  cap: number,
): Map<string, number> {
  const out = new Map<string, number>();
  if (cap <= 0 || families.length === 0) return out;

  const weights = families.map((f) => Math.max(f.score, 0.01));
  const total = weights.reduce((sum, w) => sum + w, 0);

  const exact = families.map((f, i) => (cap * (weights[i] ?? 0)) / total);
  let assigned = 0;
  families.forEach((f, i) => {
    const whole = Math.min(Math.floor(exact[i] ?? 0), f.seedCount);
    out.set(f.id, whole);
    assigned += whole;
  });

  // Hand out what rounding left over, biggest fractional part first.
  const remainders = families
    .map((f, i) => ({ id: f.id, seedCount: f.seedCount, frac: (exact[i] ?? 0) % 1, order: i }))
    .sort((a, b) => b.frac - a.frac || a.order - b.order);

  let guard = families.length * 2;
  while (assigned < cap && guard-- > 0) {
    let progressed = false;
    for (const r of remainders) {
      if (assigned >= cap) break;
      const current = out.get(r.id) ?? 0;
      if (current >= r.seedCount) continue;
      out.set(r.id, current + 1);
      assigned += 1;
      progressed = true;
    }
    if (!progressed) break;
  }
  return out;
}

/**
 * Concrete queries to issue next, weighted by family score.
 *
 * Families below the floor are skipped entirely — that is what "deprioritized"
 * means in practice. The single exception is a total stall (nothing above the
 * floor at all), where the best of a bad set is still better than issuing
 * nothing and never learning anything new.
 */
export async function nextQueries(limit: number): Promise<Array<{ familyId: string; query: string }>> {
  const cap = Math.max(0, Math.trunc(limit));
  if (cap === 0) return [];

  const families = await listQueryFamilies({ enabledOnly: true });
  if (families.length === 0) return [];

  const above = families.filter((f) => f.score >= FAMILY_SELECTION_FLOOR && f.seeds.length > 0);
  const pool = above.length > 0 ? above : families.filter((f) => f.seeds.length > 0);
  if (pool.length === 0) return [];
  if (above.length === 0) {
    logger.warn('every query family is below the selection floor; using the best of them', {
      families: pool.length,
    });
  }

  const slots = allocateSlots(
    pool.map((f) => ({ id: f.id, score: f.score, seedCount: f.seeds.length })),
    cap,
  );

  const out: Array<{ familyId: string; query: string }> = [];
  const seen = new Set<string>();
  for (const family of pool) {
    const take = slots.get(family.id) ?? 0;
    // Rotate through the seed list so repeated passes do not re-issue the
    // same phrase while other seeds in the family go untried.
    const offset = family.seeds.length > 0 ? family.queriesIssued % family.seeds.length : 0;
    for (let i = 0; i < take && out.length < cap; i++) {
      const seed = family.seeds[(offset + i) % family.seeds.length];
      if (!seed) continue;
      const query = renderQuery(family.template, seed);
      if (query.length === 0 || seen.has(query)) continue;
      seen.add(query);
      out.push({ familyId: family.id, query });
    }
  }
  return out;
}

// --- outcomes -----------------------------------------------------------------------

/**
 * Records the result of ONE issued query and recomputes the family's score.
 *
 * `junk` is the subset of `candidatesFound` that turned out to be useless; it
 * is clamped into range rather than trusted.
 */
export async function recordQueryOutcome(params: {
  familyId: string;
  candidatesFound: number;
  junk: number;
  categoriesVerified?: number;
  commitments?: number;
}): Promise<void> {
  const db = await getDb();
  await db.transaction(async (tx) => {
    const current = await readFamily(tx, params.familyId);
    if (!current) {
      logger.warn('outcome recorded for an unknown query family', { familyId: params.familyId });
      return;
    }

    const counters: QueryFamilyCounters = {
      queriesIssued: current.queriesIssued + 1,
      candidatesFound: current.candidatesFound + Math.max(0, Math.trunc(params.candidatesFound)),
      categoriesVerified: current.categoriesVerified + Math.max(0, Math.trunc(params.categoriesVerified ?? 0)),
      commitments: current.commitments + Math.max(0, Math.trunc(params.commitments ?? 0)),
      junkRate: nextJunkRate(
        current.junkRate,
        current.candidatesFound,
        params.candidatesFound,
        params.junk,
      ),
    };
    const score = computeFamilyScore(counters);

    await tx.query(
      `UPDATE research_query_families
          SET queries_issued = $2, candidates_found = $3, categories_verified = $4,
              commitments = $5, junk_rate = $6, score = $7, updated_at = now()
        WHERE id = $1`,
      [
        params.familyId,
        counters.queriesIssued,
        counters.candidatesFound,
        counters.categoriesVerified,
        counters.commitments,
        counters.junkRate,
        score,
      ],
    );

    logger.debug('query family outcome recorded', {
      family: current.family,
      score,
      junkRate: counters.junkRate,
    });
  });
}

// --- expansion -------------------------------------------------------------------------

/**
 * The angles expansion is allowed to explore. Naming them constrains the model
 * to linguistic work and makes the resulting families auditable.
 */
export const QUERY_ANGLES = [
  'SYNONYM',
  'ADJACENT_WORKFLOW',
  'COMPETITOR',
  'COMPLAINT',
  'ALTERNATIVE_TO',
  'PRICING_PAIN',
  'MANUAL_PROCESS',
  'PLATFORM_APP',
  'HOW_DO_I',
  'MERCHANT_OPERATION',
  'MARKETPLACE_CATEGORY',
] as const;
export type QueryAngle = (typeof QUERY_ANGLES)[number];

const QueryFamilyProposal = z.object({
  label: z.string().min(3).max(80),
  angle: z.enum(QUERY_ANGLES),
  template: z.string().min(1).max(120),
  seeds: z.array(z.string().min(3).max(140)).min(1).max(6),
});

const QueryExpansion = z.object({
  families: z.array(QueryFamilyProposal).max(8),
});
type QueryFamilyProposal = z.infer<typeof QueryFamilyProposal>;

export const QUERY_EXPANSION_PROMPT_ID = 'discovery.query_family_expansion';
export const QUERY_EXPANSION_PROMPT_VERSION = 1;

const EXPANSION_SYSTEM = [
  'You expand ONE family of web-search queries into new, related families.',
  'You produce SEARCH TEXT ONLY. You never score, rank, prioritize, or decide',
  'anything; the caller computes every number itself and ignores any you emit.',
  'Each family needs one clear angle drawn from the allowed list, a template',
  'containing the literal placeholder {seed}, and short literal search phrases',
  'a real small-business owner or marketplace page would actually use.',
  'Keep phrases under twelve words. No URLs, no punctuation tricks, no brackets.',
  'Prefer concrete recurring business jobs over abstract market language.',
].join(' ');

/** Text that never belongs in a search query we are about to issue. */
const UNSAFE_QUERY_TEXT = /(https?:\/\/|www\.|[<>{}[\]|]|ignore .{0,20}(previous|prior|above)|system prompt|api[_ -]?key|password)/i;

/** PURE. Normalizes and screens one model proposal. Returns null when unusable. */
export function sanitizeProposal(
  proposal: QueryFamilyProposal,
): { label: string; angle: QueryAngle; template: string; seeds: string[] } | null {
  const label = collapse(proposal.label);
  if (slugify(label).length < 3) return null;

  const rawTemplate = collapse(proposal.template);
  const template =
    rawTemplate.includes('{seed}') && !UNSAFE_QUERY_TEXT.test(rawTemplate.split('{seed}').join(' '))
      ? rawTemplate.slice(0, 120)
      : SEED_TEMPLATE;

  const seeds: string[] = [];
  for (const raw of proposal.seeds) {
    const seed = collapse(raw).toLowerCase();
    if (seed.length < 3 || seed.length > 140) continue;
    if (UNSAFE_QUERY_TEXT.test(seed)) continue;
    if (seed.split(' ').length > 14) continue;
    if (!seeds.includes(seed)) seeds.push(seed);
  }
  if (seeds.length === 0) return null;

  return { label, angle: proposal.angle, template, seeds: seeds.slice(0, 6) };
}

/**
 * External strings that inform expansion: competitor names scraped from
 * marketplace listings, complaint phrasing lifted from reviews, and the
 * category names the marketplaces themselves surfaced.
 *
 * All of it is UNTRUSTED. It goes through `llmComplete`'s `untrusted` field,
 * never concatenated into the prompt.
 */
async function untrustedContext(ecosystem: string | null): Promise<Record<string, string>> {
  const db = await getDb();
  const out: Record<string, string> = {};

  const competitors = await db.query<{ name: string }>(
    `SELECT DISTINCT c.name
       FROM competitors c
       JOIN opportunities o ON o.id = c.opportunity_id
      WHERE ($1::text IS NULL OR o.ecosystem = $1)
      ORDER BY c.name
      LIMIT 25`,
    [ecosystem],
  );
  if (competitors.rows.length > 0) {
    out.competitor_names = competitors.rows.map((r) => r.name).join('\n').slice(0, 2000);
  }

  const complaints = await db.query<{ text: string }>(
    `SELECT r.text
       FROM reviews r
      WHERE r.complaint_tags IS NOT NULL AND r.text <> ''
      ORDER BY r.created_at DESC
      LIMIT 15`,
  );
  if (complaints.rows.length > 0) {
    out.complaint_phrases = complaints.rows
      .map((r) => collapse(r.text).slice(0, 300))
      .join('\n')
      .slice(0, 3000);
  }

  const categories = await db.query<{ category: string }>(
    `SELECT DISTINCT category FROM opportunities
      WHERE ($1::text IS NULL OR ecosystem = $1)
      ORDER BY category LIMIT 40`,
    [ecosystem],
  );
  if (categories.rows.length > 0) {
    out.marketplace_categories = categories.rows.map((r) => r.category).join('\n').slice(0, 2000);
  }

  return out;
}

async function proposeExpansions(parent: QueryFamilyState): Promise<QueryFamilyProposal[]> {
  const user = [
    `Parent family: ${parent.family}`,
    `Ecosystem: ${parent.ecosystem ?? 'unspecified'}`,
    `Template: ${parent.template}`,
    `Existing seeds:\n${parent.seeds.map((s) => `- ${s}`).join('\n')}`,
    '',
    `Allowed angles: ${QUERY_ANGLES.join(', ')}`,
    'Propose up to 4 NEW families that would surface DIFFERENT businesses or',
    'different phrasings of the same recurring job. Do not restate the parent.',
  ].join('\n');

  const res = await llmComplete({
    tier: 'fast',
    task: 'discovery.query_family_expansion',
    promptId: QUERY_EXPANSION_PROMPT_ID,
    promptVersion: QUERY_EXPANSION_PROMPT_VERSION,
    phase: 'DISCOVERY',
    schemaName: 'QueryExpansion',
    schema: QueryExpansion,
    maxTokens: 900,
    system: EXPANSION_SYSTEM,
    user,
    untrusted: await untrustedContext(parent.ecosystem),
  });
  return res.data.families;
}

async function insertChild(
  parent: QueryFamilyState,
  proposal: { label: string; angle: QueryAngle; template: string; seeds: string[] },
): Promise<string | null> {
  const db = await getDb();
  const ecosystem = parent.ecosystem ?? 'generic';
  const key = familyKey(ecosystem, `g${parent.generation + 1}-${proposal.angle}-${proposal.label}`);

  const res = await db.query<{ id: string }>(
    `INSERT INTO research_query_families
       (id, family, ecosystem, template, seeds_json, derived_from, generation, score)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (family) DO NOTHING
     RETURNING id`,
    [
      newId('qf'),
      key,
      parent.ecosystem,
      proposal.template,
      JSON.stringify(proposal.seeds),
      parent.id,
      parent.generation + 1,
      childInitialScore(parent.score),
    ],
  );
  return res.rows[0]?.id ?? null;
}

/**
 * Derives new families from the ones that produced verified categories, and
 * reconciles every family's score with its counters.
 *
 * `deprioritized` is how many enabled families now sit below the selection
 * floor — parked, not deleted.
 */
export async function expandQueryFamilies(limit: number): Promise<{
  expanded: number;
  deprioritized: number;
}> {
  const cap = Math.max(0, Math.trunc(limit));
  const db = await getDb();

  // Reconcile first: the score is a function of the counters, so recomputing
  // it is always safe and keeps a family that recovered from being left parked.
  for (const family of await listQueryFamilies()) {
    const score = computeFamilyScore(family);
    if (score !== family.score) {
      await db.query(
        'UPDATE research_query_families SET score = $2, updated_at = now() WHERE id = $1',
        [family.id, score],
      );
    }
  }

  const families = await listQueryFamilies();
  const deprioritized = families.filter((f) => f.enabled && f.score < FAMILY_SELECTION_FLOOR).length;
  if (cap === 0) return { expanded: 0, deprioritized };

  const parents = families
    .filter(
      (f) =>
        f.enabled &&
        f.categoriesVerified > 0 &&
        f.score >= FAMILY_SELECTION_FLOOR &&
        f.generation < MAX_FAMILY_GENERATION,
    )
    .slice(0, MAX_PARENTS_PER_EXPANSION);

  let expanded = 0;
  for (const parent of parents) {
    if (expanded >= cap) break;

    let proposals: QueryFamilyProposal[];
    try {
      proposals = await proposeExpansions(parent);
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        // Expansion is the lowest-priority work in the system. A spent budget
        // parks it until next period; it never takes the supervisor down.
        logger.warn('LLM budget exhausted; query expansion stopped early', {
          parent: parent.family,
          expanded,
        });
        break;
      }
      logger.error('query expansion failed for a family', {
        parent: parent.family,
        err: String(err),
      });
      continue;
    }

    for (const raw of proposals) {
      if (expanded >= cap) break;
      const clean = sanitizeProposal(raw);
      if (!clean) {
        logger.debug('rejected an unusable expansion proposal', { parent: parent.family });
        continue;
      }
      const childId = await insertChild(parent, clean);
      if (!childId) continue;
      expanded += 1;

      await recordAudit({
        entityType: 'system',
        eventType: 'DECISION',
        actor: 'expand_query_families',
        reason: `derived a generation ${parent.generation + 1} query family`,
        detail: {
          parentFamily: parent.family,
          parentScore: parent.score,
          childId,
          angle: clean.angle,
          seeds: clean.seeds,
          promptId: QUERY_EXPANSION_PROMPT_ID,
          promptVersion: QUERY_EXPANSION_PROMPT_VERSION,
        },
      });
    }
  }

  logger.info('query family expansion complete', { expanded, deprioritized });
  return { expanded, deprioritized };
}
