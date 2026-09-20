/**
 * Build-safe bridge to the pipeline layers.
 *
 * WHY THIS FILE EXISTS: `src/pipeline/outreach` and `src/pipeline/validation`
 * are still `declare`-only contract files, so today they compile to modules
 * with no runtime exports at all. Turbopack treats a statically resolvable
 * reference to a missing export as a hard build error ("The export X was not
 * found in module …") — for named imports *and* for member access on a
 * namespace import — which would break `next build` for the whole project.
 *
 * So the binding is resolved at call time instead. The declared signatures are
 * still enforced: each wrapper is typed from `typeof import(...)`, so if a
 * pipeline agent changes a contract, this file fails to compile.
 *
 * Once those layers are merged the wrappers simply forward the call. Until
 * then they throw a clear PIPELINE_UNAVAILABLE error, which every call site in
 * the web layer already handles by reporting an honest failure rather than
 * pretending the work happened.
 *
 * `@/jobs/registry` is a real module and is imported directly by the cron
 * route — it does not need this treatment.
 */
import * as outreachModule from '@/pipeline/outreach';
import * as validationModule from '@/pipeline/validation';
import { AppError } from '@/lib/errors';

type OutreachModule = typeof import('@/pipeline/outreach');
type ValidationModule = typeof import('@/pipeline/validation');

export type { InboundResult, WebhookResult } from '@/pipeline/outreach';
export type { GateCheck, GateEvaluation } from '@/pipeline/validation';

export class PipelineUnavailableError extends AppError {
  constructor(symbol: string) {
    super(`${symbol} is not implemented yet (pipeline stub)`, 'PIPELINE_UNAVAILABLE', false, {
      symbol,
    });
  }
}

/** Computed lookup on purpose: a static member access would break the build. */
function fnOf<T>(mod: unknown, name: string, label: string): T {
  const value = (mod as Record<string, unknown>)[name];
  if (typeof value !== 'function') throw new PipelineUnavailableError(label);
  return value as T;
}

/** @see src/pipeline/outreach/index.ts */
export function processUnsubscribe(
  ...args: Parameters<OutreachModule['processUnsubscribe']>
): ReturnType<OutreachModule['processUnsubscribe']> {
  return fnOf<OutreachModule['processUnsubscribe']>(
    outreachModule,
    'processUnsubscribe',
    'outreach.processUnsubscribe',
  )(...args);
}

/** @see src/pipeline/outreach/index.ts — rawBody must be the exact bytes received. */
export function handleDeliveryWebhook(
  ...args: Parameters<OutreachModule['handleDeliveryWebhook']>
): ReturnType<OutreachModule['handleDeliveryWebhook']> {
  return fnOf<OutreachModule['handleDeliveryWebhook']>(
    outreachModule,
    'handleDeliveryWebhook',
    'outreach.handleDeliveryWebhook',
  )(...args);
}

/** @see src/pipeline/outreach/index.ts — rawBody must be the exact bytes received. */
export function handleInboundWebhook(
  ...args: Parameters<OutreachModule['handleInboundWebhook']>
): ReturnType<OutreachModule['handleInboundWebhook']> {
  return fnOf<OutreachModule['handleInboundWebhook']>(
    outreachModule,
    'handleInboundWebhook',
    'outreach.handleInboundWebhook',
  )(...args);
}

/** @see src/pipeline/validation/index.ts — read-only, never transitions. */
export function evaluateGate(
  ...args: Parameters<ValidationModule['evaluateGate']>
): ReturnType<ValidationModule['evaluateGate']> {
  return fnOf<ValidationModule['evaluateGate']>(
    validationModule,
    'evaluateGate',
    'validation.evaluateGate',
  )(...args);
}
