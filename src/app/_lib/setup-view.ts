/**
 * Presentation helpers for the setup check.
 *
 * The checks themselves live in `src/lib/setup-check.ts` — this only turns the
 * report into the one sentence an operator needs, and states plainly when
 * outreach is blocked because safety-critical configuration is incomplete.
 */
import type { SetupReport } from '@/lib/setup-check';

export function failedChecks(report: SetupReport) {
  return report.checks.filter((check) => !check.ok);
}

export function blockingChecks(report: SetupReport) {
  return report.checks.filter((check) => !check.ok && check.safetyCritical);
}

/** True when a real email must not leave the system in this configuration. */
export function outreachBlocked(report: SetupReport): boolean {
  return !report.safeToSend || report.shadowMode;
}

export function outreachBlockedReason(report: SetupReport): string | null {
  if (!report.safeToSend) {
    const names = blockingChecks(report).map((check) => check.name);
    return `safety-critical configuration incomplete: ${names.join(', ')}`;
  }
  if (report.shadowMode) {
    const off: string[] = [];
    if (!report.autonomyEnabled) off.push('AUTONOMY_ENABLED is false');
    if (!report.outreachEnabled) off.push('OUTREACH_ENABLED is false');
    return off.length > 0 ? `shadow mode — ${off.join(' and ')}` : 'shadow mode';
  }
  return null;
}

export function overallVerdict(report: SetupReport): string {
  const failed = failedChecks(report).length;
  const reason = outreachBlockedReason(report);

  if (report.allOk) {
    return reason
      ? `CONFIGURED, OUTREACH OFF — every check passes, but no real email can be sent: ${reason}.`
      : 'READY — every check passes and real outreach is enabled.';
  }
  return (
    `NOT READY — ${failed} of ${report.checks.length} checks failed.` +
    (reason ? ` Outreach is blocked: ${reason}.` : '')
  );
}
