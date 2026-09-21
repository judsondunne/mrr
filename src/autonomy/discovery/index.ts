/**
 * PUBLIC API — ADAPTIVE DISCOVERY. Owned by the discovery agent.
 *
 * This layer DRIVES `src/pipeline/discovery/**`; it does not replace it. The
 * Shopify adapter, the Brave research helper, the parser and the source-
 * document store all stay where they are and keep doing their jobs. What is
 * added here is the ability to decide, over time, WHAT to look for, WHERE to
 * look, and HOW MUCH to spend looking:
 *
 *   queries.ts    query families that grow from what actually validated
 *   sources.ts    a registry where nothing is trusted until it is probed
 *   staging.ts    five escalating research stages, cheapest first
 *   ecosystems.ts generic probing of any marketplace, with no bespoke code
 *
 * Two rules hold across all four: every scored decision is deterministic
 * TypeScript, and every external string reaches a model only through
 * `llmComplete`'s `untrusted` field.
 */

// --- query families -----------------------------------------------------------

export type { QueryFamily, QueryFamilyState, QueryFamilyCounters } from './queries';

export {
  seedQueryFamilies,
  /**
   * Derives new query families from the ones that produced verified
   * categories: synonyms, adjacent workflows, competitor names, complaint
   * phrases, "alternative to X", "too expensive", "manual process". Junk-
   * producing families are deprioritized rather than deleted.
   */
  expandQueryFamilies,
  /** Renders concrete search queries for a family, weighted by family score. */
  nextQueries,
  recordQueryOutcome,
  listQueryFamilies,
  // Deterministic scoring — exported so it can be reasoned about and tested
  // without a database.
  computeFamilyScore,
  childInitialScore,
  nextJunkRate,
  allocateSlots,
  renderQuery,
  sanitizeProposal,
  familyKey,
  BASE_FAMILY_SCORE,
  FAMILY_SELECTION_FLOOR,
  CANDIDATES_PER_QUERY_TARGET,
  MIN_QUERIES_FOR_FULL_CONFIDENCE,
  CHILD_SCORE_INHERITANCE,
  MAX_FAMILY_GENERATION,
  MAX_PARENTS_PER_EXPANSION,
  QUERY_SCORE_WEIGHTS,
  QUERY_ANGLES,
  QUERY_EXPANSION_PROMPT_ID,
  QUERY_EXPANSION_PROMPT_VERSION,
} from './queries';
export type { QueryAngle } from './queries';

// --- source registry ----------------------------------------------------------

export {
  seedSources,
  listSources,
  /** Registers a candidate source as UNVERIFIED. Never trusted on sight. */
  proposeSource,
  /**
   * Tests accessibility, stability, evidence quality and cost, then promotes
   * to VERIFIED or marks REJECTED. Low-quality scraped SEO pages can never
   * outrank primary commercial evidence — trust is capped by kind.
   */
  evaluateSource,
  recordSourceOutcome,
  getSourceByName,
  sourceYield,
  computeYieldScore,
  cappedTrust,
  scoreProbe,
  isSourceKind,
  SOURCE_TRUST_CEILING,
  UNVERIFIED_TRUST,
  MIN_PROBE_SCORE_FOR_VERIFIED,
  MAX_ACCEPTABLE_COST_PER_CALL_USD,
  MIN_USEFUL_TEXT_CHARS,
  MIN_COST_BASIS_USD,
  MAX_YIELD_SCORE,
  YIELD_WEIGHTS,
  SEED_SOURCES,
} from './sources';
export type { SourceProbe, SourcePerformance } from './sources';

// --- research staging ---------------------------------------------------------

export {
  /**
   * Five escalating stages. Expensive models only ever see finalists.
   *  0 deterministic filter · 1 cheap extraction · 2 fast classification
   *  3 review/complaint analysis · 4 reasoner (finalists only)
   */
  advanceResearchStage,
  runResearchStages,
  researchStageOf,
  canEnterStage,
  RESEARCH_STAGES,
  MAX_RESEARCH_STAGE,
  COMPLETE_RESEARCH_STAGE,
  ELIMINATED_RESEARCH_STAGE,
  FIRST_LLM_STAGE,
  REASONER_STAGE,
  MIN_DESCRIPTION_CHARS,
  MIN_COMPETITORS_FOR_STAGE_1,
  MIN_SEARCH_RESULTS_FOR_STAGE_1,
  STAGE2_PROMPT_ID,
  STAGE2_PROMPT_VERSION,
  STAGE3_PROMPT_ID,
  STAGE3_PROMPT_VERSION,
  STAGE4_PROMPT_ID,
  STAGE4_PROMPT_VERSION,
} from './staging';
export type { AdvanceResult, ResearchStage } from './staging';

// --- ecosystems ---------------------------------------------------------------

export {
  /** Generic, non-Shopify-specific ecosystem probe. Marks unsupported ones. */
  exploreEcosystem,
  describeEcosystem,
  probeTopics,
  pageLooksCommercial,
  ECOSYSTEM_CATALOG,
  KNOWN_ECOSYSTEMS,
  TOPICS_PER_PROBE,
  PAGES_PER_TOPIC,
  MIN_CANDIDATES_FOR_PROMISING,
  MIN_DISTINCT_PRICES_FOR_PROMISING,
  ADAPTER_CANDIDATE_THRESHOLD,
} from './ecosystems';
export type {
  EcosystemDescriptor,
  EcosystemEvidence,
  EcosystemProbeResult,
} from './ecosystems';
