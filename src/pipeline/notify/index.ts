/**
 * PUBLIC API — OWNER NOTIFICATION LAYER. Owned by the validation agent.
 *
 * The owner hears from this system for exactly six reasons and no others.
 * There is deliberately no function for "progress update".
 */
import type { NotificationKind } from '../../lib/contracts.js';

/** Sends the one email the owner actually wants. Deduped per opportunity. */
export declare function notifyValidatedOpportunities(): Promise<{ sent: number }>;

/** Infrastructure alerts. Deduped by key so failures never spam. */
export declare function notifyOwner(params: {
  kind: Exclude<NotificationKind, 'READY_TO_BUILD'>;
  subject: string;
  body: string;
  dedupeKey: string;
  detail?: Record<string, unknown>;
}): Promise<{ sent: boolean; deduped: boolean }>;

/** Renders the READY_TO_BUILD email body. Exported for tests and the dashboard. */
export declare function renderReadyToBuildEmail(opportunityId: string): Promise<{
  subject: string;
  body: string;
}>;
