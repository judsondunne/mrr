/**
 * PUBLIC API — COMPANY IDENTITY + FATIGUE. Owned by the outreach agent.
 *
 * One real business = one row, across every campaign and experiment. This is
 * what stops the same shop being pestered by unrelated tests, and what makes
 * "unique company" mean the same thing everywhere.
 *
 * The identity key is the normalized registrable domain produced by
 * `src/pipeline/prospecting/domain.ts`. That normalizer is the system's single
 * definition of "same business"; there is deliberately not a second one here.
 *
 * Fatigue rules, in the order they are enforced:
 *   1. NEVER_CONTACT is TERMINAL. Unsubscribe, an explicit stop, or a spam
 *      complaint sets it, and nothing in this module can clear it — there is
 *      no `clearNeverContact`, and every other writer refuses to overwrite it.
 *   2. An explicit COOLDOWN is off limits until it expires.
 *   3. A company ENGAGED in one experiment is never pulled into another.
 *   4. A company contacted by an UNRELATED campaign inside
 *      `config.company.cooldownDays` (90) is off limits to that campaign.
 */
import { getConfig } from '../lib/config';
import { getDb, many, one, toNumber } from '../lib/db';
import { newId } from '../lib/hash';
import { createLogger } from '../lib/logger';
import { recordAudit } from '../lib/audit';
import { normalizeDomain, isDisallowedProspectDomain } from '../pipeline/prospecting/domain';
import type { ContactEligibility, ContactState } from './types';

const logger = createLogger('autonomy:company');

const MS_PER_DAY = 86_400_000;

/**
 * Consumer mailbox providers. A prospect on one of these is a person, but the
 * DOMAIN is not a company — counting it would collapse thousands of unrelated
 * businesses into a single "gmail.com" company and quietly destroy the
 * unique-company arithmetic the whole gate depends on.
 */
const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'hotmail.com',
  'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com',
  'mac.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.de', 'gmx.net',
  'web.de', 'yandex.com', 'yandex.ru', 'mail.com', 'mail.ru', 'zoho.com', 'fastmail.com',
  'hey.com', 'tutanota.com', 'inbox.com', 'qq.com', '163.com', '126.com',
]);

/**
 * Machines, not businesses: transactional relays, ticketing systems and
 * marketing platforms that send autoresponses on somebody else's behalf.
 */
const AUTORESPONDER_DOMAINS: ReadonlySet<string> = new Set([
  'amazonses.com', 'sendgrid.net', 'sendgrid.com', 'mailgun.org', 'mailgun.com',
  'sparkpostmail.com', 'mandrillapp.com', 'postmarkapp.com', 'mailjet.com', 'sendinblue.com',
  'brevo.com', 'resend.dev', 'resend.com', 'zendesk.com', 'freshdesk.com', 'freshservice.com',
  'helpscout.net', 'helpscout.com', 'groovehq.com', 'kayako.com', 'desk.com', 'front.com',
  'frontapp.com', 'intercom-mail.com', 'gorgias.com', 'reamaze.com', 'tidio.com',
  'bounces.google.com', 'srs.kundenserver.de', 'mailer-daemon.com',
]);

/** Domains that only ever appear in tests, fixtures and local development. */
const TEST_DOMAIN_SUFFIXES: readonly string[] = ['.test', '.local', '.localhost', '.invalid', '.example'];
const TEST_DOMAINS: ReadonlySet<string> = new Set([
  'example.com', 'example.org', 'example.net', 'example.edu', 'localhost',
  'mailinator.com', 'yopmail.com', 'guerrillamail.com', 'sharklasers.com', 'trashmail.com',
  'test.com', 'invalid.com',
]);

/**
 * The canonical company key. Falls back to a lowercased literal when the input
 * is not a usable domain (e.g. the "unknown" sentinel the commitment writer
 * uses), so a caller always gets a stable, comparable key back.
 */
export function companyKeyOf(input: string): string {
  const raw = (input ?? '').trim().toLowerCase();
  if (raw === '') return 'unknown';
  return normalizeDomain(raw) ?? raw;
}

/**
 * Deterministic, offline classification of a key that must never be counted as
 * a validating company. No model, no network, no judgement call.
 */
