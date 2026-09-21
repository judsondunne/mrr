/**
 * Which PUBLIC contact role actually works.
 *
 * `wholesale@` might out-perform `hello@` for one ICP and be useless for
 * another. That is an empirical question, so it is learned per
 * (role x ICP x opportunity class) instead of being hard-coded.
 *
 * THE RULE THAT DOES NOT MOVE: this never invents an address. It classifies
 * the local part of an address the prospecting layer already found published
 * on the business's own website. Learning that `wholesale@` converts best does
 * NOT license guessing `wholesale@` for a store that never published it — the
 * only thing `bestContactRole` can do is influence which published address is
 * preferred when a business publishes more than one.
 */
import { getDb, many, one, toNumber } from '../../lib/db';
import { newId, slugify } from '../../lib/hash';
import { createLogger } from '../../lib/logger';

const logger = createLogger('outreach:contact-role');

/** Canonical role buckets. Anything unrecognised is OTHER, never invented. */
export const CONTACT_ROLES = [
  'wholesale',
  'sales',
  'orders',
  'hello',
  'info',
  'contact',
  'support',
  'help',
  'service',
  'founder',
  'owner',
  'team',
  'admin',
  'accounts',
  'other',
] as const;
export type ContactRole = (typeof CONTACT_ROLES)[number];

const ROLE_ALIASES: ReadonlyArray<{ role: ContactRole; pattern: RegExp }> = [
  { role: 'wholesale', pattern: /^(wholesale|trade|b2b|bulk|reseller|retailers?)$/ },
  { role: 'sales', pattern: /^(sales|newbusiness|biz|business|partnerships?|partners)$/ },
  { role: 'orders', pattern: /^(orders?|purchasing|buying|procurement)$/ },
  { role: 'hello', pattern: /^(hello|hi|hey|hola|shop|store)$/ },
  { role: 'info', pattern: /^(info|information|inquiries|enquiries|general)$/ },
  { role: 'contact', pattern: /^(contact|contactus|reachus|mail|email)$/ },
  { role: 'support', pattern: /^(support|customerservice|customercare|cs)$/ },
  { role: 'help', pattern: /^(help|helpdesk|assist)$/ },
  { role: 'service', pattern: /^(service|services|care)$/ },
  { role: 'founder', pattern: /^(founder|ceo|md|director)$/ },
  { role: 'owner', pattern: /^(owner|proprietor)$/ },
  { role: 'team', pattern: /^(team|crew|people|staff|us|we)$/ },
  { role: 'admin', pattern: /^(admin|administration|office|reception)$/ },
  { role: 'accounts', pattern: /^(accounts?|accounting|billing|finance|ap|ar)$/ },
];

/** The role bucket for an address we already hold. Never generates one. */
export function roleKeyFor(email: string | null | undefined): ContactRole {
  const at = (email ?? '').indexOf('@');
  if (at <= 0) return 'other';
  const local = email!.slice(0, at).trim().toLowerCase().replace(/[.\-_+]/g, '');
  if (local === '') return 'other';
  for (const alias of ROLE_ALIASES) {
    if (alias.pattern.test(local)) return alias.role;
  }
  return 'other';
}

/** Short stable bucket keys. NULLs would break the table's UNIQUE index. */
function bucket(value: string | null | undefined, fallback = 'unknown'): string {
  const slug = slugify((value ?? '').trim());
  return slug === '' ? fallback : slug.slice(0, 60);
}

export interface RoleContext {
  roleKey: string;
  icp: string;
  opportunityClass: string;
}

/**
 * Derives the learning key for a prospect from data we already stored: the
 * opportunity's target customer is the ICP, its category is the opportunity
 * class.
 */
export async function roleContextForCampaign(params: {
  campaignId: string | null;
  email: string | null;
}): Promise<RoleContext | null> {
  if (!params.campaignId) return null;
  const row = await one<{ target_customer: string | null; category: string | null; ecosystem: string | null }>(
    `SELECT o.target_customer, o.category, o.ecosystem
       FROM campaigns c JOIN opportunities o ON o.id = c.opportunity_id
      WHERE c.id = $1`,
    [params.campaignId],
  );
  if (!row) return null;
  return {
    roleKey: roleKeyFor(params.email),
    icp: bucket(row.target_customer),
    opportunityClass: bucket(row.category ?? row.ecosystem),
  };
}

