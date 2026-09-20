/**
 * PUBLIC business contact discovery.
 *
 * The rules here are not style preferences, they are the difference between
 * legitimate B2B outreach and spam:
 *
 *   1. An address is recorded ONLY if it was literally present on a public page
 *      we actually fetched. Nothing is ever pattern-generated, completed, or
 *      inferred. `firstname.lastname@company.com` is never constructed, and is
 *      rejected even when found.
 *   2. Every stored address carries the URL it was found on.
 *   3. Obfuscated addresses ("hello [at] example.com", Cloudflare email
 *      protection) are deliberately NOT decoded — the site is asking not to be
 *      scraped and that answer is respected.
 *   4. Anything behind a login wall is skipped entirely.
 */
import { politeFetch } from '../../lib/fetch.js';
import { createLogger } from '../../lib/logger.js';
import { extractLinks, extractMailtoAddresses, extractText, looksLikeAuthWall } from './html.js';
import { isSameCompanyDomain, normalizeDomain } from './domain.js';

const logger = createLogger('prospecting:contact');

/**
 * Role addresses this wedge should prefer, derived from its own text.
 *
 * The global order below is a sensible default, but it is wrong for a specific
 * offer: sending a wholesale pilot to `support@` lands it in a ticket queue
 * rather than with the person who owns the workflow, and reply rate is this
 * system's entire measurement instrument. So a role whose name actually
 * appears in the wedge outranks the generic order.
 */
export function preferredRolesForWedge(wedgeText: string): string[] {
  const haystack = wedgeText.toLowerCase();
  return ROLE_LOCALPARTS.filter((role) => {
    if (GENERIC_ROLES.has(role)) return false;
    return new RegExp(`\\b${role.replace(/[-]/g, '[- ]?')}`, 'i').test(haystack);
  });
}

/**
 * Roles too generic to ever be "preferred" by keyword match — every business
 * page mentions support and contact, so matching them would be noise.
 */
const GENERIC_ROLES: ReadonlySet<string> = new Set([
  'hello', 'support', 'info', 'contact', 'help', 'team', 'office',
  'mail', 'general', 'care', 'hi', 'ask', 'admin', 'service',
  'customerservice', 'customer-service', 'customercare',
]);

/** Preferred published role addresses, best first. */
export const ROLE_LOCALPARTS: readonly string[] = [
  'hello',
  'support',
  'sales',
  'wholesale',
  'info',
  'contact',
  'orders',
  'trade',
  'enquiries',
  'inquiries',
  'customerservice',
  'customer-service',
  'customercare',
  'service',
  'help',
  'team',
  'office',
  'shop',
  'store',
  'admin',
  'accounts',
  'bookings',
  'reservations',
  'wholesaleorders',
  'tradeaccounts',
  'hi',
  'ask',
  'mail',
  'general',
  'care',
];

export const FREEMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.uk',
  'ymail.com',
  'hotmail.com',
  'hotmail.co.uk',
  'outlook.com',
  'live.com',
  'msn.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'gmx.de',
  'mail.com',
  'zoho.com',
  'yandex.com',
  'inbox.com',
  'fastmail.com',
]);

/** Addresses that exist in markup but are not a business contact. */
const PLACEHOLDER_LOCALPARTS: ReadonlySet<string> = new Set([
  'youremail',
  'your-email',
  'yourname',
  'email',
  'e-mail',
  'name',
  'firstname',
  'lastname',
  'username',
  'user',
  'test',
  'testing',
  'demo',
  'sample',
  'example',
  'noreply',
  'no-reply',
  'donotreply',
  'do-not-reply',
  'mailer-daemon',
  'postmaster',
  'abuse',
  'spam',
  'null',
  'none',
  'unsubscribe',
  'bounce',
  'bounces',
  'notifications',
  'notification',
  'automated',
  'system',
]);

const PLACEHOLDER_DOMAINS: ReadonlySet<string> = new Set([
  'example.com',
  'example.org',
  'example.net',
  'example.co.uk',
  'domain.com',
  'yourdomain.com',
  'yoursite.com',
  'mysite.com',
  'mydomain.com',
  'email.com',
  'test.com',
  'company.com',
  'website.com',
  'sentry.io',
  'wixpress.com',
  'sentry.wixpress.com',
  'shopify.com',
  'squarespace.com',
  'wordpress.com',
  'godaddy.com',
  'localhost.com',
]);

