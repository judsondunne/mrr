/**
 * PUBLIC API — WEDGE LAYER. Owned by the wedge/prospecting agent.
 */
import type { Wedge } from '../../lib/contracts.js';

export interface WedgeResult {
  opportunityId: string;
  wedge: Wedge | null;
  clusterCount: number;
  rejected: boolean;
  rejectionDetail: string | null;
}

/** Generates wedges for opportunities in CATEGORY_VERIFIED. */
export declare function generateWedges(limit: number): Promise<WedgeResult[]>;
export declare function generateWedgeFor(opportunityId: string): Promise<WedgeResult>;
