/** PUBLIC API — WATCHDOG / SELF-HEALING. Owned by the runtime agent. */
export interface WatchdogReport {
  checked: number;
  degraded: string[];
  recovered: string[];
  /** Populated only when automatic recovery failed AND owner action is needed. */
  escalations: Array<{ subsystem: string; reason: string }>;
  runtimeChanged: boolean;
}

/**
 * Probes subsystems, attempts self-recovery (stale locks, abandoned work, provider
 * retries), and moves the runtime state when a subsystem stops progressing.
 * Notifies the owner ONLY when automatic recovery fails or credentials are
 * required.
 */
export declare function runWatchdog(): Promise<WatchdogReport>;

export declare function releaseStaleLocks(): Promise<number>;
export declare function recoverAbandonedJobs(): Promise<number>;
