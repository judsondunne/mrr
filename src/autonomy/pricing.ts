/**
 * PUBLIC API — PRICE EXPERIMENTS. Owned by the outreach agent.
 *
 * A prospect sees exactly ONE price, permanently. Selection optimises expected
 * MRR per 100 qualified prospects — not conversion rate, because $9 x 12 can
 * lose to $29 x 7.
 */
export interface PriceArm {
  priceMonthly: number;
  assigned: number;
  delivered: number;
  commitments: number;
  priceAcceptances: number;
  expectedMrrPer100: number;
  hasSufficientSample: boolean;
}

export declare function ensurePriceExperiments(
  campaignId: string,
  prices: number[],
): Promise<PriceArm[]>;

/** Stable and permanent: the same prospect always gets the same price. */
export declare function assignPrice(params: {
  campaignId: string;
  prospectId: string;
}): Promise<number>;

export declare function getAssignedPrice(params: {
  campaignId: string;
  prospectId: string;
}): Promise<number | null>;

export declare function priceArms(campaignId: string): Promise<PriceArm[]>;

/** Null until every candidate arm has a sufficient sample. */
export declare function bestPrice(campaignId: string): Promise<PriceArm | null>;

export declare function expectedMrrPer100(arm: {
  delivered: number;
  commitments: number;
  priceMonthly: number;
}): number;
