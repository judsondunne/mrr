/**
 * Domain normalization.
 *
 * The normalized registrable domain is the UNIQUE COMPANY KEY for the whole
 * system — dedup, `prospects (opportunity_id, domain)`, and ultimately the
 * unique-company counting the validation gate does. Two spellings of the same
 * business must collapse to exactly one key, and two different businesses must
 * never collapse into one.
 */

/**
 * Hosts that hand out one label per tenant. `north-field.myshopify.com` is a
 * different COMPANY from `acme.myshopify.com`, so the tenant label is kept.
 */
export const MULTI_TENANT_HOSTS: readonly string[] = [
  'myshopify.com',
  'shopifypreview.com',
  'myshopline.com',
  'squarespace.com',
  'wixsite.com',
  'editorx.io',
  'bigcartel.com',
  'ecwid.com',
  'square.site',
  'storenvy.com',
  'bandcamp.com',
  'wordpress.com',
  'blogspot.com',
  'weebly.com',
  'webflow.io',
  'github.io',
  'netlify.app',
  'vercel.app',
  'pages.dev',
  'shopsettings.com',
  'company.site',
];

/** Two-label public suffixes we care about. Not the full PSL — the working set. */
export const MULTI_LABEL_SUFFIXES: readonly string[] = [
  'co.uk',
  'org.uk',
  'me.uk',
  'ltd.uk',
  'plc.uk',
  'net.uk',
  'ac.uk',
  'gov.uk',
  'sch.uk',
  'com.au',
  'net.au',
  'org.au',
  'edu.au',
  'gov.au',
  'co.nz',
  'net.nz',
  'org.nz',
  'co.za',
  'com.br',
  'com.mx',
  'gob.mx',
  'com.ar',
  'com.co',
  'com.sg',
  'com.my',
  'com.hk',
  'com.tw',
  'com.tr',
  'co.in',
  'net.in',
  'org.in',
  'co.jp',
  'or.jp',
  'ne.jp',
  'co.kr',
  'com.cn',
  'com.pl',
  'co.il',
  'com.ua',
  'com.ph',
  'co.id',
  'com.vn',
  'co.th',
  'com.pk',
  'com.sa',
  'com.ng',
  'co.ke',
  'com.pe',
  'com.ec',
  'com.uy',
  'com.ve',
];

/**
 * Never a prospect: marketplaces, platform vendors, social networks, review
 * directories, news, CDNs and shorteners. A hit here means the search result
 * was about merchants, not a merchant.
 */
export const DISALLOWED_PROSPECT_DOMAINS: ReadonlySet<string> = new Set([
  // platforms & marketplaces
  'shopify.com',
  'shopify.dev',
  'shopifycdn.com',
  'shopifyplus.com',
  'bigcommerce.com',
  'woocommerce.com',
  'wix.com',
  'squarespace.com',
  'magento.com',
  'salesforce.com',
  'adobe.com',
  'etsy.com',
  'amazon.com',
  'amazon.co.uk',
  'ebay.com',
  'walmart.com',
  'target.com',
  'aliexpress.com',
  'alibaba.com',
  'faire.com',
  'tundra.com',
  'abound.com',
  'handshake.com',
  'wholesalecentral.com',
  // social
  'facebook.com',
  'fb.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'linkedin.com',
  'youtube.com',
  'tiktok.com',
  'pinterest.com',
  'reddit.com',
  'tumblr.com',
  'snapchat.com',
  'threads.net',
  'quora.com',
  'discord.com',
  'whatsapp.com',
  'vimeo.com',
  // directories, reviews, jobs
  'trustpilot.com',
  'g2.com',
  'capterra.com',
  'getapp.com',
  'softwareadvice.com',
  'producthunt.com',
  'yelp.com',
  'glassdoor.com',
  'indeed.com',
  'crunchbase.com',
  'bbb.org',
  'yellowpages.com',
  'manta.com',
  'thomasnet.com',
  'angi.com',
  'houzz.com',
  // content, dev, infra
  'medium.com',
  'substack.com',
  'wikipedia.org',
  'wikimedia.org',
  'github.com',
  'gitlab.com',
  'stackoverflow.com',
  'stackexchange.com',
  'wordpress.org',
  'blogger.com',
  'notion.so',
  'google.com',
  'googleusercontent.com',
  'googletagmanager.com',
  'gstatic.com',
  'bing.com',
  'duckduckgo.com',
  'yahoo.com',
  'msn.com',
  'apple.com',
  'microsoft.com',
  'cloudflare.com',
  'archive.org',
  'imgur.com',
  'gravatar.com',
  'jsdelivr.net',
  'unpkg.com',
  'cloudfront.net',
  'akamaized.net',
  'fbcdn.net',
  // SaaS vendors that show up constantly in ecommerce search results
  'hubspot.com',
  'mailchimp.com',
  'klaviyo.com',
  'stripe.com',
  'paypal.com',
  'zendesk.com',
  'intercom.com',
  'shipstation.com',
  'quickbooks.com',
  'xero.com',
  // news
  'forbes.com',
  'entrepreneur.com',
  'techcrunch.com',
  'businessinsider.com',
  'nytimes.com',
  'bloomberg.com',
  'inc.com',
  // shorteners
  'bit.ly',
  't.co',
  'goo.gl',
  'tinyurl.com',
  'lnkd.in',
  'ow.ly',
  'buff.ly',
]);

