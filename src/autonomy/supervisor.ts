/**
 * PUBLIC API — THE SUPERVISOR. Owned by the supervisor agent.
 *
 * The brain. Runs frequently, decides what should happen next, and enqueues it
 * idempotently. The owner never invokes work directly.
 */
export interface SupervisorDecision {
  kind: string;
  priority: number;
  reason: string;
  opportunityId: string | null;
  idempotencyKey: string;
}

export interface SupervisorReport {
  runtimeState: string;
  decisions: SupervisorDecision[];
  enqueued: number;
  skipped: Array<{ reason: string; count: number }>;
  executed: number;
  budgetRemainingUsd: number;
  outreachCapacityRemaining: number;
  deadLetterReviewed: number;
}

/**
 * One supervisor tick: autostart if needed, watchdog, observe, rank, enqueue,
 * then drain some work within the tick so a healthy system needs no other
 * trigger. Safe to run concurrently — everything it does is idempotent.
 */
export declare function runSupervisor(opts?: { maxWorkItems?: number }): Promise<SupervisorReport>;

/** Executes queued work items. Exposed separately for tests and the simulator. */
export declare function drainQueue(maxItems: number): Promise<{ processed: number; failed: number }>;
