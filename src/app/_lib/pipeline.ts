/**
 * Single import point from the web layer into the pipeline layers.
 *
 * This file used to resolve each binding at call time, because those layers
 * were `declare`-only contract files while they were built in parallel and a
 * statically resolvable reference to a missing export is a hard Turbopack
 * error. They are implemented now, so the indirection is gone: these are plain
 * re-exports, which means a change to a pipeline contract fails `next build`
 * and `tsc` instead of surfacing as a runtime error in a webhook handler.
 *
 * Keeping one bridge module (rather than importing the pipeline directly from
 * routes) still pays for itself: it is the one place to look to see everything
 * the web layer is allowed to call.
 */
export { processUnsubscribe, handleDeliveryWebhook, handleInboundWebhook } from '@/pipeline/outreach';
export { evaluateGate } from '@/pipeline/validation';

export type { InboundResult, WebhookResult } from '@/pipeline/outreach';
export type { GateCheck, GateEvaluation } from '@/pipeline/validation';
