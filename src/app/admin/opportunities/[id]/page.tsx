/**
 * The primary debugging surface.
 *
 * Shows the whole funnel for one opportunity — Evidence → Wedge → Prospects →
 * Campaign → Commitments → Gate — and, above everything else, the complete
 * list of gate checks that are NOT met. Nothing is summarised away: if a check
 * is unmet, its `detail` string is rendered verbatim.
 */
import { notFound } from 'next/navigation';
import { requireAdminPage } from '@/app/admin/auth';
import { loadGateEvaluation } from '@/app/_lib/gate';
import {
  getCampaignsForOpportunity,
  getCommitmentSummary,
  getCompetitors,
  getComplaintClusters,
  getOpportunity,
  getProspectStatusCounts,
  listAuditEvents,
  listProspects,
} from '@/app/_lib/queries';
import {
  asArray,
  asRecord,
  cleanList,
  cleanText,
  formatDate,
  formatPrice,
  safeHref,
} from '@/app/_lib/text';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type PageProps = { params: Promise<{ id: string }> };

function ExternalLink({ url, label }: { url: unknown; label?: string }) {
  const href = safeHref(url);
  if (!href) return <span className="muted">{cleanText(url, 120) || '—'}</span>;
  return (
    <a href={href} rel="nofollow noopener noreferrer" target="_blank" className="breakall">
      {cleanText(label ?? href, 120)}
    </a>
  );
}

