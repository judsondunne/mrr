/**
 * Suppression list.
 *
 * The rule this file exists to enforce: once an address or its domain is on
 * the list, this system never emails it again. Not "usually", not "unless the
 * campaign is important" — never. Every send path re-checks immediately before
 * handing anything to the provider.
 *
 * Suppression is permanent and idempotent. There is deliberately no unsuppress().
 */
import { getDb, many, one } from '../../lib/db';
import { newId } from '../../lib/hash';
import { createLogger } from '../../lib/logger';
import { recordAudit } from '../../lib/audit';
import { markNeverContact } from '../../autonomy/company';
import { normalizeDomain as canonicalDomain } from '../prospecting/domain';

const logger = createLogger('outreach:suppression');

/** Why an address can never be contacted again. */
export const SUPPRESSION_REASONS = [
  'UNSUBSCRIBE',
  'COMPLAINT',
  'HARD_BOUNCE',
  'EXPLICIT_STOP',
  'MANUAL',
  'COUNTRY_NOT_ALLOWED',
  'ROLE_ACCOUNT_BLOCKED',
] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export function isSuppressionReason(value: string): value is SuppressionReason {
  return (SUPPRESSION_REASONS as readonly string[]).includes(value);
}

/** Lowercase + trim. Addresses are compared in this normalized form everywhere. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Company-domain normalization, delegated to the ONE definition in
 * src/pipeline/prospecting/domain.ts.
 *
 * This module used to have its own host-preserving version, which silently
 * disagreed with the company-fatigue layer: `shop.acme.com` was a different
 * company here and the same company there. That split meant suppression and
 * unique-company counting could not both be right. There is now one answer,
 * and it is the registrable-domain normalizer — which correctly keeps the
 * tenant label on multi-tenant hosts, so `a.myshopify.com` and
 * `b.myshopify.com` stay separate businesses.
 *
 * Falls back to a lowercased trim only when the input cannot be parsed as a
 * host at all, so a malformed row can never crash the send loop.
 */
export function normalizeDomain(domain: string): string {
  return canonicalDomain(domain) ?? domain.trim().toLowerCase();
}

/** The domain part of an address, normalized. Null when the input is not an address. */
export function domainOfEmail(email: string): string | null {
  const at = normalizeEmail(email).lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  const domain = normalizeEmail(email).slice(at + 1);
  return domain.includes('.') ? normalizeDomain(domain) : null;
}

/** The company identity used for commitment de-duplication. */
export function companyKeyFor(params: { domain?: string | null; email?: string | null }): string {
  if (params.domain && params.domain.trim() !== '') return normalizeDomain(params.domain);
  if (params.email) {
    const d = domainOfEmail(params.email);
    if (d) return d;
  }
  return 'unknown';
}

export interface SuppressParams {
  email?: string;
  domain?: string;
  reason: string;
  notes?: string;
}

/**
 * Adds an address and/or a domain to the suppression list.
 *
 * Rows hold exactly one of email/domain so the partial unique indexes stay
 * meaningful — suppressing one address must never silently suppress a whole
 * domain. Idempotent: repeat calls are a no-op.
 */