const ASSET_EXTENSIONS: readonly string[] = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'ico',
  'css',
  'js',
  'json',
  'woff',
  'woff2',
  'ttf',
  'mp4',
  'webm',
  'pdf',
];

/** Words that make a local part a function of the business, not a person. */
const BUSINESS_WORDS: ReadonlySet<string> = new Set([
  ...ROLE_LOCALPARTS,
  'order',
  'customer',
  'billing',
  'invoice',
  'invoices',
  'press',
  'media',
  'marketing',
  'hr',
  'jobs',
  'careers',
  'events',
  'returns',
  'web',
  'online',
  'retail',
  'enquiry',
  'inquiry',
  'desk',
  'front',
  'reception',
  'business',
  'dev',
  'tech',
  'it',
  'studio',
  'hq',
  'group',
  'co',
  'company',
  'ltd',
  'inc',
  'bakery',
  'cafe',
  'kitchen',
  'farm',
  'supply',
  'goods',
  'brand',
  'club',
  'new',
  'newsletter',
  'book',
  'buy',
  'b2b',
  'pro',
]);

/** Common given names — enough to catch the obvious personal address. */
const COMMON_GIVEN_NAMES: ReadonlySet<string> = new Set([
  'james', 'john', 'robert', 'michael', 'william', 'david', 'richard', 'joseph', 'thomas', 'charles',
  'christopher', 'daniel', 'matthew', 'anthony', 'mark', 'donald', 'steven', 'paul', 'andrew', 'joshua',
  'kenneth', 'kevin', 'brian', 'george', 'timothy', 'ronald', 'jason', 'edward', 'jeffrey', 'ryan',
  'jacob', 'gary', 'nicholas', 'eric', 'jonathan', 'stephen', 'larry', 'justin', 'scott', 'brandon',
  'mary', 'patricia', 'jennifer', 'linda', 'elizabeth', 'barbara', 'susan', 'jessica', 'sarah', 'karen',
  'lisa', 'nancy', 'betty', 'margaret', 'sandra', 'ashley', 'kimberly', 'emily', 'donna', 'michelle',
  'carol', 'amanda', 'dorothy', 'melissa', 'deborah', 'stephanie', 'rebecca', 'sharon', 'laura', 'cynthia',
  'amy', 'kathleen', 'angela', 'shirley', 'anna', 'ruth', 'brenda', 'pamela', 'nicole', 'katherine',
  'emma', 'olivia', 'sophie', 'chloe', 'jack', 'oliver', 'harry', 'jake', 'liam', 'noah',
  'tom', 'dave', 'mike', 'steve', 'chris', 'rob', 'jim', 'bob', 'sam', 'ben', 'dan', 'joe', 'kate', 'jane',
]);

