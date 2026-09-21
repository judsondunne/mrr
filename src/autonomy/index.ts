/**
 * The autonomy layer's public surface.
 *
 * Two planes, and the boundary between them is mechanical:
 *  - CONTROL PLANE: typed config + code. No AI write path. Not re-exported here.
 *  - STRATEGY PLANE: database rows, written only through guard.ts.
 */
export * from './types';
export { runSupervisor, drainQueue } from './supervisor';
export { autoStart, checkReadiness } from './autostart';
export { getRuntimeState, transitionRuntime, isOperational, recordHeartbeat } from './runtime';
export { runWatchdog } from './watchdog';
export { enqueue, claimNext, completeWork, failWork, listDeadLetter } from './queue';
export { getBudgetReport, canSpend } from './budget';
export { assertStrategyOnly, findForbiddenFields } from './guard';
export { sanitizeExternalText, detectInjection } from './injection';