export async function suppress(params: SuppressParams): Promise<void> {
  const email = params.email ? normalizeEmail(params.email) : null;
  const domain = params.domain ? normalizeDomain(params.domain) : null;
  if (!email && !domain) return;

  const reason = isSuppressionReason(params.reason) ? params.reason : 'MANUAL';
  const notes = params.notes ?? null;
  const db = await getDb();

  await db.transaction(async (tx) => {
    if (email) {
      await tx.query(
        `INSERT INTO suppression_list (id, email, domain, reason, notes)
         VALUES ($1,$2,NULL,$3,$4)
         ON CONFLICT DO NOTHING`,
        [newId('sup'), email, reason, notes],
      );
    }
    if (domain) {
      await tx.query(
        `INSERT INTO suppression_list (id, email, domain, reason, notes)
         VALUES ($1,NULL,$2,$3,$4)
         ON CONFLICT DO NOTHING`,
        [newId('sup'), domain, reason, notes],
      );
    }

    // Mirror onto the prospect rows so the send path short-circuits even before
    // it reaches the suppression table. COMMITTED prospects keep their status
    // (the commitment is a historical fact) but still stop receiving email.
    if (email) {
      await tx.query(
        `UPDATE prospects
            SET suppressed_at = COALESCE(suppressed_at, now()),
                status = CASE WHEN status = 'COMMITTED' THEN status ELSE $2 END,
                updated_at = now()
          WHERE lower(contact_email) = $1`,
        [email, reason === 'HARD_BOUNCE' ? 'BOUNCED' : 'SUPPRESSED'],
      );
    }
    if (domain) {
      await tx.query(
        `UPDATE prospects
            SET suppressed_at = COALESCE(suppressed_at, now()),
                status = CASE WHEN status = 'COMMITTED' THEN status ELSE $2 END,
                updated_at = now()
          WHERE lower(domain) = $1`,
        [domain, reason === 'HARD_BOUNCE' ? 'BOUNCED' : 'SUPPRESSED'],
      );
    }
  });

  // An opt-out is about the BUSINESS, not one mailbox. Marking the company
  // NEVER_CONTACT is what stops an unrelated experiment emailing the same
  // shop at a different published address six months later. It is terminal:
  // there is no code path anywhere that clears it.
  const terminal: readonly string[] = ['UNSUBSCRIBE', 'EXPLICIT_STOP', 'COMPLAINT'];
  if (terminal.includes(reason)) {
    const key = companyKeyFor({ domain, email });
    if (key !== 'unknown') {
      await markNeverContact(key, `suppression:${reason}`);
    }
  }

  logger.info('suppressed', { hasEmail: Boolean(email), domain, reason });
  await recordAudit({
    entityType: 'prospect',
    entityId: null,
    eventType: 'SUPPRESS',
    actor: 'outreach:suppression',
    reason,
    detail: { email, domain, notes },
  });
}

/**
 * True when this address, or the domain it belongs to, must never be emailed.
 * Checked at draft time AND again immediately before every single send.
 */
export async function isSuppressed(email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  if (normalized === '') return true; // no address is not a sendable address
  const domain = domainOfEmail(normalized);
  const row = await one<{ id: string }>(
    `SELECT id FROM suppression_list
      WHERE (email IS NOT NULL AND email = $1)
         OR ($2::text IS NOT NULL AND domain IS NOT NULL AND domain = $2)
      LIMIT 1`,
    [normalized, domain],
  );
  return row !== null;
}

/** Bulk variant so the send path does not issue one query per recipient. */
export async function filterSuppressed(emails: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (emails.length === 0) return out;
  const normalized = emails.map(normalizeEmail);
  const domains = normalized.map(domainOfEmail).filter((d): d is string => d !== null);
  // Positional placeholders only — array-typed parameters are serialized
  // differently by the two drivers, so we never rely on them.
  const values = [...normalized, ...domains];
  const emailPlaceholders = normalized.map((_, i) => `$${i + 1}`).join(',');
  const domainPlaceholders = domains.map((_, i) => `$${normalized.length + i + 1}`).join(',');
  const clauses = [`(email IS NOT NULL AND email IN (${emailPlaceholders}))`];
  if (domains.length > 0) clauses.push(`(domain IS NOT NULL AND domain IN (${domainPlaceholders}))`);
  const rows = await many<{ email: string | null; domain: string | null }>(
    `SELECT email, domain FROM suppression_list WHERE ${clauses.join(' OR ')}`,
    values,
  );
  const suppressedEmails = new Set(rows.map((r) => r.email).filter((e): e is string => e !== null));
  const suppressedDomains = new Set(rows.map((r) => r.domain).filter((d): d is string => d !== null));
  for (const e of normalized) {
    const d = domainOfEmail(e);
    if (suppressedEmails.has(e) || (d !== null && suppressedDomains.has(d))) out.add(e);
  }
  return out;
}

/** Country gate. Prospects outside the allow-list are suppressed, not skipped. */
export function isCountryAllowed(country: string | null | undefined, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return false;
  if (!country || country.trim() === '') return false;
  return allowed.includes(country.trim().toUpperCase());
}