export default async function OpportunityDetailPage({ params }: PageProps) {
  await requireAdminPage('/admin/opportunities');

  const { id } = await params;
  const opportunity = await getOpportunity(id);
  if (!opportunity) notFound();

  const [competitors, clusters, prospectCounts, prospects, campaigns, gate, audit] =
    await Promise.all([
      getCompetitors(id),
      getComplaintClusters(id),
      getProspectStatusCounts(id),
      listProspects(id, 15),
      getCampaignsForOpportunity(id),
      loadGateEvaluation(id),
      listAuditEvents('opportunity', id, 25),
    ]);

  const latestCampaign = campaigns[0] ?? null;
  const commitmentSummary = latestCampaign ? await getCommitmentSummary(latestCampaign.id) : [];
  const wedge = asRecord(opportunity.wedge_json);
  const isReady = opportunity.state === 'READY_TO_BUILD';

  return (
    <main className="wrap wide">
      <p className="small">
        <a href="/admin/opportunities">← all opportunities</a>
      </p>

      <h1>{cleanText(opportunity.name, 120) || opportunity.id}</h1>
      <p className="muted small breakall">
        {opportunity.id} · {cleanText(opportunity.ecosystem, 40)} /{' '}
        {cleanText(opportunity.category, 60)} · created {formatDate(opportunity.created_at)} ·
        updated {formatDate(opportunity.updated_at)}
      </p>

      <table>
        <tbody>
          <tr>
            <th style={{ width: '16rem' }}>State</th>
            <td>
              <strong>{opportunity.state}</strong>
              {opportunity.rejection_reason ? (
                <> — rejected: {cleanText(opportunity.rejection_reason, 120)}</>
              ) : null}
            </td>
          </tr>
          <tr>
            <th>Evidence confidence</th>
            <td>{opportunity.evidence_confidence ?? '—'}</td>
          </tr>
          <tr>
            <th>Proposed price</th>
            <td>
              {opportunity.proposed_price_monthly === null
                ? '—'
                : `${formatPrice(opportunity.proposed_price_monthly)}/month`}
            </td>
          </tr>
          <tr>
            <th>Estimated build days</th>
            <td>{opportunity.estimated_build_days ?? '—'}</td>
          </tr>
          <tr>
            <th>Next action</th>
            <td>{formatDate(opportunity.next_action_at)}</td>
          </tr>
          <tr>
            <th>Source</th>
            <td>
              <ExternalLink url={opportunity.source_url} />
            </td>
          </tr>
        </tbody>
      </table>

      {/* ---------------------------------------------------------------- */}
      {/* WHY THIS IS NOT READY — the reason this page exists.              */}
      {/* ---------------------------------------------------------------- */}
      <section>
        {gate.ok && gate.evaluation.passed && isReady ? (
          <div className="panel">
            <h2 style={{ marginTop: 0 }}>GATE PASSED</h2>
            <p>
              Every check below is met and this opportunity is in{' '}
              <strong>{opportunity.state}</strong>. Evaluated {gate.evaluation.evaluatedAt}.
            </p>
          </div>
        ) : (
          <div className="panel blocked">
            <h2 style={{ marginTop: 0 }}>WHY THIS IS NOT READY</h2>

            {!gate.ok ? (
              <>
                <p className="bad">
                  <strong>The gate could not be evaluated.</strong> Treat this as NOT ready: an
                  unevaluated gate is never a pass.
                </p>
                <p className="small breakall">Reason: {cleanText(gate.error, 400)}</p>
              </>
            ) : gate.evaluation.unmetChecks.length === 0 ? (
              <p>
                {gate.evaluation.passed
                  ? `Every gate check is met, but the opportunity is still in ${opportunity.state}. It becomes READY_TO_BUILD when the evaluate_campaigns job next runs.`
                  : 'The gate reported a failure without listing an unmet check. That is a bug in the validation layer — report it.'}
              </p>
            ) : (
              <>
                <p>
                  <strong>
                    {gate.evaluation.unmetChecks.length} of {gate.evaluation.checks.length} checks
                    are not met.
                  </strong>{' '}
                  Every one of them must pass before this can become READY_TO_BUILD.
                </p>
                <ol>
                  {gate.evaluation.unmetChecks.map((check) => (
                    <li key={check.id}>
                      <strong>{cleanText(check.label, 160) || check.id}</strong>
                      <div>{cleanText(check.detail, 400)}</div>
                      <div className="small muted">
                        id: {cleanText(check.id, 80)} · have {cleanText(String(check.actual), 80)} ·
                        need {cleanText(String(check.required), 80)}
                      </div>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </div>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* 1. EVIDENCE                                                       */}
      {/* ---------------------------------------------------------------- */}
      <h2>1. Evidence — does this category already take money?</h2>
      {competitors.length === 0 ? (
        <p className="muted">No competitors recorded.</p>
      ) : (
        competitors.map((competitor) => {
          const evidence = asArray(competitor.payment_evidence_json);
          return (
            <div className="panel" key={competitor.id}>
              <h3 style={{ marginTop: 0 }}>{cleanText(competitor.name, 120)}</h3>
              <p className="small">
                <ExternalLink url={competitor.url} />
              </p>
              <ul className="small">
                <li>Pricing: {cleanText(competitor.current_pricing, 200) || '—'}</li>
                <li>
                  Permanent free tier:{' '}
                  {competitor.has_permanent_free_tier === null
                    ? 'unknown'
                    : competitor.has_permanent_free_tier
                      ? 'yes'
                      : 'no'}
                  {competitor.free_plan_details
                    ? ` (${cleanText(competitor.free_plan_details, 160)})`
                    : ''}
                </li>
                <li>
                  Reviews: {competitor.review_count ?? '—'} · rating {competitor.rating ?? '—'} ·
                  age {cleanText(competitor.launch_age, 60) || '—'}
                </li>
              </ul>
              {evidence.length === 0 ? (
                <p className="small muted">No payment-evidence items extracted.</p>
              ) : (
                <ul className="small">
                  {evidence.slice(0, 12).map((raw, i) => {
                    const item = asRecord(raw);
                    return (
                      <li key={`ev-${competitor.id}-${i}`}>
                        <strong>{cleanText(item.type, 60) || 'EVIDENCE'}</strong> (
                        {cleanText(item.confidence, 20) || '?'}):{' '}
                        {cleanText(item.quote, 300) || '(no quote)'}{' '}
                        <ExternalLink url={item.sourceUrl} label="source" />
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })
      )}

      {clusters.length > 0 ? (
        <>
          <h3>Complaint clusters</h3>
          <table>
            <thead>
              <tr>
                <th>Cluster</th>
                <th className="num">Count</th>
                <th>Severity</th>
                <th>Wedge relevance</th>
              </tr>
            </thead>
            <tbody>
              {clusters.map((cluster) => (
                <tr key={cluster.id}>
                  <td>
                    <strong>{cleanText(cluster.name, 120)}</strong>
                    <div className="small muted">{cleanText(cluster.description, 300)}</div>
                  </td>
                  <td className="num">{cluster.count}</td>
                  <td>{cleanText(cluster.severity, 20)}</td>
                  <td className="small">
                    {cleanText(cluster.proposed_wedge_relevance, 200) || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {/* 2. WEDGE                                                          */}
      {/* ---------------------------------------------------------------- */}
      <h2>2. Wedge — what exactly would we build?</h2>
      {Object.keys(wedge).length === 0 ? (
        <p className="muted">
          No wedge generated yet.{' '}
          {opportunity.proposed_wedge
            ? `Stored summary: ${cleanText(opportunity.proposed_wedge, 400)}`
            : null}
        </p>
      ) : (
        <table>
          <tbody>
            <tr>
              <th style={{ width: '16rem' }}>Statement</th>
              <td>{cleanText(wedge.statement, 400) || '—'}</td>
            </tr>
            <tr>
              <th>Product name</th>
              <td>{cleanText(wedge.productName, 120) || '—'}</td>
            </tr>
            <tr>
              <th>Target customer</th>
              <td>{cleanText(wedge.targetCustomer, 300) || '—'}</td>
            </tr>
            <tr>
              <th>Core workflow</th>
              <td>{cleanText(wedge.coreWorkflow, 600) || '—'}</td>
            </tr>
            <tr>
              <th>v1 features</th>
              <td>
                <ul>
                  {cleanList(wedge.v1Features, 8, 200).map((item, i) => (
                    <li key={`f-${i}`}>{item}</li>
                  ))}
                </ul>
              </td>
            </tr>
            <tr>
              <th>Excluded from v1</th>
              <td>
                <ul>
                  {cleanList(wedge.excludedFromV1, 12, 200).map((item, i) => (
                    <li key={`x-${i}`}>{item}</li>
                  ))}
                </ul>
              </td>
            </tr>
            <tr>
              <th>Primary competitor</th>
              <td>{cleanText(wedge.primaryCompetitor, 200) || '—'}</td>
            </tr>
            <tr>
              <th>Reason to switch</th>
              <td>{cleanText(wedge.reasonSomeoneWouldSwitch, 600) || '—'}</td>
            </tr>
          </tbody>
        </table>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* 3. PROSPECTS                                                      */}
      {/* ---------------------------------------------------------------- */}
      <h2>3. Prospects — are there real, reachable businesses?</h2>
      {prospectCounts.length === 0 ? (
        <p className="muted">No prospects discovered yet.</p>
      ) : (
        <>
          <p>
            {prospectCounts.map((row, i) => (
              <span key={row.label}>
                {i > 0 ? ' · ' : ''}
                {row.label}: <strong>{row.n}</strong>
              </span>
            ))}
          </p>
          <table>
            <thead>
              <tr>
                <th>Company</th>
                <th>Domain</th>
                <th>Status</th>
                <th>Contact</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {prospects.map((prospect) => (
                <tr key={prospect.id}>
                  <td>
                    <a href={`/admin/prospects/${encodeURIComponent(prospect.id)}`}>
                      {cleanText(prospect.company_name, 80) || prospect.id}
                    </a>
                  </td>
                  <td className="breakall small">{cleanText(prospect.domain, 80)}</td>
                  <td>{prospect.status}</td>
                  <td className="small breakall">
                    {prospect.contact_email ? cleanText(prospect.contact_email, 80) : '—'}
                    {prospect.email_is_public ? '' : ' (not public)'}
                  </td>
                  <td className="small">
                    <ExternalLink url={prospect.public_evidence_url} label="evidence" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted">Showing the first 15 prospects.</p>
        </>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* 4. CAMPAIGN                                                       */}
      {/* ---------------------------------------------------------------- */}
      <h2>4. Campaign — what did we actually send?</h2>
      {campaigns.length === 0 ? (
        <p className="muted">No campaign yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Campaign</th>
              <th>State</th>
              <th>Price</th>
              <th>Target</th>
              <th>Landing page</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map((campaign) => (
              <tr key={campaign.id}>
                <td>
                  <a href={`/admin/campaigns/${encodeURIComponent(campaign.id)}`}>
                    {cleanText(campaign.offer_name, 60) || campaign.id}
                  </a>
                </td>
                <td>
                  {campaign.state}
                  {campaign.halt_reason ? (
                    <div className="small bad">{cleanText(campaign.halt_reason, 120)}</div>
                  ) : null}
                </td>
                <td className="num">{formatPrice(campaign.price_monthly)}/mo</td>
                <td className="num">{campaign.target_count}</td>
                <td className="small breakall">
                  <a href={`/v/${encodeURIComponent(campaign.landing_slug)}`}>
                    /v/{cleanText(campaign.landing_slug, 60)}
                  </a>
                </td>
                <td className="small">{formatDate(campaign.started_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* 5. COMMITMENTS                                                    */}
      {/* ---------------------------------------------------------------- */}
      <h2>5. Commitments — who said they would pay?</h2>
      {!latestCampaign ? (
        <p className="muted">No campaign, so no commitments.</p>
      ) : commitmentSummary.length === 0 ? (
        <p className="muted">
          No commitments recorded for the latest campaign. This is the normal state for a campaign
          that has just started sending.
        </p>
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
              {commitmentSummary.map((row) => (
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
          <p className="small muted">
            Only the unique-company column matters to the gate. Full list on the{' '}
            <a href={`/admin/campaigns/${encodeURIComponent(latestCampaign.id)}`}>campaign page</a>.
          </p>
        </>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* 6. GATE                                                           */}
      {/* ---------------------------------------------------------------- */}
      <h2>6. Gate status — every check, passed and unmet</h2>
      {!gate.ok ? (
        <p className="bad">Gate could not be evaluated: {cleanText(gate.error, 300)}</p>
      ) : (
        <>
          <p className="small muted">
            Evaluated {gate.evaluation.evaluatedAt} · campaign{' '}
            {gate.evaluation.campaignId ?? 'none'} · overall{' '}
            <strong className={gate.evaluation.passed ? 'ok' : 'bad'}>
              {gate.evaluation.passed ? 'PASS' : 'FAIL'}
            </strong>
          </p>
          <table>
            <thead>
              <tr>
                <th style={{ width: '3rem' }}>&nbsp;</th>
                <th>Check</th>
                <th>Detail</th>
                <th className="num">Have</th>
                <th className="num">Need</th>
              </tr>
            </thead>
            <tbody>
              {gate.evaluation.checks.map((check) => (
                <tr key={check.id}>
                  <td>{check.passed ? '✅' : '❌'}</td>
                  <td>
                    <strong>{cleanText(check.label, 160) || check.id}</strong>
                    <div className="small muted">{cleanText(check.id, 80)}</div>
                  </td>
                  <td className={check.passed ? 'small' : 'small bad'}>
                    {cleanText(check.detail, 400)}
                  </td>
                  <td className="num">{cleanText(String(check.actual), 40)}</td>
                  <td className="num">{cleanText(String(check.required), 40)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {/* ---------------------------------------------------------------- */}
      <h2>Audit trail</h2>
      {audit.length === 0 ? (
        <p className="muted">No audit events.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Event</th>
              <th>Actor</th>
              <th>Transition</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {audit.map((event) => (
              <tr key={event.id}>
                <td className="small">{formatDate(event.created_at)}</td>
                <td className="small">{event.event_type}</td>
                <td className="small">{cleanText(event.actor, 60)}</td>
                <td className="small">
                  {event.from_state || event.to_state
                    ? `${event.from_state ?? '?'} → ${event.to_state ?? '?'}`
                    : '—'}
                </td>
                <td className="small">{cleanText(event.reason, 200) || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
