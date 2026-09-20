/**
 * PUBLIC API — DISCOVERY LAYER. Owned by the discovery agent.
 * Signatures here are the integration contract; callers depend on them.
 */
import type { DiscoveredCandidate, MarketplaceAdapter } from '../../lib/contracts.js';

export interface DiscoverResult {
  candidatesFound: number;
  opportunitiesCreated: number;
  duplicatesSkipped: number;
  opportunityIds: string[];
}

/** Runs one discovery pass. Idempotent: re-running creates no duplicates. */
export declare function discoverOpportunities(limit: number): Promise<DiscoverResult>;

/** Registry of ecosystem adapters. Shopify is the only MVP entry. */
export declare function getAdapters(): MarketplaceAdapter[];
export declare function getAdapter(ecosystem: string): MarketplaceAdapter | null;

export type { DiscoveredCandidate };
