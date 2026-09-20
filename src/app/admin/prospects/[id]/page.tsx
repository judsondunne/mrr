import { notFound } from 'next/navigation';
import { requireAdminPage } from '@/app/admin/auth';
import { getProspect, listProspectMessages } from '@/app/_lib/queries';
import { asRecord, cleanBlock, cleanText, formatDate, safeHref } from '@/app/_lib/text';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type PageProps = { params: Promise<{ id: string }> };

function EvidenceLink({ url }: { url: unknown }) {
  const href = safeHref(url);
  if (!href) return <span className="muted">{cleanText(url, 120) || '—'}</span>;
  return (
    <a href={href} rel="nofollow noopener noreferrer" target="_blank" className="breakall">
      {cleanText(href, 160)}
    </a>
  );
}

export default async function ProspectDetailPage({ params }: PageProps) {
  await requireAdminPage('/admin/opportunities');

  const { id } = await params;
  const prospect = await getProspect(id);
  if (!prospect) notFound();

  const messages = await listProspectMessages(id, 40);
  const evidence = asRecord(prospect.evidence_json);

  return (
    <main className="wrap wide">
      <p className="small">
        <a href={`/admin/opportunities/${encodeURIComponent(prospect.opportunity_id)}`}>
          ← opportunity
        </a>
      </p>

      <h1>{cleanText(prospect.company_name, 120) || prospect.id}</h1>
      <p className="muted small breakall">
        {prospect.id} · discovered {formatDate(prospect.created_at)}
      </p>

      <table>
        <tbody>
          <tr>
            <th style={{ width: '16rem' }}>Status</th>
            <td>
              <strong>{prospect.status}</strong>
              {prospect.suppressed_at ? (
                <span className="bad"> — suppressed {formatDate(prospect.suppressed_at)}</span>
              ) : null}
            </td>
          </tr>
          <tr>
            <th>Domain</th>
            <td className="breakall">{cleanText(prospect.domain, 120)}</td>
          </tr>
          <tr>
            <th>Country</th>
            <td>{prospect.country ?? '—'}</td>
          </tr>
          <tr>
            <th>Why it qualified</th>
            <td>{cleanText(prospect.qualification_reason, 600) || '—'}</td>
          </tr>
          <tr>
            <th>Qualification score</th>
            <td>{prospect.qualification_score ?? '—'}</td>
          </tr>
          <tr>
            <th>Public evidence URL</th>
            <td>
              <EvidenceLink url={prospect.public_evidence_url} />
            </td>
          </tr>
          <tr>
            <th>Contact email</th>
            <td className="breakall">
              {cleanText(prospect.contact_email, 120) || '—'}
              {prospect.email_is_public ? (
                <span className="ok small"> (public)</span>
              ) : (
                <span className="bad small"> (NOT marked public — must not be emailed)</span>
              )}
            </td>
          </tr>
          <tr>
            <th>Contact source URL</th>
            <td>
              <EvidenceLink url={prospect.contact_source_url} />
            </td>
          </tr>
        </tbody>
      </table>

      {Object.keys(evidence).length > 0 ? (
        <>
          <h2>Stored evidence</h2>
          <table>
            <tbody>
              {Object.entries(evidence)
                .slice(0, 25)
                .map(([key, value]) => (
                  <tr key={key}>
                    <th style={{ width: '16rem' }}>{cleanText(key, 60)}</th>
                    <td className="small breakall">
                      {typeof value === 'string'
                        ? cleanText(value, 400)
                        : cleanText(JSON.stringify(value), 400)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </>
      ) : null}

      <h2>Message history</h2>
      {messages.length === 0 ? (
        <p className="muted">Nothing sent or received yet.</p>
      ) : (
        messages.map((message) => (
          <div className="panel" key={message.id}>
            <p className="small muted">
              {message.direction} · step {message.sequence_step} · {message.status} ·{' '}
              {formatDate(message.sent_at ?? message.received_at ?? message.created_at)}
              {message.classification ? ` · ${message.classification}` : ''}
              {message.requires_human ? ' · NEEDS HUMAN' : ''}
              {message.bounce_type ? ` · bounce ${message.bounce_type}` : ''}
              {message.campaign_id ? (
                <>
                  {' · '}
                  <a href={`/admin/campaigns/${encodeURIComponent(message.campaign_id)}`}>
                    campaign
                  </a>
                </>
              ) : null}
            </p>
            <p>
              <strong>{cleanText(message.subject, 200) || '(no subject)'}</strong>
            </p>
            <pre>{cleanBlock(message.body, 4000) || '(empty body)'}</pre>
          </div>
        ))
      )}
    </main>
  );
}
