/**
 * Thin wrapper around the deterministic validation gate.
 *
 * The dashboard must keep rendering even when the gate cannot be evaluated
 * (no campaign yet, or the validation layer not yet merged). A failure here is
 * reported as an explicit "could not evaluate" state — it is NEVER shown as a
 * pass, and it never becomes a 500 on the primary debugging page.
 */
import { evaluateGate, type GateEvaluation } from '@/app/_lib/pipeline';

export type GateLoad =
  | { ok: true; evaluation: GateEvaluation }
  | { ok: false; error: string };

export async function loadGateEvaluation(opportunityId: string): Promise<GateLoad> {
  try {
    const evaluation = await evaluateGate(opportunityId);
    if (!evaluation || !Array.isArray(evaluation.checks)) {
      return { ok: false, error: 'the validation layer returned no checks' };
    }
    return { ok: true, evaluation };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