/** TLDs that are never a commercial prospect. */
const DISALLOWED_TLDS: readonly string[] = ['gov', 'mil', 'edu', 'int', 'museum'];
const DISALLOWED_SUFFIXES: readonly string[] = ['gov.uk', 'ac.uk', 'sch.uk', 'gov.au', 'edu.au'];

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/** `mailto:`, `tel:`, `javascript:` … anything with an opaque scheme. */
const OPAQUE_SCHEME = /^[a-z][a-z0-9+.-]*:(?!\/\/)/i;
const HOST_WITH_PORT = /^[^:/?#]+:\d+(\/|$|\?|#)/;

function hostFrom(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  // "mailto:hello@example.com" must not quietly become "example.com".
  if (OPAQUE_SCHEME.test(trimmed) && !HOST_WITH_PORT.test(trimmed)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  let host = url.hostname.toLowerCase().replace(/\.+$/, '');
  if (host.startsWith('www.')) host = host.slice(4);
  if (host === '' || IPV4_RE.test(host) || !HOSTNAME_RE.test(host)) return null;
  return host;
}

/** Collapses a hostname to its registrable domain (plus tenant label if any). */
export function registrableDomain(host: string): string | null {
  const labels = host.split('.');
  if (labels.length < 2) return null;

  for (const tenantHost of MULTI_TENANT_HOSTS) {
    if (host === tenantHost) return host;
    if (host.endsWith(`.${tenantHost}`)) {
      const keep = tenantHost.split('.').length + 1;
      return labels.slice(-keep).join('.');
    }
  }
  for (const suffix of MULTI_LABEL_SUFFIXES) {
    if (host === suffix) return null; // a bare public suffix is not a company
    if (host.endsWith(`.${suffix}`)) {
      return labels.slice(-3).join('.');
    }
  }
  return labels.slice(-2).join('.');
}

/**
 * `https://WWW.Example.com/wholesale?x=1` and `shop.example.com` both become
 * `example.com`. Returns null for anything that is not a usable web domain.
 */
export function normalizeDomain(input: string): string | null {
  const host = hostFrom(input);
  if (host === null) return null;
  return registrableDomain(host);
}

export function isDisallowedProspectDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  if (DISALLOWED_PROSPECT_DOMAINS.has(d)) return true;
  const tld = d.split('.').pop() ?? '';
  if (DISALLOWED_TLDS.includes(tld)) return true;
  if (DISALLOWED_SUFFIXES.some((s) => d === s || d.endsWith(`.${s}`))) return true;
  // A tenant on a disallowed multi-tenant host is still a real merchant, but a
  // tenant on a platform vendor's own domain is not.
  return false;
}

/** True when `email`'s domain is the same company as `domain`. */
export function isSameCompanyDomain(emailDomain: string, domain: string): boolean {
  const a = normalizeDomain(emailDomain);
  const b = normalizeDomain(domain);
  return a !== null && b !== null && a === b;
}

export function domainToCompanyName(domain: string): string {
  const label = domain.split('.')[0] ?? domain;
  return label
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