export function isCountableCompanyKey(companyKey: string): boolean {
  const key = companyKeyOf(companyKey);
  if (key === '' || key === 'unknown') return false;
  if (!key.includes('.')) return false;
  if (TEST_DOMAINS.has(key)) return false;
  if (TEST_DOMAIN_SUFFIXES.some((suffix) => key.endsWith(suffix))) return false;
  if (FREE_MAIL_DOMAINS.has(key)) return false;
  if (AUTORESPONDER_DOMAINS.has(key)) return false;
  // Marketplaces, platform vendors, directories, news and shorteners, plus the
  // gov/mil/edu suffixes — reuses the prospecting layer's single list.
  if (isDisallowedProspectDomain(key)) return false;

  const cfg = getConfig();
  // Our own infrastructure is never a prospect and never a data point.
  const ourDomains = [cfg.sendingDomain, domainPart(cfg.senderEmail), domainPart(cfg.ownerNotificationEmail), hostOf(cfg.publicBaseUrl)]
    .map((d) => (d ? companyKeyOf(d) : ''))
    .filter((d) => d !== '' && d !== 'unknown');
  if (ourDomains.includes(key)) return false;

  return true;
}

function domainPart(email: string): string {
  const at = (email ?? '').lastIndexOf('@');
  return at > 0 ? email.slice(at + 1) : '';
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

// --- rows --------------------------------------------------------------------

interface CompanyRow {
  id: string;
  company_key: string;
  display_name: string | null;
  merged_into: string | null;
  last_contacted_at: string | Date | null;
  last_campaign_id: string | null;
  total_campaigns: number | string;
  total_emails: number | string;
  contact_state: string;
  cooldown_until: string | Date | null;
  cooldown_reason: string | null;
  engaged_campaign_id: string | null;
  data_quality: string;
  is_internal_or_test: boolean;
}

const SELECT_COMPANY = `SELECT id, company_key, display_name, merged_into, last_contacted_at,
       last_campaign_id, total_campaigns, total_emails, contact_state, cooldown_until,
       cooldown_reason, engaged_campaign_id, data_quality, is_internal_or_test
  FROM company_registry`;

async function rowByKey(companyKey: string): Promise<CompanyRow | null> {
  return one<CompanyRow>(`${SELECT_COMPANY} WHERE company_key = $1`, [companyKeyOf(companyKey)]);
}

async function rowById(id: string): Promise<CompanyRow | null> {
  return one<CompanyRow>(`${SELECT_COMPANY} WHERE id = $1`, [id]);
}

/** Follows `merged_into` to the surviving row. Bounded, so a cycle cannot hang. */
async function resolveRow(companyKey: string): Promise<CompanyRow | null> {
  let row = await rowByKey(companyKey);
  for (let hops = 0; row?.merged_into && hops < 8; hops += 1) {
    const next: CompanyRow | null = await rowById(row.merged_into);
    if (!next || next.id === row.id) break;
    row = next;
  }
  return row;
}

/** The surviving company key for an alias. Callers count by this. */
export async function resolveCompanyKey(companyKey: string): Promise<string> {
  const row = await resolveRow(companyKey);
  return row?.company_key ?? companyKeyOf(companyKey);
}

function asDate(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(d.getTime()) ? d : null;
}

// --- writes ------------------------------------------------------------------

export async function upsertCompany(params: {
  companyKey: string;
  displayName?: string | null;
  dataQuality?: 'HIGH' | 'MEDIUM' | 'LOW';
}): Promise<{ id: string; companyKey: string }> {
  const key = companyKeyOf(params.companyKey);
  const db = await getDb();
  await db.query(
    `INSERT INTO company_registry (id, company_key, display_name, data_quality, is_internal_or_test)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (company_key) DO UPDATE
        SET display_name = COALESCE(company_registry.display_name, EXCLUDED.display_name),
            data_quality = COALESCE($6, company_registry.data_quality),
            -- Sticky: a domain classified as internal/test once stays flagged.
            is_internal_or_test = company_registry.is_internal_or_test OR EXCLUDED.is_internal_or_test,
            updated_at   = now()`,
    [
      newId('co'),
      key,
      params.displayName ?? null,
      params.dataQuality ?? 'MEDIUM',
      !isCountableCompanyKey(key),
      params.dataQuality ?? null,
    ],
  );
  const row = await resolveRow(key);
  return { id: row?.id ?? '', companyKey: row?.company_key ?? key };
}

/**
 * Enforces: NEVER_CONTACT is terminal; a company in cooldown is off limits;
 * a company actively engaged in one experiment is not pulled into another.
 *
 * This is the campaign-agnostic question — "may anything contact this
 * business right now?" — so an engagement or a recent contact by ANY campaign
 * blocks. `canContactCompanyForCampaign` is the variant the send path uses,
 * which lets a campaign keep talking to the company it is already talking to.
 */
export async function canContactCompany(companyKey: string): Promise<ContactEligibility> {
  return evaluateEligibility(companyKey, null);
}

/**
 * Campaign-aware fatigue check. Identical to `canContactCompany` except that
 * the engagement and the cross-campaign cooldown do not block the campaign
 * that owns them — following up on your own thread is not fatigue.
 */
export async function canContactCompanyForCampaign(
  companyKey: string,
  campaignId: string | null,
): Promise<ContactEligibility> {
  return evaluateEligibility(companyKey, campaignId);
}

async function evaluateEligibility(companyKey: string, campaignId: string | null): Promise<ContactEligibility> {
  const cfg = getConfig();
  const row = await resolveRow(companyKey);

  // A business we have never registered has no history, so nothing to be
  // fatigued by. It is registered on first contact.
  if (!row) return { allowed: true, reason: null, state: 'AVAILABLE', cooldownUntil: null };

  const state = (row.contact_state as ContactState) ?? 'AVAILABLE';

  if (state === 'NEVER_CONTACT') {
    return {
      allowed: false,
      reason: `NEVER_CONTACT:${row.cooldown_reason ?? 'opted out'}`,
      state: 'NEVER_CONTACT',
      cooldownUntil: null,
    };
  }

  const now = Date.now();
  const cooldownUntil = asDate(row.cooldown_until);
  if (state === 'COOLDOWN' && cooldownUntil && cooldownUntil.getTime() > now) {
    return {
      allowed: false,
      reason: `COOLDOWN:${row.cooldown_reason ?? 'recently contacted'}`,
      state: 'COOLDOWN',
      cooldownUntil,
    };
  }

  if (state === 'ENGAGED' && row.engaged_campaign_id && row.engaged_campaign_id !== campaignId) {
    return {
      allowed: false,
      reason: `ENGAGED_IN_ANOTHER_EXPERIMENT:${row.engaged_campaign_id}`,
      state: 'ENGAGED',
      cooldownUntil: null,
    };
  }

  // Cross-campaign fatigue: an UNRELATED campaign may not reach a business we
  // emailed inside the cooldown window.
  const lastContacted = asDate(row.last_contacted_at);
  if (lastContacted && row.last_campaign_id !== campaignId) {
    const until = new Date(lastContacted.getTime() + cfg.company.cooldownDays * MS_PER_DAY);
    if (until.getTime() > now) {
      return {
        allowed: false,
        reason: `CROSS_CAMPAIGN_COOLDOWN:${cfg.company.cooldownDays}d since ${row.last_campaign_id ?? 'a previous campaign'}`,
        state: 'COOLDOWN',
        cooldownUntil: until,
      };
    }
  }

  return {
    allowed: true,
    reason: null,
    state: state === 'ENGAGED' ? 'ENGAGED' : 'AVAILABLE',
    cooldownUntil: null,
  };
}

/** Records that a campaign actually emailed this business. */
export async function recordContact(params: { companyKey: string; campaignId: string }): Promise<void> {
  const key = await ensureRegistered(params.companyKey);
  const db = await getDb();
  await db.query(
    `UPDATE company_registry
        SET last_contacted_at = now(),
            total_emails      = total_emails + 1,
            total_campaigns   = total_campaigns + CASE WHEN last_campaign_id IS DISTINCT FROM $2 THEN 1 ELSE 0 END,
            last_campaign_id  = $2,
            updated_at        = now()
      WHERE company_key = $1`,
    [key, params.campaignId],
  );
}

/**
 * The business is in a live conversation with one experiment. Never overwrites
 * a terminal NEVER_CONTACT.
 */
export async function markEngaged(companyKey: string, campaignId: string): Promise<void> {
  const key = await ensureRegistered(companyKey);
  const db = await getDb();
  await db.query(
    `UPDATE company_registry
        SET contact_state       = 'ENGAGED',
            engaged_campaign_id = $2,
            cooldown_until      = NULL,
            updated_at          = now()
      WHERE company_key = $1 AND contact_state <> 'NEVER_CONTACT'`,
    [key, campaignId],
  );
}

/** Unsubscribe / explicit stop. Terminal and irreversible. */
export async function markNeverContact(companyKey: string, reason: string): Promise<void> {
  const key = await ensureRegistered(companyKey);
  const db = await getDb();
  const res = await db.query(
    `UPDATE company_registry
        SET contact_state       = 'NEVER_CONTACT',
            cooldown_reason     = $2,
            cooldown_until      = NULL,
            engaged_campaign_id = NULL,
            updated_at          = now()
      WHERE company_key = $1 AND contact_state <> 'NEVER_CONTACT'`,
    [key, reason.slice(0, 480)],
  );
  if (res.rowCount > 0) {
    logger.info('company marked NEVER_CONTACT', { companyKey: key, reason });
    await recordAudit({
      entityType: 'prospect',
      entityId: null,
      eventType: 'SUPPRESS',
      actor: 'autonomy:company',
      reason: `NEVER_CONTACT: ${reason}`,
      detail: { companyKey: key },
    });
  }
}

/**
 * Starts (or extends) a cooldown. Never shortens an existing one, and never
 * touches a terminal NEVER_CONTACT.
 */
export async function startCooldown(params: {
  companyKey: string;
  days: number;
  reason: string;
}): Promise<void> {
  const key = await ensureRegistered(params.companyKey);
  const days = Math.max(0, Math.floor(params.days));
  const db = await getDb();
  await db.query(
    `UPDATE company_registry
        SET contact_state       = 'COOLDOWN',
            cooldown_until      = GREATEST(COALESCE(cooldown_until, to_timestamp(0)),
                                           now() + ($2::int * interval '1 day')),
            cooldown_reason     = $3,
            engaged_campaign_id = NULL,
            updated_at          = now()
      WHERE company_key = $1 AND contact_state <> 'NEVER_CONTACT'`,
    [key, days, params.reason.slice(0, 480)],
  );
}

/** Bots, autoresponders, vendors and internal/test domains never count. */
export async function isCountableCompany(companyKey: string): Promise<boolean> {
  const row = await resolveRow(companyKey);
  const key = row?.company_key ?? companyKeyOf(companyKey);
  if (row?.is_internal_or_test === true) return false;
  return isCountableCompanyKey(key);
}

/**
 * Merges confidently-identical businesses so one company counts once.
 *
 * Merging may only ever make the surviving row MORE restrictive: a terminal
 * NEVER_CONTACT on either side survives, cooldowns take the later expiry, and
 * counters are summed.
 */
export async function mergeCompanies(primaryKey: string, duplicateKey: string): Promise<void> {
  const primaryK = companyKeyOf(primaryKey);
  const duplicateK = companyKeyOf(duplicateKey);
  if (primaryK === duplicateK) return;

  await ensureRegistered(primaryK);
  const primary = await resolveRow(primaryK);
  const duplicate = await rowByKey(duplicateK);
  if (!primary || !duplicate || duplicate.id === primary.id) return;

  const db = await getDb();
  await db.transaction(async (tx) => {
    const alts = await tx.query<{ alt_domains_json: unknown }>(
      'SELECT alt_domains_json FROM company_registry WHERE id = $1',
      [primary.id],
    );
    const existing = parseStringArray(alts.rows[0]?.alt_domains_json);
    const merged = Array.from(new Set([...existing, duplicate.company_key])).slice(0, 100);

    const state = strictestState(primary.contact_state, duplicate.contact_state);
    const cooldown = laterDate(asDate(primary.cooldown_until), asDate(duplicate.cooldown_until));

    await tx.query(
      `UPDATE company_registry
          SET alt_domains_json    = $2,
              total_emails        = total_emails + $3,
              total_campaigns     = total_campaigns + $4,
              last_contacted_at   = GREATEST(COALESCE(last_contacted_at, to_timestamp(0)),
                                             COALESCE($5::timestamptz, to_timestamp(0))),
              contact_state       = $6,
              cooldown_until      = $7,
              cooldown_reason     = COALESCE(cooldown_reason, $8),
              engaged_campaign_id = COALESCE(engaged_campaign_id, $9),
              display_name        = COALESCE(display_name, $10),
              updated_at          = now()
        WHERE id = $1`,
      [
        primary.id,
        JSON.stringify(merged),
        toNumber(duplicate.total_emails),
        toNumber(duplicate.total_campaigns),
        asDate(duplicate.last_contacted_at)?.toISOString() ?? null,
        state,
        state === 'COOLDOWN' ? (cooldown?.toISOString() ?? null) : null,
        duplicate.cooldown_reason,
        duplicate.engaged_campaign_id,
        duplicate.display_name,
      ],
    );

    await tx.query(
      `UPDATE company_registry SET merged_into = $2, updated_at = now() WHERE id = $1`,
      [duplicate.id, primary.id],
    );
    await tx.query('UPDATE prospects SET company_id = $2, updated_at = now() WHERE company_id = $1', [
      duplicate.id,
      primary.id,
    ]);
  });

  logger.info('companies merged', { primary: primary.company_key, duplicate: duplicate.company_key });
  await recordAudit({
    entityType: 'prospect',
    entityId: null,
    eventType: 'DECISION',
    actor: 'autonomy:company',
    reason: `merged ${duplicate.company_key} into ${primary.company_key}`,
    detail: { primary: primary.company_key, duplicate: duplicate.company_key },
  });
}

/** NEVER_CONTACT beats COOLDOWN beats ENGAGED beats AVAILABLE. */
const STATE_ORDER: readonly ContactState[] = ['AVAILABLE', 'ENGAGED', 'COOLDOWN', 'NEVER_CONTACT'];

function strictestState(a: string, b: string): ContactState {
  const rank = (s: string): number => Math.max(0, STATE_ORDER.indexOf(s as ContactState));
  const winner = Math.max(rank(a), rank(b));
  return STATE_ORDER[winner] ?? 'AVAILABLE';
}

function laterDate(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

function parseStringArray(value: unknown): string[] {
  const raw = typeof value === 'string' ? safeParse(value) : value;
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function ensureRegistered(companyKey: string): Promise<string> {
  const resolved = await resolveRow(companyKey);
  if (resolved) return resolved.company_key;
  const created = await upsertCompany({ companyKey });
  return created.companyKey;
}

/** Links a prospect row to its company, registering the company if needed. */
export async function linkProspectToCompany(params: {
  prospectId: string;
  companyKey: string;
  displayName?: string | null;
}): Promise<string> {
  const { id, companyKey } = await upsertCompany({
    companyKey: params.companyKey,
    displayName: params.displayName ?? null,
  });
  if (id !== '') {
    const db = await getDb();
    await db.query('UPDATE prospects SET company_id = $2, updated_at = now() WHERE id = $1', [
      params.prospectId,
      id,
    ]);
  }
  return companyKey;
}

/** Every company currently blocked, for the dashboard and for post-mortems. */
export async function blockedCompanies(limit = 200): Promise<
  Array<{ companyKey: string; state: ContactState; reason: string | null; cooldownUntil: Date | null }>
> {
  const rows = await many<CompanyRow>(
    `${SELECT_COMPANY}
      WHERE merged_into IS NULL
        AND (contact_state = 'NEVER_CONTACT'
             OR (contact_state = 'COOLDOWN' AND cooldown_until > now())
             OR contact_state = 'ENGAGED')
      ORDER BY updated_at DESC
      LIMIT $1`,
    [Math.max(1, limit)],
  );
  return rows.map((row) => ({
    companyKey: row.company_key,
    state: (row.contact_state as ContactState) ?? 'AVAILABLE',
    reason: row.cooldown_reason,
    cooldownUntil: asDate(row.cooldown_until),
  }));
}
