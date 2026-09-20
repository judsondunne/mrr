import { notFound } from 'next/navigation';
import { requireAdminPage } from '@/app/admin/auth';
import {
  countLandingVisits,
  getCampaign,
  getCommitmentSummary,
  getMessageStats,
  listCampaignMessages,
  listCampaignMetrics,
  listCommitments,
} from '@/app/_lib/queries';
import { cleanText, formatDate, formatPrice, safeHref } from '@/app/_lib/text';
import { getConfig } from '@/lib/config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type PageProps = { params: Promise<{ id: string }> };

export default async function CampaignDetailPage({ params }: PageProps) {
  await requireAdminPage('/admin/opportunities');

  const { id } = await params;
  const campaign = await getCampaign(id);
  if (!campaign) notFound();

  const [stats, metrics, messages, commitments, summary, visits] = await Promise.all([
    getMessageStats(id),
    listCampaignMetrics(id, 10),
    listCampaignMessages(id, 40),
    listCommitments(id, 50),
    getCommitmentSummary(id),
    countLandingVisits(id),
  ]);

  const cfg = getConfig();
  const landingUrl = safeHref(`${cfg.publicBaseUrl}/v/${campaign.landing_slug}`);
  const progress = campaign.target_count > 0 ? `${stats.sent} / ${campaign.target_count}` : `${stats.sent}`;

  return (
    <main className="wrap wide">
      <p className="small">
        <a href={`/admin/opportunities/${encodeURIComponent(campaign.opportunity_id)}`}>
          ← opportunity
        </a>
      </p>

      <h1>{cleanText(campaign.offer_name, 120) || campaign.id}</h1>
      <p className="muted small breakall">
        {campaign.id} · created {formatDate(campaign.created_at)}
      </p>

      <table>
        <tbody>
          <tr>
            <th style={{ width: '16rem' }}>State</th>
            <td>
              <strong>{campaign.state}</strong>
              {campaign.halt_reason ? (
                <span className="bad"> — halted: {cleanText(campaign.halt_reason, 200)}</span>
              ) : null}
            </td>
          </tr>
          <tr>
            <th>Price</th>
            <td>{formatPrice(campaign.price_monthly)}/month</td>
          </tr>
          <tr>
            <th>Batch progress (sent / target)</th>
            <td>{progress}</td>
          </tr>
          <tr>
            <th>Landing page</th>
            <td className="breakall">
              <a href={`/v/${encodeURIComponent(campaign.landing_slug)}`}>
                /v/{cleanText(campaign.landing_slug, 80)}
              </a>
              {landingUrl ? <div className="small muted">{landingUrl}</div> : null}
            </td>
          </tr>
          <tr>
            <th>Landing visits</th>
            <td>{visits}</td>
          </tr>
          <tr>
            <th>Started / ended</th>
            <td>
              {formatDate(campaign.started_at)} / {formatDate(campaign.ended_at)}
            </td>
          </tr>
        </tbody>
      </table>

      <h2>Message counters (live)</h2>
      <table>
        <tbody>
          <tr>
            <th>Drafted / queued</th>
            <td className="num">{stats.drafted}</td>
            <th>Outbound total</th>
            <td className="num">{stats.outbound}</td>
          </tr>
          <tr>
            <th>Sent</th>
            <td className="num">{stats.sent}</td>
            <th>Delivered</th>
            <td className="num">{stats.delivered}</td>
          </tr>
          <tr>
            <th>Bounced (hard)</th>
            <td className="num">
              {stats.bounced} ({stats.hardBounced})
            </td>
            <th>Complained</th>
            <td className="num">{stats.complained}</td>
          </tr>
          <tr>
            <th>Inbound replies</th>
            <td className="num">{stats.inbound}</td>
            <th>&nbsp;</th>
            <td>&nbsp;</td>
          </tr>
        </tbody>
      </table>

      <h2>Metrics snapshots</h2>
      {metrics.length === 0 ? (
        <p className="muted">No snapshot has been captured yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Captured</th>
              <th className="num">Sent</th>
              <th className="num">Delivered</th>
              <th className="num">Hard bounce</th>
              <th className="num">Replied</th>
              <th className="num">Positive</th>
              <th className="num">Unsub</th>
              <th className="num">Visits</th>
              <th className="num">Signups</th>
              <th className="num">Price acc.</th>
              <th className="num">Unique cos.</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((row) => (
              <tr key={row.id}>
                <td className="small">{formatDate(row.captured_at)}</td>
                <td className="num">{row.sent}</td>
                <td className="num">{row.delivered}</td>
                <td className="num">{row.hard_bounced}</td>
                <td className="num">{row.replied}</td>
                <td className="num">{row.positive_replies}</td>
                <td className="num">{row.unsubscribed}</td>
                <td className="num">{row.landing_visits}</td>
                <td className="num">{row.pilot_signups}</td>
                <td className="num">{row.explicit_price_acceptances}</td>
                <td className="num">{row.unique_companies_committed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Commitments</h2>
      {summary.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <>
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th className="num">Rows</th>
                <th className="num">Unique companies</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((row) => (
                <tr key={row.type}>
                  <td>{row.type}</td>
                  <td className="num">{row.rows}</td>
                  <td className="num">
                    <strong>{row.uniqueCompanies}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Company key</th>
                <th>Type</th>
                <th>Source</th>
                <th>Price</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {commitments.map((row) => (
                <tr key={row.id}>
                  <td className="small">{formatDate(row.created_at)}</td>
                  <td className="breakall small">{cleanText(row.company_key, 100)}</td>
                  <td className="small">{row.type}</td>
                  <td className="small">
                    {row.source}
                    {row.verified ? '' : ' (unverified)'}
                  </td>
                  <td className="num">
                    {row.price_monthly === null ? '—' : formatPrice(row.price_monthly)}
                  </td>
                  <td className="small">{cleanText(row.evidence_text, 300)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h2>Messages (most recent 40)</h2>
      {messages.length === 0 ? (
        <p className="muted">No messages.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Dir</th>
              <th>Step</th>
              <th>Company</th>
              <th>Status</th>
              <th>Classification</th>
              <th>Subject</th>
            </tr>
          </thead>
          <tbody>
            {messages.map((message) => (
              <tr key={message.id}>
                <td className="small">
                  {formatDate(message.sent_at ?? message.received_at ?? message.created_at)}
                </td>
                <td className="small">{message.direction}</td>
                <td className="num">{message.sequence_step}</td>
                <td className="small">
                  {message.prospect_id ? (
                    <a href={`/admin/prospects/${encodeURIComponent(message.prospect_id)}`}>
                      {cleanText(message.company_name, 60) || 'prospect'}
                    </a>
                  ) : (
                    '—'
                  )}
                </td>
                <td className={`small ${message.status === 'BOUNCED' ? 'bad' : ''}`}>
                  {message.status}
                </td>
                <td className="small">
                  {message.classification ?? '—'}
                  {message.requires_human ? ' (needs human)' : ''}
                </td>
                <td className="small">{cleanText(message.subject, 120) || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
