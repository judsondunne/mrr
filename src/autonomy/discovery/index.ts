/** PUBLIC API — ADAPTIVE DISCOVERY. Owned by the discovery agent. */
import type { SourceRecord, SourceKind } from '../types';

// --- query families -----------------------------------------------------------

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

export declare function seedQueryFamilies(): Promise<{ created: number }>;

/**
 * Derives new query families from the ones that produced verified categories:
 * synonyms, adjacent workflows, competitor names, complaint phrases,
 * "alternative to X", "too expensive", "manual process". Junk-producing
 * families are deprioritized rather than deleted.
 */
export declare function expandQueryFamilies(limit: number): Promise<{
  expanded: number;
  deprioritized: number;
}>;

/** Renders concrete search queries for a family, bandit-weighted. */
export declare function nextQueries(limit: number): Promise<Array<{ familyId: string; query: string }>>;

export declare function recordQueryOutcome(params: {
  familyId: string;
  candidatesFound: number;
  junk: number;
  categoriesVerified?: number;
  commitments?: number;
}): Promise<void>;

// --- source registry ----------------------------------------------------------

export declare function seedSources(): Promise<{ created: number }>;
export declare function listSources(opts?: { enabledOnly?: boolean }): Promise<SourceRecord[]>;

/** Registers a candidate source as UNVERIFIED. Never trusted on sight. */
export declare function proposeSource(params: {
  name: string;
  kind: SourceKind;
  baseUrl: string;
  ecosystem?: string | null;
  reason: string;
}): Promise<{ id: string; created: boolean }>;

/**
 * Tests accessibility, stability, evidence quality and cost, then promotes to
 * VERIFIED or marks REJECTED. Low-quality scraped SEO pages can never outrank
 * primary commercial evidence — trust is capped by kind.
 */
export declare function evaluateSource(sourceId: string): Promise<{
  status: SourceRecord['status'];
  trustLevel: number;
  notes: string;
}>;

export declare function recordSourceOutcome(params: {
  sourceId: string;
  fetches?: number;
  failures?: number;
  candidatesFound?: number;
  categoriesVerified?: number;
  commitments?: number;
  spendUsd?: number;
}): Promise<void>;

// --- research staging ---------------------------------------------------------

/**
 * Five escalating stages. Expensive models only ever see finalists.
 *  0 deterministic filter · 1 cheap extraction · 2 fast classification
 *  3 review/complaint analysis · 4 reasoner (finalists only)
 */
export declare function advanceResearchStage(opportunityId: string): Promise<{
  fromStage: number;
  toStage: number;
  survived: boolean;
  reason: string;
}>;

export declare function runResearchStages(limit: number): Promise<{
  advanced: number;
  eliminated: number;
}>;

/** Generic, non-Shopify-specific ecosystem probe. Marks unsupported ones. */
export declare function exploreEcosystem(ecosystem: string): Promise<{
  ecosystem: string;
  supported: boolean;
  candidatesFound: number;
  promising: boolean;
  adapterCandidate: boolean;
}>;
