import { requireAdminPage } from '@/app/admin/auth';
import { listOpportunities } from '@/app/_lib/queries';
import { cleanText, formatDate, formatPrice } from '@/app/_lib/text';
import { isOpportunityState, OPPORTUNITY_STATES } from '@/lib/state-machine';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type PageProps = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export default async function OpportunitiesPage({ searchParams }: PageProps) {
  await requireAdminPage('/admin/opportunities');

  const query = await searchParams;
  const requested = first(query.state);
  const state = requested && isOpportunityState(requested) ? requested : null;

  const rows = await listOpportunities(state);

  return (
    <main className="wrap wide">
      <h1>Opportunities</h1>

      <p className="small">
        <a href="/admin/opportunities">all</a>
        {OPPORTUNITY_STATES.map((s) => (
          <span key={s}>
            {' · '}
            <a href={`/admin/opportunities?state=${encodeURIComponent(s)}`}>{s}</a>
          </span>
        ))}
      </p>

      {state ? (
        <p className="muted small">
          Filtered to <strong>{state}</strong>.
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="muted">Nothing here.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>State</th>
              <th>Ecosystem</th>
              <th>Category</th>
              <th>Evidence</th>
              <th>Price</th>
              <th>Campaign</th>
              <th>Next action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <a href={`/admin/opportunities/${encodeURIComponent(row.id)}`}>
                    {cleanText(row.name, 80) || row.id}
                  </a>
                </td>
                <td>
                  {row.state}
                  {row.rejection_reason ? (
                    <div className="small muted">{cleanText(row.rejection_reason, 60)}</div>
                  ) : null}
                </td>
                <td>{cleanText(row.ecosystem, 40)}</td>
                <td>{cleanText(row.category, 60)}</td>
                <td>{row.evidence_confidence ?? '—'}</td>
                <td className="num">
                  {row.proposed_price_monthly === null
                    ? '—'
                    : `${formatPrice(row.proposed_price_monthly)}/mo`}
                </td>
                <td>{row.campaign_state ?? '—'}</td>
                <td className="small">{formatDate(row.next_action_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="small muted">Showing at most 300 rows, most recently updated first.</p>
    </main>
  );
}
