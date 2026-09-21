/**
 * PUBLIC API — MODEL CALIBRATION. Owned by the security agent.
 *
 * A prompt or model change must not silently degrade reply classification —
 * that would corrupt every downstream learning signal.
 */
export interface CalibrationResult {
  promptId: string;
  promptVersion: number;
  model: string;
  total: number;
  passed: number;
  accuracy: number;
  baselineAccuracy: number | null;
  regressed: boolean;
  failures: Array<{ fixture: string; expected: string; actual: string }>;
}

export declare function runCalibration(promptId?: string): Promise<CalibrationResult[]>;

/** False when accuracy regressed past the configured threshold. */
export declare function isConfigurationAcceptable(promptId: string): Promise<boolean>;

export declare function recordCalibrationRun(result: CalibrationResult): Promise<void>;
