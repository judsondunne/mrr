/**
 * PUBLIC API — DELIVERABILITY ENGINE. Owned by the outreach agent.
 *
 * Volume is EARNED. A new sending domain does not get 75/day on day one, and
 * a campaign does not jump to 150. Crossing a bounce/complaint ceiling pauses
 * sending with no AI override.
 */
export interface SendAllowance {
  /** How many emails may be sent right now, across everything. */
  allowed: number;
  domainCapToday: number;
  campaignCap: number;
  warmupDay: number;
  reason: string | null;
}

export declare function getSendAllowance(campaignId: string): Promise<SendAllowance>;

/** Cumulative ceiling for a campaign's current ramp step (10/25/50/75...). */
export declare function campaignRampCap(rampStep: number): number;

/** Domain-level warm-up ceiling for today. */
export declare function domainDailyCap(): Promise<{ cap: number; warmupDay: number }>;

export declare function recordFirstSend(): Promise<void>;

export interface DeliverabilityVerdict {
  healthy: boolean;
  reason: string | null;
  shouldPause: boolean;
}

/** Evaluated between batches. A breach pauses; it never asks an LLM. */
export declare function evaluateDeliverability(): Promise<DeliverabilityVerdict>;

export declare function pauseSending(reason: string): Promise<void>;
export declare function resumeSendingIfRecovered(): Promise<{ resumed: boolean; reason: string }>;

/** Advances a campaign to the next ramp step only if the last batch was healthy. */
export declare function maybeAdvanceRamp(campaignId: string): Promise<{
  advanced: boolean;
  rampStep: number;
  reason: string;
}>;
