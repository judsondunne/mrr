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
export { prepareCampaigns } from './campaign.js';

/** Sends messages that are due, honouring every batch/budget/window rule. */
export { sendDueMessages } from './send.js';

/** Queues follow-ups for prospects that are eligible. Max 2, ever. */
export { scheduleFollowups } from './followups.js';

/**
 * Handles a Resend delivery-event webhook.
 * `rawBody` is the exact unparsed request body — required for signature verification.
 */
export { handleDeliveryWebhook, handleInboundWebhook } from './webhooks.js';

/**
 * Adds an address/domain to the suppression list. Idempotent.
 * True when this address or its domain must never be emailed.
 */
export { suppress, isSuppressed } from './suppression.js';

/**
 * Verifies a signed unsubscribe token and suppresses. Used by the web route.
 * buildUnsubscribeUrl builds the signed one-click link for an outbound message.
 */
export {
  processUnsubscribe,
  buildUnsubscribeUrl,
  UNSUBSCRIBE_PATH,
  UNSUBSCRIBE_TOKEN_PARAM,
} from './unsubscribe.js';

// --- secondary surface used by the web/admin layers --------------------------

/** Landing-page copy contract, so the web layer renders validated content. */
export { LandingCopy, loadOffer, landingUrlFor, type OfferContext } from './offer.js';

/** Campaign health, exported so the dashboard can show why a campaign halted. */
export { checkCampaignHealth, type HealthVerdict } from './health.js';

/** Sending-window helpers, exported for /setup-check and the dashboard. */
export { isWithinSendingWindow, sendingWindowStatus, type WindowStatus } from './window.js';

/** Commitment writing, shared with the landing-page signup route. */
export { recordCommitments } from './classify.js';

export { ComplianceError, ReplySafetyError, WebhookVerificationError } from './errors.js';