const EMAIL_RE = /[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/g;
const SYNTAX_RE = /^[a-z0-9](?:[a-z0-9._%+-]*[a-z0-9])?@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

export interface EmailVerdict {
  ok: boolean;
  reason: string;
  isRole: boolean;
  isFreemail: boolean;
  sameDomain: boolean;
  localPart: string;
  emailDomain: string;
}

export function splitEmail(email: string): { localPart: string; emailDomain: string } | null {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  return { localPart: email.slice(0, at), emailDomain: email.slice(at + 1) };
}

/** `jane.doe@` / `j.smith@` — a named individual, never a business role. */
export function looksLikePerson(localPart: string): boolean {
  const lp = localPart.toLowerCase();
  if (ROLE_LOCALPARTS.includes(lp)) return false;

  const parts = lp.split(/[._-]/).filter(Boolean);
  if (parts.length === 2) {
    const [a, b] = parts;
    if (a !== undefined && b !== undefined) {
      const alpha = /^[a-z]+$/.test(a) && /^[a-z]+$/.test(b);
      const businessy = BUSINESS_WORDS.has(a) || BUSINESS_WORDS.has(b);
      // "j.smith" and "jane.doe" both land here; "wholesale.orders" does not.
      if (alpha && !businessy && (a.length >= 1 && b.length >= 2)) return true;
    }
  }
  if (parts.length === 1) {
    const only = parts[0];
    if (only !== undefined && COMMON_GIVEN_NAMES.has(only)) return true;
  }
  return false;
}

/**
 * Decides whether a FOUND address may be used for business outreach.
 * This function never constructs an address — it only judges one.
 */
export function classifyEmail(email: string, prospectDomain: string): EmailVerdict {
  const normalized = email.trim().toLowerCase().replace(/^mailto:/, '').replace(/[.,;:)\]]+$/, '');
  const split = splitEmail(normalized);
  const base: Omit<EmailVerdict, 'ok' | 'reason'> = {
    isRole: false,
    isFreemail: false,
    sameDomain: false,
    localPart: split?.localPart ?? '',
    emailDomain: split?.emailDomain ?? '',
  };
  if (!split) return { ...base, ok: false, reason: 'not an address' };
  if (!SYNTAX_RE.test(normalized)) return { ...base, ok: false, reason: 'invalid syntax' };

  const { localPart, emailDomain } = split;
  const tld = emailDomain.split('.').pop() ?? '';
  if (ASSET_EXTENSIONS.includes(tld)) {
    return { ...base, ok: false, reason: 'asset filename, not an address' };
  }
  if (PLACEHOLDER_DOMAINS.has(emailDomain)) {
    return { ...base, ok: false, reason: `placeholder domain ${emailDomain}` };
  }
  if (PLACEHOLDER_LOCALPARTS.has(localPart)) {
    return { ...base, ok: false, reason: `placeholder/automated address ${localPart}@` };
  }

  const isRole = ROLE_LOCALPARTS.includes(localPart);
  const isFreemail = FREEMAIL_DOMAINS.has(emailDomain);
  const sameDomain = isSameCompanyDomain(emailDomain, prospectDomain);
  const verdict: Omit<EmailVerdict, 'ok' | 'reason'> = {
    isRole,
    isFreemail,
    sameDomain,
    localPart,
    emailDomain,
  };

  if (looksLikePerson(localPart)) {
    return { ...verdict, ok: false, reason: 'addresses a named individual, not the business' };
  }
  if (isFreemail && !isRole) {
    return { ...verdict, ok: false, reason: 'free-mail address that is not a business role account' };
  }
  if (!sameDomain && !isFreemail) {
    return { ...verdict, ok: false, reason: `third-party domain ${emailDomain}` };
  }
  return { ...verdict, ok: true, reason: isRole ? `published role address ${localPart}@` : 'published business address' };
}

export interface EmailCandidate {
  email: string;
  sourceUrl: string;
  isRole: boolean;
  isFreemail: boolean;
  sameDomain: boolean;
  viaMailto: boolean;
  score: number;
}

const CONTACT_PAGE_RE = /contact|about|wholesale|trade|stockist|support|help|customer.?service|reach.?us|get.?in.?touch|impressum/i;

function pageRelevanceBonus(url: string): number {
  return CONTACT_PAGE_RE.test(url) ? 20 : 0;
}

/**
 * Every address literally present on this page, scored. `mailto:` links rank
 * above body text because they are unambiguously published for contact.
 */
export function extractEmailCandidates(
  html: string,
  pageUrl: string,
  prospectDomain: string,
  preferredRoles: readonly string[] = [],
): EmailCandidate[] {
  const mailtos = new Set(extractMailtoAddresses(html));
  const text = `${extractText(html)} ${[...mailtos].join(' ')}`;
  const found = new Set<string>();
  for (const raw of text.match(EMAIL_RE) ?? []) found.add(raw.toLowerCase());
  for (const raw of mailtos) found.add(raw.toLowerCase());

  const out: EmailCandidate[] = [];
  for (const raw of found) {
    const email = raw.replace(/[.,;:)\]]+$/, '');
    const verdict = classifyEmail(email, prospectDomain);
    if (!verdict.ok) continue;

    const rolePriority = ROLE_LOCALPARTS.indexOf(verdict.localPart);
    let score = 40;
    if (verdict.isRole) score += 60 - Math.min(rolePriority, 30);
    // A role this wedge explicitly names beats the generic ordering.
    if (verdict.isRole && preferredRoles.includes(verdict.localPart)) score += 45;
    if (verdict.sameDomain) score += 30;
    if (mailtos.has(email)) score += 15;
    if (verdict.isFreemail) score -= 25;
    score += pageRelevanceBonus(pageUrl);

    out.push({
      email,
      sourceUrl: pageUrl,
      isRole: verdict.isRole,
      isFreemail: verdict.isFreemail,
      sameDomain: verdict.sameDomain,
      viaMailto: mailtos.has(email),
      score,
    });
  }
  return out.sort((a, b) => (b.score === a.score ? a.email.localeCompare(b.email) : b.score - a.score));
}

