/** PUBLIC API — AUTOSTART. Owned by the runtime agent. */
import type { RuntimeState } from './types';

export interface ReadinessReport {
  ready: boolean;
  blocking: string[];
  /** Exactly one actionable sentence per blocking item. */
  remediation: string[];
}

/** Non-destructive readiness probe: config + connectivity, no spend, no sends. */
export declare function checkReadiness(): Promise<ReadinessReport>;

/**
 * Drives BOOTING → SELF_TESTING → SHADOW_VERIFYING → RUNNING, or parks in
 * BLOCKED_CONFIGURATION with ONE actionable owner notification. Idempotent and
 * safe to call on every supervisor tick: once the missing dependency becomes
 * healthy it promotes to RUNNING with no owner command.
 */
export declare function autoStart(): Promise<{ state: RuntimeState; changed: boolean }>;
