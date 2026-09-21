/** PUBLIC API — DURABLE WORK QUEUE + DEAD LETTER. Owned by the runtime agent. */
import type { EnqueueRequest, WorkItem, WorkKind } from './types';

/** Idempotent: re-enqueuing the same key is a no-op, never a duplicate. */
export declare function enqueue(req: EnqueueRequest): Promise<{ id: string; created: boolean }>;

/** Claims the highest-priority due item, atomically. */
export declare function claimNext(workerId: string, kinds?: WorkKind[]): Promise<WorkItem | null>;

export declare function completeWork(id: string): Promise<void>;

/** Bounded exponential backoff; dead-letters after maxAttempts. */
export declare function failWork(id: string, error: string): Promise<{ deadLettered: boolean }>;

export declare function listDeadLetter(limit?: number): Promise<WorkItem[]>;

/** Supervisor's DLQ triage: retry / archive / escalate. */
export declare function reviveDeadLetter(id: string, reason: string): Promise<void>;
export declare function archiveDeadLetter(id: string, reason: string): Promise<void>;

/** Releases items whose worker died mid-flight. */
export declare function releaseStaleClaims(): Promise<number>;

export declare function queueDepth(): Promise<Record<string, number>>;
