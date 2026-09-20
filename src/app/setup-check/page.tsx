/**
 * Setup check page. Admin-protected (it reports which credentials exist).
 *
 * The checks come from `runSetupChecks()` in the foundation layer, which is
 * non-destructive: no test email is sent and no LLM token is spent.
 */
import type { Metadata } from 'next';
import { requireAdminPage } from '@/app/admin/auth';
import { runSetupChecks } from '@/lib/setup-check';
import { outreachBlocked, outreachBlockedReason, overallVerdict } from '@/app/_lib/setup-view';
import { cleanText } from '@/app/_lib/text';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const metadata: Metadata = {
  title: 'Setup check',
  robots: { index: false, follow: false, nocache: true },
};

export default async function SetupCheckPage() {
  await requireAdminPage('/setup-check');

  const report = await runSetupChecks();
  const blocked = outreachBlocked(report);
  const verdict = overallVerdict(report);

  return (
    <main className="wrap wide">
      <h1>Setup check</h1>
      <p className="small muted">
        Configuration only. This page sends no email, makes no search call and spends no LLM
        tokens.
      </p>

      <p className={`notice ${report.allOk && !blocked ? '' : 'blocked'}`}>
        <strong>{verdict}</strong>
      </p>

      {blocked ? (
        <p className="notice blocked">
          <strong>OUTREACH IS BLOCKED.</strong> No email can be sent to a real business right now —{' '}
          {outreachBlockedReason(report)}.
        </p>
      ) : null}

      <table>
        <thead>
          <tr>
            <th style={{ width: '3rem' }}>&nbsp;</th>
            <th style={{ width: '14rem' }}>Check</th>
            <th>Status</th>
            <th>Fix</th>
          </tr>
        </thead>
        <tbody>
          {report.checks.map((check) => (
            <tr key={check.name}>
              <td>{check.ok ? '✅' : '❌'}</td>
              <td>
                <strong>{cleanText(check.name, 60)}</strong>
                {check.safetyCritical ? (
                  <div className="small muted">safety-critical</div>
                ) : null}
              </td>
              <td className={check.ok ? '' : 'bad'}>{cleanText(check.detail, 300)}</td>
              <td className="small muted">{check.ok ? '—' : cleanText(check.remediation, 300)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <table>
        <tbody>
          <tr>
            <th style={{ width: '16rem' }}>AUTONOMY_ENABLED</th>
            <td>{report.autonomyEnabled ? 'true' : 'false'}</td>
          </tr>
          <tr>
            <th>OUTREACH_ENABLED</th>
            <td>{report.outreachEnabled ? 'true' : 'false'}</td>
          </tr>
          <tr>
            <th>Shadow mode</th>
            <td>{report.shadowMode ? 'yes — nothing leaves the system' : 'no'}</td>
          </tr>
          <tr>
            <th>Safe to send (config)</th>
            <td className={report.safeToSend ? 'ok' : 'bad'}>
              {report.safeToSend ? 'yes' : 'no'}
            </td>
          </tr>
        </tbody>
      </table>

      <p className="small muted">
        Machine-readable version: <code>GET /api/setup-check</code> with{' '}
        <code>Authorization: Bearer &lt;ADMIN_TOKEN&gt;</code>.
      </p>
    </main>
  );
}