// --- country ----------------------------------------------------------------

const CCTLD_COUNTRY: Readonly<Record<string, string>> = {
  uk: 'GB',
  au: 'AU',
  nz: 'NZ',
  ca: 'CA',
  ie: 'IE',
  de: 'DE',
  fr: 'FR',
  es: 'ES',
  it: 'IT',
  nl: 'NL',
  be: 'BE',
  se: 'SE',
  no: 'NO',
  dk: 'DK',
  fi: 'FI',
  pl: 'PL',
  pt: 'PT',
  at: 'AT',
  ch: 'CH',
  za: 'ZA',
  sg: 'SG',
  jp: 'JP',
  in: 'IN',
  br: 'BR',
  mx: 'MX',
  us: 'US',
};

const PHONE_PREFIX_COUNTRY: ReadonlyArray<readonly [string, string]> = [
  ['+44', 'GB'],
  ['+61', 'AU'],
  ['+64', 'NZ'],
  ['+353', 'IE'],
  ['+49', 'DE'],
  ['+33', 'FR'],
  ['+34', 'ES'],
  ['+39', 'IT'],
  ['+31', 'NL'],
  ['+46', 'SE'],
  ['+27', 'ZA'],
  ['+65', 'SG'],
];

const COUNTRY_NAMES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bunited states\b|\bu\.?s\.?a\.?\b/i, 'US'],
  [/\bunited kingdom\b|\bengland\b|\bscotland\b|\bwales\b|\bnorthern ireland\b/i, 'GB'],
  [/\bcanada\b/i, 'CA'],
  [/\baustralia\b/i, 'AU'],
  [/\bnew zealand\b/i, 'NZ'],
  [/\bireland\b/i, 'IE'],
  [/\bgermany\b|\bdeutschland\b/i, 'DE'],
  [/\bfrance\b/i, 'FR'],
  [/\bnetherlands\b/i, 'NL'],
  [/\bsouth africa\b/i, 'ZA'],
  [/\bsingapore\b/i, 'SG'],
];

const US_ADDRESS_RE =
  /\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)[.,]?\s+\d{5}(-\d{4})?\b/;
