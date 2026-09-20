/**
 * Read-only queries for the admin dashboard.
 *
 * Every statement is parameterized; no caller value is ever interpolated into
 * SQL text. Nothing in this module writes.
 */
import { getDb, toNumber } from '@/lib/db';

export interface OpportunityListRow {
  id: string;
  name: string;
  ecosystem: string;
  category: string;
  state: string;
  evidence_confidence: string | null;
  rejection_reason: string | null;
  next_action_at: string | null;
  updated_at: string | null;
  proposed_price_monthly: string | number | null;
  campaign_state: string | null;
}

export async function listOpportunities(state?: string | null): Promise<OpportunityListRow[]> {
  const db = await getDb();
  const filtered = typeof state === 'string' && state !== '';
  const { rows } = await db.query<OpportunityListRow>(
    `SELECT o.id, o.name, o.ecosystem, o.category, o.state, o.evidence_confidence,
            o.rejection_reason, o.next_action_at, o.updated_at, o.proposed_price_monthly,
            (SELECT c.state FROM campaigns c
              WHERE c.opportunity_id = o.id
              ORDER BY c.created_at DESC LIMIT 1) AS campaign_state
       FROM opportunities o
      ${filtered ? 'WHERE o.state = $1' : ''}
      ORDER BY o.updated_at DESC NULLS LAST
      LIMIT 300`,
    filtered ? [state] : [],
  );
  return rows;
}

export interface OpportunityRow extends OpportunityListRow {
  description: string;
  source_url: string | null;
  proposed_wedge: string | null;
  target_customer: string | null;
  estimated_build_days: number | null;
  prospectability_score: string | number | null;
  validation_score: string | number | null;
  wedge_json: unknown;
  created_at: string | null;
}

