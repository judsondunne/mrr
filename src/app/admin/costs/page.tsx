import { requireAdminPage } from '@/app/admin/auth';
import { getBudgetSnapshot, getCostBreakdown } from '@/lib/cost';
import { formatDate, formatUsd, pct } from '@/app/_lib/text';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function usage(spent: number, budget: number): string {
  if (budget <= 0) return 'no budget configured';
  return `${pct(spent / budget)} of budget`;
}

export default async function CostsPage() {
  await requireAdminPage('/admin/costs');

  const [breakdown, budget] = await Promise.all([getCostBreakdown(), getBudgetSnapshot()]);

  const total = breakdown.reduce((sum, row) => sum + row.estimated_cost, 0);
  const llmOver = budget.llmSpentUsd > budget.llmBudgetUsd;
  const searchOver = budget.searchSpentUsd > budget.searchBudgetUsd;

  return (
    <main className="wrap wide">
      <h1>Costs</h1>
      <p className="small muted">Period starts {formatDate(budget.periodStart)} (UTC month).</p>

      <h2>Against budget</h2>
      <table>
        <thead>
          <tr>
            <th>Meter</th>
            <th className="num">Used</th>
            <th className="num">Limit</th>
            <th>Utilisation</th>
          </tr>
        </thead>
        <tbody>
          <tr className={llmOver ? 'bad' : ''}>
            <td>LLM (month)</td>
            <td className="num">{formatUsd(budget.llmSpentUsd)}</td>
            <td className="num">{formatUsd(budget.llmBudgetUsd)}</td>
            <td>{usage(budget.llmSpentUsd, budget.llmBudgetUsd)}</td>
          </tr>
          <tr className={searchOver ? 'bad' : ''}>
            <td>Search (month)</td>
            <td className="num">{formatUsd(budget.searchSpentUsd)}</td>
            <td className="num">{formatUsd(budget.searchBudgetUsd)}</td>
            <td>{usage(budget.searchSpentUsd, budget.searchBudgetUsd)}</td>
          </tr>
          <tr>
            <td>Emails (today)</td>
            <td className="num">{budget.emailsSentToday}</td>
            <td className="num">{budget.maxEmailsPerDay}</td>
            <td>{usage(budget.emailsSentToday, budget.maxEmailsPerDay)}</td>
          </tr>
          <tr>
            <td>New campaigns (week)</td>
            <td className="num">{budget.campaignsStartedThisWeek}</td>
            <td className="num">{budget.maxNewCampaignsPerWeek}</td>
            <td>{usage(budget.campaignsStartedThisWeek, budget.maxNewCampaignsPerWeek)}</td>
          </tr>
        </tbody>
      </table>

      {llmOver || searchOver ? (
        <p className="notice blocked">
          <strong>A budget is exhausted.</strong> Metered jobs refuse to run until the next period
          or until the limit is raised.
        </p>
      ) : null}

      <h2>Ledger breakdown this period</h2>
      {breakdown.length === 0 ? (
        <p className="muted">Nothing has been spent yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th>Resource</th>
              <th className="num">Quantity</th>
              <th className="num">Estimated cost</th>
            </tr>
          </thead>
          <tbody>
            {breakdown.map((row) => (
              <tr key={`${row.provider}-${row.resource_type}`}>
                <td>{row.provider}</td>
                <td>{row.resource_type}</td>
                <td className="num">{row.quantity}</td>
                <td className="num">{formatUsd(row.estimated_cost)}</td>
              </tr>
            ))}
            <tr>
              <th colSpan={3}>Total</th>
              <th className="num">{formatUsd(total)}</th>
            </tr>
          </tbody>
        </table>
      )}
    </main>
  );
}
