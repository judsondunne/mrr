/** PUBLIC API — RUNTIME STATE. Owned by the runtime agent. */
import type { RuntimeState, Subsystem, SubsystemHealth, HealthStatus } from './types';

export interface RuntimeSnapshot {
  state: RuntimeState;
  reason: string | null;
  blocking: string[];
  enteredAt: Date;
  updatedAt: Date;
}

export declare function getRuntimeState(): Promise<RuntimeSnapshot>;

/** Audited. Rejects edges not in the runtime state machine. */
export declare function transitionRuntime(params: {
  to: RuntimeState;
  reason: string;
  actor: string;
  blocking?: string[];
  detail?: Record<string, unknown>;
}): Promise<{ moved: boolean; from: RuntimeState }>;

export declare function canRuntimeTransition(from: RuntimeState, to: RuntimeState): boolean;

/** True only in RUNNING or DEGRADED. Every job consults this. */
export declare function isOperational(): Promise<boolean>;

export declare function recordHeartbeat(params: {
  subsystem: Subsystem;
  status: HealthStatus;
  error?: string | null;
  detail?: Record<string, unknown>;
}): Promise<void>;

export declare function getSubsystemHealth(): Promise<SubsystemHealth[]>;