export async function getOpportunity(id: string): Promise<OpportunityRow | null> {
  const db = await getDb();
  const { rows } = await db.query<OpportunityRow>(
    `SELECT o.id, o.name, o.ecosystem, o.category, o.state, o.evidence_confidence,
            o.rejection_reason, o.next_action_at, o.updated_at, o.created_at,
            o.proposed_price_monthly, o.description, o.source_url, o.proposed_wedge,
            o.target_customer, o.estimated_build_days, o.prospectability_score,
            o.validation_score, o.wedge_json,
            (SELECT c.state FROM campaigns c
              WHERE c.opportunity_id = o.id
              ORDER BY c.created_at DESC LIMIT 1) AS campaign_state
       FROM opportunities o
      WHERE o.id = $1
      LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export interface CompetitorRow {
  id: string;
  name: string;
  url: string;
  current_pricing: string | null;
  free_plan_details: string | null;
  has_permanent_free_tier: boolean | null;
  review_count: number | null;
  rating: string | number | null;
  launch_age: string | null;
  payment_evidence_json: unknown;
}

export async function getCompetitors(opportunityId: string): Promise<CompetitorRow[]> {
  const db = await getDb();
  const { rows } = await db.query<CompetitorRow>(
    `SELECT id, name, url, current_pricing, free_plan_details, has_permanent_free_tier,
            review_count, rating, launch_age, payment_evidence_json
       FROM competitors
      WHERE opportunity_id = $1
      ORDER BY created_at ASC
      LIMIT 50`,
    [opportunityId],
  );
  return rows;
}

export interface ComplaintClusterRow {
  id: string;
  name: string;
  description: string;
  count: number;
  severity: string;
  proposed_wedge_relevance: string | null;
}

export async function getComplaintClusters(opportunityId: string): Promise<ComplaintClusterRow[]> {
  const db = await getDb();
  const { rows } = await db.query<ComplaintClusterRow>(
    `SELECT id, name, description, count, severity, proposed_wedge_relevance
       FROM complaint_clusters
      WHERE opportunity_id = $1
      ORDER BY count DESC
      LIMIT 25`,
    [opportunityId],
  );
  return rows;
}

export interface CountRow {
  label: string;
  n: number;
}

export async function getProspectStatusCounts(opportunityId: string): Promise<CountRow[]> {
  const db = await getDb();
  const { rows } = await db.query<{ status: string; n: string | number }>(
    `SELECT status, COUNT(*) AS n
       FROM prospects
      WHERE opportunity_id = $1
      GROUP BY status
      ORDER BY status`,
    [opportunityId],
  );
  return rows.map((r) => ({ label: r.status, n: toNumber(r.n) }));
}

export interface ProspectRow {
  id: string;
  company_name: string;
  domain: string;
  status: string;
  country: string | null;
  contact_email: string | null;
  email_is_public: boolean;
  public_evidence_url: string | null;
  contact_source_url: string | null;
  qualification_reason: string | null;
  qualification_score: string | number | null;
  suppressed_at: string | null;
  created_at: string | null;
  opportunity_id: string;
  evidence_json: unknown;
}

export async function listProspects(opportunityId: string, limit = 25): Promise<ProspectRow[]> {
  const db = await getDb();
  const { rows } = await db.query<ProspectRow>(
    `SELECT id, company_name, domain, status, country, contact_email, email_is_public,
            public_evidence_url, contact_source_url, qualification_reason, qualification_score,
            suppressed_at, created_at, opportunity_id, evidence_json
       FROM prospects
      WHERE opportunity_id = $1
      ORDER BY created_at ASC
      LIMIT $2`,
    [opportunityId, limit],
  );
  return rows;
}

export async function getProspect(id: string): Promise<ProspectRow | null> {
  const db = await getDb();
  const { rows } = await db.query<ProspectRow>(
    `SELECT id, company_name, domain, status, country, contact_email, email_is_public,
            public_evidence_url, contact_source_url, qualification_reason, qualification_score,
            suppressed_at, created_at, opportunity_id, evidence_json
       FROM prospects
      WHERE id = $1
      LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export interface CampaignRow {
  id: string;
  opportunity_id: string;
  state: string;
  offer_name: string;
  price_monthly: string | number;
  landing_slug: string;
  landing_copy_json: unknown;
  target_count: number;
  halt_reason: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export async function getCampaignsForOpportunity(opportunityId: string): Promise<CampaignRow[]> {
  const db = await getDb();
  const { rows } = await db.query<CampaignRow>(
    `SELECT id, opportunity_id, state, offer_name, price_monthly, landing_slug,
            landing_copy_json, target_count, halt_reason, started_at, ended_at,
            created_at, updated_at
       FROM campaigns
      WHERE opportunity_id = $1
      ORDER BY created_at DESC
      LIMIT 10`,
    [opportunityId],
  );
  return rows;
}

export async function getCampaign(id: string): Promise<CampaignRow | null> {
  const db = await getDb();
  const { rows } = await db.query<CampaignRow>(
    `SELECT id, opportunity_id, state, offer_name, price_monthly, landing_slug,
            landing_copy_json, target_count, halt_reason, started_at, ended_at,
            created_at, updated_at
       FROM campaigns
      WHERE id = $1
      LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export interface MessageStats {
  outbound: number;
  sent: number;
  delivered: number;
  bounced: number;
  hardBounced: number;
  complained: number;
  inbound: number;
  drafted: number;
}

export async function getMessageStats(campaignId: string): Promise<MessageStats> {
  const db = await getDb();
  const { rows } = await db.query<Record<string, string | number>>(
    `SELECT
        COUNT(*) FILTER (WHERE direction = 'OUTBOUND') AS outbound,
        COUNT(*) FILTER (WHERE direction = 'OUTBOUND'
                           AND status IN ('SENT','DELIVERED','BOUNCED','COMPLAINED')) AS sent,
        COUNT(*) FILTER (WHERE delivered_at IS NOT NULL) AS delivered,
        COUNT(*) FILTER (WHERE bounced_at IS NOT NULL) AS bounced,
        COUNT(*) FILTER (WHERE bounce_type = 'HARD') AS hard_bounced,
        COUNT(*) FILTER (WHERE complained_at IS NOT NULL) AS complained,
        COUNT(*) FILTER (WHERE direction = 'INBOUND') AS inbound,
        COUNT(*) FILTER (WHERE direction = 'OUTBOUND'
                           AND status IN ('PENDING','DRAFTED')) AS drafted
       FROM messages
      WHERE campaign_id = $1`,
    [campaignId],
  );
  const row = rows[0] ?? {};
  return {
    outbound: toNumber(row.outbound),
    sent: toNumber(row.sent),
    delivered: toNumber(row.delivered),
    bounced: toNumber(row.bounced),
    hardBounced: toNumber(row.hard_bounced),
    complained: toNumber(row.complained),
    inbound: toNumber(row.inbound),
    drafted: toNumber(row.drafted),
  };
}

export interface MessageRow {
  id: string;
  direction: string;
  sequence_step: number;
  subject: string;
  body: string;
  status: string;
  classification: string | null;
  intent_score: string | number | null;
  requires_human: boolean;
  sent_at: string | null;
  received_at: string | null;
  delivered_at: string | null;
  bounced_at: string | null;
  bounce_type: string | null;
  created_at: string | null;
  prospect_id: string | null;
  campaign_id: string | null;
  company_name: string | null;
}

export async function listCampaignMessages(campaignId: string, limit = 40): Promise<MessageRow[]> {
  const db = await getDb();
  const { rows } = await db.query<MessageRow>(
    `SELECT m.id, m.direction, m.sequence_step, m.subject, m.body, m.status, m.classification,
            m.intent_score, m.requires_human, m.sent_at, m.received_at, m.delivered_at,
            m.bounced_at, m.bounce_type, m.created_at, m.prospect_id, m.campaign_id,
            p.company_name
       FROM messages m
       LEFT JOIN prospects p ON p.id = m.prospect_id
      WHERE m.campaign_id = $1
      ORDER BY m.created_at DESC
      LIMIT $2`,
    [campaignId, limit],
  );
  return rows;
}

export async function listProspectMessages(prospectId: string, limit = 40): Promise<MessageRow[]> {
  const db = await getDb();
  const { rows } = await db.query<MessageRow>(
    `SELECT m.id, m.direction, m.sequence_step, m.subject, m.body, m.status, m.classification,
            m.intent_score, m.requires_human, m.sent_at, m.received_at, m.delivered_at,
            m.bounced_at, m.bounce_type, m.created_at, m.prospect_id, m.campaign_id,
            NULL AS company_name
       FROM messages m
      WHERE m.prospect_id = $1
      ORDER BY m.created_at ASC
      LIMIT $2`,
    [prospectId, limit],
  );
  return rows;
}

export interface CommitmentTypeSummary {
  type: string;
  rows: number;
  uniqueCompanies: number;
}

export async function getCommitmentSummary(campaignId: string): Promise<CommitmentTypeSummary[]> {
  const db = await getDb();
  const { rows } = await db.query<{ type: string; n: string | number; companies: string | number }>(
    `SELECT type, COUNT(*) AS n, COUNT(DISTINCT company_key) AS companies
       FROM commitments
      WHERE campaign_id = $1
      GROUP BY type
      ORDER BY type`,
    [campaignId],
  );
  return rows.map((r) => ({
    type: r.type,
    rows: toNumber(r.n),
    uniqueCompanies: toNumber(r.companies),
  }));
}

export interface CommitmentRow {
  id: string;
  company_key: string;
  type: string;
  price_monthly: string | number | null;
  source: string;
  evidence_text: string;
  evidence_url: string | null;
  verified: boolean;
  created_at: string | null;
  prospect_id: string | null;
}

export async function listCommitments(campaignId: string, limit = 50): Promise<CommitmentRow[]> {
  const db = await getDb();
  const { rows } = await db.query<CommitmentRow>(
    `SELECT id, company_key, type, price_monthly, source, evidence_text, evidence_url,
            verified, created_at, prospect_id
       FROM commitments
      WHERE campaign_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [campaignId, limit],
  );
  return rows;
}

export interface CampaignMetricRow {
  id: string;
  captured_at: string | null;
  sent: number;
  delivered: number;
  bounced: number;
  hard_bounced: number;
  replied: number;
  positive_replies: number;
  negative_replies: number;
  unsubscribed: number;
  complained: number;
  landing_visits: number;
  pilot_signups: number;
  explicit_price_acceptances: number;
  strong_commitments: number;
  unique_companies_committed: number;
}

export async function listCampaignMetrics(
  campaignId: string,
  limit = 10,
): Promise<CampaignMetricRow[]> {
  const db = await getDb();
  const { rows } = await db.query<CampaignMetricRow>(
    `SELECT id, captured_at, sent, delivered, bounced, hard_bounced, replied,
            positive_replies, negative_replies, unsubscribed, complained, landing_visits,
            pilot_signups, explicit_price_acceptances, strong_commitments,
            unique_companies_committed
       FROM campaign_metrics
      WHERE campaign_id = $1
      ORDER BY captured_at DESC
      LIMIT $2`,
    [campaignId, limit],
  );
  return rows;
}

export async function countLandingVisits(campaignId: string): Promise<number> {
  const db = await getDb();
  const { rows } = await db.query<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM landing_visits WHERE campaign_id = $1`,
    [campaignId],
  );
  return toNumber(rows[0]?.n);
}

export interface AuditRow {
  id: string;
  created_at: string | null;
  event_type: string;
  actor: string;
  from_state: string | null;
  to_state: string | null;
  reason: string | null;
}

export async function listAuditEvents(
  entityType: string,
  entityId: string,
  limit = 25,
): Promise<AuditRow[]> {
  const db = await getDb();
  const { rows } = await db.query<AuditRow>(
    `SELECT id, created_at, event_type, actor, from_state, to_state, reason
       FROM audit_events
      WHERE entity_type = $1 AND entity_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [entityType, entityId, limit],
  );
  return rows;
}

export interface JobRunRow {
  job: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  records_processed: number;
  error: string | null;
}

export async function getLastJobRun(): Promise<JobRunRow | null> {
  const db = await getDb();
  const { rows } = await db.query<JobRunRow>(
    `SELECT job, status, started_at, completed_at, records_processed, error
       FROM job_runs
      ORDER BY started_at DESC
      LIMIT 1`,
  );
  return rows[0] ?? null;
}

export async function listRecentJobRuns(limit = 10): Promise<JobRunRow[]> {
  const db = await getDb();
  const { rows } = await db.query<JobRunRow>(
    `SELECT job, status, started_at, completed_at, records_processed, error
       FROM job_runs
      ORDER BY started_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function countOpportunitiesByState(): Promise<CountRow[]> {
  const db = await getDb();
  const { rows } = await db.query<{ state: string; n: string | number }>(
    `SELECT state, COUNT(*) AS n FROM opportunities GROUP BY state ORDER BY state`,
  );
  return rows.map((r) => ({ label: r.state, n: toNumber(r.n) }));
}
