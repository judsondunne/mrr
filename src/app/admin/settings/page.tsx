/**
 * Configuration STATUS.
 *
 * This page renders `buildSettingsStatus()` and nothing else. Credential rows
 * come back as the literal string 'set' or 'not set' — no value, no prefix, no
 * masked form — so there is no way for a secret to reach the DOM from here.
 */
import { requireAdminPage } from '@/app/admin/auth';
import { buildSettingsStatus } from '@/app/_lib/settings-status';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function SettingsPage() {
  await requireAdminPage('/admin/settings');
  const groups = buildSettingsStatus();

  return (
    <main className="wrap wide">
      <h1>Settings</h1>
      <p className="notice">
        <strong>Status only.</strong> Secret values are never rendered here, in full or in part.
        Credentials show as <code>set</code> or <code>not set</code>. To change any of these, edit
        the environment and redeploy.
      </p>

      {groups.map((group) => (
        <section key={group.title}>
          <h2>{group.title}</h2>
          <table>
            <thead>
              <tr>
                <th style={{ width: '22rem' }}>Setting</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {group.rows.map((row) => (
                <tr key={`${group.title}-${row.label}`}>
                  <td>{row.label}</td>
                  <td className={row.ok === null ? '' : row.ok ? 'ok' : 'bad'}>
                    {row.value}
                    {row.kind === 'secret' ? <span className="muted small"> (value hidden)</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}

      <p className="small muted">
        Configuration readiness, with remediation hints: <a href="/setup-check">/setup-check</a>.
      </p>
    </main>
  );
}