const CA_ADDRESS_RE = /\b(AB|BC|MB|NB|NL|NS|ON|PE|QC|SK)[.,]?\s+[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/i;

/**
 * Publicly evident country only. Returns null rather than guessing — the
 * campaign layer filters on ALLOWED_OUTREACH_COUNTRIES and an unknown country
 * must not silently become "US".
 */
export function detectCountry(text: string, domain: string): string | null {
  const tld = domain.split('.').pop() ?? '';
  const byTld = CCTLD_COUNTRY[tld];
  if (byTld !== undefined) return byTld;

  for (const [prefix, country] of PHONE_PREFIX_COUNTRY) {
    if (text.includes(prefix)) return country;
  }
  if (US_ADDRESS_RE.test(text)) return 'US';
  if (CA_ADDRESS_RE.test(text)) return 'CA';
  for (const [re, country] of COUNTRY_NAMES) {
    if (re.test(text)) return country;
  }
  return null;
}

// --- discovery --------------------------------------------------------------

export interface ContactFinding {
  email: string;
  /** The page the address was literally found on. Always recorded. */
  sourceUrl: string;
  isRole: boolean;
  country: string | null;
  pagesFetched: string[];
  candidatesConsidered: number;
}

export interface FetchedPage {
  url: string;
  html: string;
  text: string;
}

const WELL_KNOWN_CONTACT_PATHS: readonly string[] = [
  '/pages/contact',
  '/contact',
  '/contact-us',
  '/pages/contact-us',
  '/pages/wholesale',
  '/wholesale',
  '/pages/about',
  '/about',
];

export const DEFAULT_MAX_CONTACT_PAGES = 4;

function sameOrigin(url: string, domain: string): boolean {
  const normalized = normalizeDomain(url);
  return normalized !== null && normalized === domain;
}

/**
 * Fetches a small, polite set of public pages and returns the best published
 * business address found on them — or null. Never returns an address that was
 * not literally on one of those pages.
 */
export async function findPublicContact(params: {
  domain: string;
  seedUrls: readonly string[];
  maxPages?: number;
  /** Pages already fetched by the caller, reused instead of re-fetching. */
  prefetched?: readonly FetchedPage[];
  /** Role localparts this offer should favour; see preferredRolesForWedge. */
  preferredRoles?: readonly string[];
}): Promise<ContactFinding | null> {
  const { domain } = params;
  const maxPages = params.maxPages ?? DEFAULT_MAX_CONTACT_PAGES;

  const visited = new Set<string>();
  const pages: FetchedPage[] = [];
  for (const page of params.prefetched ?? []) {
    visited.add(page.url);
    pages.push(page);
  }

  const queue: string[] = [];
  const enqueue = (url: string): void => {
    if (visited.has(url) || queue.includes(url)) return;
    if (!sameOrigin(url, domain)) return;
    queue.push(url);
  };

  for (const seed of params.seedUrls) enqueue(seed);
  // Contact-ish links discovered on pages we already have.
  for (const page of pages) {
    for (const link of extractLinks(page.html, page.url)) {
      if (CONTACT_PAGE_RE.test(link.url) || CONTACT_PAGE_RE.test(link.text)) enqueue(link.url);
    }
  }
  for (const path of WELL_KNOWN_CONTACT_PATHS) enqueue(`https://${domain}${path}`);

  let fetched = 0;
  while (queue.length > 0 && fetched < maxPages) {
    const url = queue.shift();
    if (url === undefined || visited.has(url)) continue;
    visited.add(url);
    fetched += 1;
    try {
      const res = await politeFetch(url);
      if (!res.contentType.includes('html') && res.contentType !== '') continue;
      if (looksLikeAuthWall(res.body, res.finalUrl)) {
        logger.debug('skipping page behind auth', { url });
        continue;
      }
      const page: FetchedPage = { url: res.finalUrl || url, html: res.body, text: extractText(res.body) };
      pages.push(page);
      for (const link of extractLinks(page.html, page.url)) {
        if (CONTACT_PAGE_RE.test(link.url) || CONTACT_PAGE_RE.test(link.text)) enqueue(link.url);
      }
    } catch (err) {
      logger.debug('contact page fetch failed', { url, err: String(err) });
    }
  }

  const candidates: EmailCandidate[] = [];
  for (const page of pages) {
    candidates.push(
      ...extractEmailCandidates(page.html, page.url, domain, params.preferredRoles ?? []),
    );
  }
  candidates.sort((a, b) => (b.score === a.score ? a.email.localeCompare(b.email) : b.score - a.score));

  const best = candidates[0];
  if (best === undefined) {
    logger.debug('no public business address found', { domain, pages: pages.length });
    return null;
  }

  // Final integrity check: the address must literally appear on the page we
  // claim as its source. Nothing invented can survive this.
  const source = pages.find((p) => p.url === best.sourceUrl);
  if (!source || !`${source.html} ${source.text}`.toLowerCase().includes(best.email)) {
    logger.warn('discarding address that is not present on its source page', {
      domain,
      sourceUrl: best.sourceUrl,
    });
    return null;
  }

  const allText = pages.map((p) => p.text).join(' \n ');
  return {
    email: best.email,
    sourceUrl: best.sourceUrl,
    isRole: best.isRole,
    country: detectCountry(allText, domain),
    pagesFetched: pages.map((p) => p.url),
    candidatesConsidered: candidates.length,
  };
}