export interface RoleOutcome {
  sent?: number;
  delivered?: number;
  bounced?: number;
  replies?: number;
  commitments?: number;
}

/** Additive counters. Every increment is idempotent-safe at the row level. */
export async function recordRoleOutcome(context: RoleContext, outcome: RoleOutcome): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO contact_role_performance
       (id, role_key, icp, opportunity_class, sent, delivered, bounced, replies, commitments)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (role_key, icp, opportunity_class) DO UPDATE
        SET sent        = contact_role_performance.sent + EXCLUDED.sent,
            delivered   = contact_role_performance.delivered + EXCLUDED.delivered,
            bounced     = contact_role_performance.bounced + EXCLUDED.bounced,
            replies     = contact_role_performance.replies + EXCLUDED.replies,
            commitments = contact_role_performance.commitments + EXCLUDED.commitments,
            updated_at  = now()`,
    [
      newId('crp'),
      context.roleKey,
      context.icp,
      context.opportunityClass,
      outcome.sent ?? 0,
      outcome.delivered ?? 0,
      outcome.bounced ?? 0,
      outcome.replies ?? 0,
      outcome.commitments ?? 0,
    ],
  );
}

/** Convenience wrapper used by the send and webhook paths. */
export async function recordRoleOutcomeFor(
  params: { campaignId: string | null; email: string | null },
  outcome: RoleOutcome,
): Promise<void> {
  const context = await roleContextForCampaign(params);
  if (!context) return;
  await recordRoleOutcome(context, outcome);
}

export interface RolePerformance {
  roleKey: string;
  icp: string;
  opportunityClass: string;
  sent: number;
  delivered: number;
  bounced: number;
  replies: number;
  commitments: number;
  commitmentRate: number;
  hasSufficientSample: boolean;
}

export async function rolePerformance(params: {
  icp?: string | null;
  opportunityClass?: string | null;
  minSample?: number;
}): Promise<RolePerformance[]> {
  const minSample = Math.max(1, params.minSample ?? 20);
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (params.icp) {
    values.push(bucket(params.icp));
    clauses.push(`icp = $${values.length}`);
  }
  if (params.opportunityClass) {
    values.push(bucket(params.opportunityClass));
    clauses.push(`opportunity_class = $${values.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const rows = await many<{
    role_key: string;
    icp: string | null;
    opportunity_class: string | null;
    sent: string | number;
    delivered: string | number;
    bounced: string | number;
    replies: string | number;
    commitments: string | number;
  }>(
    `SELECT role_key, icp, opportunity_class, sent, delivered, bounced, replies, commitments
       FROM contact_role_performance ${where}
      ORDER BY commitments DESC, delivered DESC`,
    values,
  );

  return rows.map((row) => {
    const delivered = toNumber(row.delivered);
    const commitments = toNumber(row.commitments);
    return {
      roleKey: row.role_key,
      icp: row.icp ?? 'unknown',
      opportunityClass: row.opportunity_class ?? 'unknown',
      sent: toNumber(row.sent),
      delivered,
      bounced: toNumber(row.bounced),
      replies: toNumber(row.replies),
      commitments,
      commitmentRate: commitments / Math.max(delivered, 1),
      hasSufficientSample: delivered >= minSample,
    };
  });
}

/**
 * The best-performing published role for this segment, or null while the
 * evidence is too thin to have an opinion. A null answer means "keep using
 * whatever address the business actually published", which is the safe default.
 */
export async function bestContactRole(params: {
  icp?: string | null;
  opportunityClass?: string | null;
  minSample?: number;
}): Promise<RolePerformance | null> {
  const rows = (await rolePerformance(params)).filter((r) => r.hasSufficientSample);
  if (rows.length === 0) return null;
  let winner = rows[0]!;
  for (const row of rows) if (row.commitmentRate > winner.commitmentRate) winner = row;
  logger.debug('best contact role', { role: winner.roleKey, rate: winner.commitmentRate });
  return winner;
}
