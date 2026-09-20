import { requireAdminPage } from '@/app/admin/auth';
import { countOpportunitiesByState, listRecentJobRuns } from '@/app/_lib/queries';
import { getBudgetSnapshot } from '@/lib/cost';
import { formatDate, formatUsd } from '@/app/_lib/text';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function AdminOverviewPage() {
  await requireAdminPage('/admin');

  const [states, jobs, budget] = await Promise.all([
    countOpportunitiesByState(),
    listRecentJobRuns(10),
    getBudgetSnapshot(),
  ]);

  const total = states.reduce((sum, row) => sum + row.n, 0);

  return (
    <main className="wrap wide">
      <h1>Overview</h1>

      <h2>Opportunities by state ({total} total)</h2>
      {states.length === 0 ? (
        <p className="muted">No opportunities yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>State</th>
              <th className="num">Count</th>
            </tr>
          </thead>
          <tbody>
            {states.map((row) => (
              <tr key={row.label}>
                <td>
                  <a href={`/admin/opportunities?state=${encodeURIComponent(row.label)}`}>
                    {row.label}
                  </a>
                </td>
                <td className="num">{row.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Spend this period</h2>
      <ul>
        <li>
          LLM: {formatUsd(budget.llmSpentUsd)} of {formatUsd(budget.llmBudgetUsd)}
        </li>
        <li>
          Search: {formatUsd(budget.searchSpentUsd)} of {formatUsd(budget.searchBudgetUsd)}
        </li>
        <li>
          Emails today: {budget.emailsSentToday} of {budget.maxEmailsPerDay}
        </li>
        <li>
          Campaigns this week: {budget.campaignsStartedThisWeek} of {budget.maxNewCampaignsPerWeek}
        </li>
      </ul>
      <p className="small muted">
        Full breakdown: <a href="/admin/costs">/admin/costs</a>
      </p>

      <h2>Recent job runs</h2>
      {jobs.length === 0 ? (
        <p className="muted">No job has run yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Job</th>
              <th>Status</th>
              <th className="num">Records</th>
              <th>Started</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job, i) => (
              <tr key={`${job.job}-${i}`}>
                <td>{job.job}</td>
                <td className={job.status === 'FAILED' ? 'bad' : ''}>{job.status}</td>
                <td className="num">{job.records_processed}</td>
                <td>{formatDate(job.started_at)}</td>
                <td className="small">{job.error ? job.error.slice(0, 200) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
