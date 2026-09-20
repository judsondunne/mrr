/**
 * PUBLIC API — OUTREACH LAYER. Owned by the outreach agent.
 * The web layer's API routes call these; do not change the signatures.
 */
export interface PrepareResult {
  opportunityId: string;
  campaignId: string | null;
  landingSlug: string | null;
  drafted: number;
  skipped: string | null;
}

export interface SendResult {
  campaignId: string;
  attempted: number;
  sent: number;
  failed: number;
  simulated: boolean;
  haltedReason: string | null;
}

export interface WebhookResult {
  accepted: boolean;
  duplicate: boolean;
  eventType: string;
  detail?: string;
}

export interface InboundResult {
  accepted: boolean;
  duplicate: boolean;
  classification: string | null;
  commitmentsCreated: number;
  autoReplied: boolean;
  suppressed: boolean;
}

/** Builds campaign + landing copy + drafts batch-1 messages. */
export declare function prepareCampaigns(limit: number): Promise<PrepareResult[]>;

/** Sends messages that are due, honouring every batch/budget/window rule. */
export declare function sendDueMessages(): Promise<SendResult[]>;

/** Queues follow-ups for prospects that are eligible. Max 2, ever. */
export declare function scheduleFollowups(): Promise<{ queued: number }>;

/**
 * Handles a Resend delivery-event webhook.
 * `rawBody` is the exact unparsed request body — required for signature verification.
 */
export declare function handleDeliveryWebhook(
  rawBody: string,
  headers: Record<string, string>,
): Promise<WebhookResult>;

/** Handles a Resend inbound-email webhook (a prospect replying). */
export declare function handleInboundWebhook(
  rawBody: string,
  headers: Record<string, string>,
): Promise<InboundResult>;

/** Adds an address/domain to the suppression list. Idempotent. */
export declare function suppress(params: {
  email?: string;
  domain?: string;
  reason: string;
  notes?: string;
}): Promise<void>;

/** True when this address or its domain must never be emailed. */
export declare function isSuppressed(email: string): Promise<boolean>;

/** Verifies a signed unsubscribe token and suppresses. Used by the web route. */
export declare function processUnsubscribe(token: string): Promise<{ ok: boolean; email: string | null }>;

/** Builds the signed one-click unsubscribe URL for an outbound message. */
export declare function buildUnsubscribeUrl(email: string): string;
