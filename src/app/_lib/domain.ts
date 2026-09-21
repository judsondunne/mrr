/**
 * Domain normalization for `commitments.company_key`.
 *
 * The company key is the unit of "unique company" that the READY_TO_BUILD gate
 * counts, so this function decides what counts as the same business. It is
 * deliberately conservative: scheme, credentials, `www.`, port, path, query and
 * fragment are stripped and the host is lowercased — nothing else.
 *
 * The final collapse is delegated to `registrableDomain`, the one definition
 * shared with the outreach path, so both sources of commitments agree on what
 * one company is. That normalizer keeps the tenant label on hosted ecosystems
 * (`acme.myshopify.com` stays whole) rather than collapsing every merchant in
 * the ecosystem into a single "company".
 *
 *   https://WWW.Shop.com/path  -> shop.com
 *   HELLO@Shop.co.uk           -> shop.co.uk
 *   acme.myshopify.com         -> acme.myshopify.com
 */
import { registrableDomain } from '@/pipeline/prospecting/domain';

const MAX_DOMAIN_LENGTH = 253;
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** Returns the normalized company key, or null when the input is not a usable domain. */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;

  let value = input.trim().toLowerCase();
  if (value === '') return null;

  // Strip a scheme (or a scheme-relative prefix) without letting the URL parser
  // guess at anything: everything before "://" or a leading "//" goes.
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^\/\//, '');

  // An email address, or a URL with embedded credentials: keep what follows the
  // last "@" — that is the host.
  const at = value.lastIndexOf('@');
  if (at !== -1) value = value.slice(at + 1);

  // Path, query, fragment.
  value = value.split(/[/?#]/)[0] ?? '';

  // Port.
  value = value.split(':')[0] ?? '';

  // Trailing root dot, stray dots.
  value = value.replace(/\.+$/, '').replace(/^\.+/, '');

  // One level of "www." only. Deeper subdomains are meaningful (see above).
  if (value.startsWith('www.')) value = value.slice(4);

  if (value === '' || value.length > MAX_DOMAIN_LENGTH) return null;
  if (!HOST_PATTERN.test(value)) return null;

  // The company key MUST agree with the one the outreach path writes, because
  // the READY_TO_BUILD gate counts unique company keys across both sources. A
  // business that fills in the landing form AND replies to an email would
  // otherwise be counted twice. `registrableDomain` is the single definition:
  // it collapses shop.acme.com -> acme.com while keeping the tenant label on
  // multi-tenant hosts, so a.myshopify.com and b.myshopify.com stay distinct.
  return registrableDomain(value);
}

/** The domain part of an email address, normalized the same way. */
export function emailDomain(email: string | null | undefined): string | null {
  if (typeof email !== 'string' || !email.includes('@')) return null;
  return normalizeDomain(email);
}
