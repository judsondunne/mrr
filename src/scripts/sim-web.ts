/**
 * The simulated public web.
 *
 * The prospecting pipeline is the one part of the system that reads the open
 * internet: it searches for merchants, fetches their sites, decides ICP fit
 * from the page text, and looks for a published business address. None of that
 * could be simulated before, because HTTP had no seam — so every simulated run
 * died at INSUFFICIENT_PROSPECTS and the winner path was unprovable.
 *
 * This module builds a deterministic web of merchant storefronts, one set per
 * idea, and serves them through the `setHttpTransport` seam. The pages are
 * written to be *realistic*, not permissive: they carry the same signals a real
 * wholesale page carries, and the production qualifier is what decides whether
 * each one fits. Some are deliberately unqualifiable — auth-walled, contactless,
 * or vendor pages selling TO merchants — so the qualifier's rejection paths run
 * for real rather than every candidate sailing through.
 *
 * Every domain is under the reserved `.example` TLD, which cannot resolve, and the
 * transport is only ever installed by the simulation.
 */
import { makeRng, type SimIdea } from './sim-world';

/** One synthetic business. */
export interface SimMerchant {
  ideaKey: string;
  domain: string;
  companyName: string;
  /** How this page behaves when fetched. */
  shape: 'WHOLESALE' | 'CONTACT_FORM_ONLY' | 'AUTH_WALL' | 'VENDOR' | 'NOT_ICP';
  roleEmail: string | null;
  /** Full postal address, with the state and ZIP a country check needs. */
  address: string;
}

/**
 * Full street addresses with a state and ZIP, because that is what the
 * production contact extractor reads a country from — a bare "Portland, OR"
 * yields no country, and a prospect with no country is suppressed as
 * COUNTRY_NOT_ALLOWED before a single message is drafted.
 */
const ADDRESSES = [
  '1820 NW Quimby St, Portland, OR 97209',
  '42 Biltmore Ave, Asheville, NC 28801',
  '155 Church St, Burlington, VT 05401',
  '901 W Idaho St, Boise, ID 83702',
  '318 E Wilson St, Madison, WI 53703',
  '220 Weybosset St, Providence, RI 02903',
  '1155 Canyon Blvd, Boulder, CO 80302',
  '18 E Broughton St, Savannah, GA 31401',
  '130 N Higgins Ave, Missoula, MT 59802',
  '210 N Aurora St, Ithaca, NY 14850',
];

const NAME_HEADS = [
  'Northfield', 'Cedar Lane', 'Harborview', 'Millbrook', 'Driftwood', 'Stonebridge',
  'Foxglove', 'Alderway', 'Brightwater', 'Copperfield', 'Larkspur', 'Wendover',
  'Thistledown', 'Marigold', 'Kingsbury', 'Ravenwood', 'Sablewood', 'Pinehurst',
];
const NAME_TAILS = ['Supply Co', 'Trading Co', 'Goods', 'Provisions', 'Works', 'Collective', 'Mercantile', 'Studio'];

/**
 * Shape mix. Roughly three in four candidates are genuinely qualifiable, which
 * is generous for the open web but keeps the run bounded; the remainder
 * exercise each rejection path in the qualifier.
 */
function shapeFor(n: number): SimMerchant['shape'] {
  const slot = n % 8;
  if (slot === 5) return 'CONTACT_FORM_ONLY';
  if (slot === 6) return 'AUTH_WALL';
  if (slot === 7) return n % 16 === 7 ? 'VENDOR' : 'NOT_ICP';
  return 'WHOLESALE';
}

/**
 * Builds the merchant population for one idea. `prospectYield` is the number of
 * businesses that genuinely exist in that segment, so a junk segment stays junk
 * and the winner's segment is deep enough to fill a campaign.
 */
export function merchantsFor(idea: SimIdea): SimMerchant[] {
  const rng = makeRng(hashSeed(idea.key));
  const out: SimMerchant[] = [];
  for (let n = 0; n < idea.prospectYield; n++) {
    const head = NAME_HEADS[Math.floor(rng() * NAME_HEADS.length)] ?? 'Northfield';
    const tail = NAME_TAILS[Math.floor(rng() * NAME_TAILS.length)] ?? 'Supply Co';
    const slug = `${head.toLowerCase().replace(/[^a-z]+/g, '')}-${idea.key}-${n + 1}`;
    const shape = shapeFor(n);
    out.push({
      ideaKey: idea.key,
      // One REGISTRABLE domain per business. Subdomains of a shared parent all
      // collapse to that parent under the production company-key rule — which
      // is correct, and made every simulated merchant the same company.
      // `.example` is reserved by RFC 2606, so it can never resolve.
      domain: `${slug}.example`,
      companyName: `${head} ${tail}`,
      shape,
      roleEmail: shape === 'WHOLESALE' ? `${idea.contactRole}@${slug}.example` : null,
      address: ADDRESSES[n % ADDRESSES.length] ?? ADDRESSES[0]!,
    });
  }
  return out;
}

function hashSeed(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// --- page rendering ----------------------------------------------------------

/**
 * A merchant's public wholesale page.
 *
 * Carries what the production qualifier looks for and nothing it does not: two
 * or more ICP words from the wedge, a live-storefront marker, commerce signals,
 * and one published role address. The wedge's own vocabulary is woven in
 * because that is what makes a real page readable as this segment's customer.
 */
function wholesalePage(m: SimMerchant, idea: SimIdea): string {
  const workflow = idea.wedgeType.replace(/[-_]+/g, ' ');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Wholesale &amp; Trade Accounts | ${m.companyName}</title>
    <meta property="og:site_name" content="${m.companyName}" />
    <script type="application/ld+json">
      {"@context":"https://schema.org","@type":"Store","name":"${m.companyName}","url":"https://${m.domain}"}
    </script>
  </head>
  <body>
    <header>
      <a href="/">${m.companyName}</a>
      <nav>
        <a href="/collections/all">Shop all</a>
        <a href="/pages/wholesale">Wholesale</a>
        <a href="/pages/contact">Contact us</a>
      </nav>
    </header>
    <main>
      <h1>Wholesale &amp; trade accounts</h1>
      <p>
        ${m.companyName} supplies independent retail stockists and wholesalers. We are a
        ${idea.ecosystem} store and all trade orders ship in fixed case quantities &mdash;
        we do not break cases.
      </p>
      <ul>
        <li>Minimum order: $${350 + ((m.domain.length * 7) % 40) * 5} per shipment</li>
        <li>Case-pack quantities of 6 or 12 units per style</li>
        <li>Wholesale pricing for approved stockists, net 30 terms</li>
        <li>We manage ${workflow} by hand in a spreadsheet today</li>
      </ul>
      <h2>Apply for a trade account</h2>
      <p>
        Send your resale certificate and shop details to
        <a href="mailto:${m.roleEmail ?? ''}">${m.roleEmail ?? ''}</a>
        and we will set up your wholesale pricing within two business days.
      </p>
      <p><button>Add to cart</button> &mdash; retail customers can order directly.</p>
      <p>Shipping is calculated at checkout. Local delivery and in-store pickup available.</p>
    </main>
    <footer>
      <address>${m.companyName}<br />${m.address}<br />+1 555 0${(m.domain.length % 900) + 100}</address>
      <p>Powered by Shopify</p>
    </footer>
  </body>
</html>`;
}

/** Fits the ICP but publishes no address at all: must end DISQUALIFIED. */
function contactFormOnlyPage(m: SimMerchant, idea: SimIdea): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Wholesale | ${m.companyName}</title></head>
  <body>
    <h1>Wholesale enquiries</h1>
    <p>
      ${m.companyName} is a ${idea.ecosystem} store selling to retail stockists and
      wholesalers in case-pack quantities. Minimum order applies.
    </p>
    <form action="/pages/contact" method="post">
      <label>Your email<input type="email" name="email" /></label>
      <button type="submit">Send enquiry</button>
    </form>
    <p><button>Add to cart</button></p>
    <footer><p>Powered by Shopify</p><address>${m.address}</address></footer>
  </body></html>`;
}

/** Behind a login: the qualifier must refuse to read it. */
function authWallPage(m: SimMerchant): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Sign in | ${m.companyName}</title></head>
  <body>
    <h1>Sign in to your wholesale account</h1>
    <form action="/account/login" method="post">
      <label>Email<input type="email" name="email" /></label>
      <label>Password<input type="password" name="password" /></label>
      <button type="submit">Log in</button>
    </form>
    <p>Please log in to continue. Don't have an account? Register for trade access.</p>
  </body></html>`;
}

/** Sells TO merchants. The qualifier must detect this and reject it. */
function vendorPage(m: SimMerchant, idea: SimIdea): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>${m.companyName} — apps for merchants</title></head>
  <body>
    <h1>${idea.wedgeType.replace(/[-_]+/g, ' ')} for merchants</h1>
    <p>Trusted by thousands of merchants. Install our app and book a demo today.</p>
    <p>Our customers include leading brands. Request a demo to see it live.</p>
    <p>Pricing from $19.99/month. <a href="mailto:sales@${m.domain}">sales@${m.domain}</a></p>
  </body></html>`;
}

/** A real business, but not in this segment. No ICP signal to match. */
function notIcpPage(m: SimMerchant): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>${m.companyName} — bookkeeping</title></head>
  <body>
    <h1>${m.companyName}</h1>
    <p>Independent bookkeeping and payroll filing for local tradespeople. Appointments only.</p>
    <address>${m.address}</address>
    <p><a href="mailto:office@${m.domain}">office@${m.domain}</a></p>
  </body></html>`;
}

function pageFor(m: SimMerchant, idea: SimIdea): string {
  switch (m.shape) {
    case 'WHOLESALE': return wholesalePage(m, idea);
    case 'CONTACT_FORM_ONLY': return contactFormOnlyPage(m, idea);
    case 'AUTH_WALL': return authWallPage(m);
    case 'VENDOR': return vendorPage(m, idea);
    case 'NOT_ICP': return notIcpPage(m);
  }
}

/** The marketplace listing a category's competitors are read from. */
function appListingPage(idea: SimIdea): string {
  const paid = idea.hasStrongPaymentEvidence;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>${idea.name} — ${idea.ecosystem} App Store</title></head>
  <body>
    <h1>${idea.name}</h1>
    <p>${idea.paidCompetitorCount} paid competitors, ${idea.competitorCount} total listings.</p>
    <section>
      <h2>Pricing</h2>
      <p>${paid ? 'Standard plan: $19.99/month. 7-day trial. No free plan.' : 'Free plan available forever.'}</p>
    </section>
    <section>
      <h2>Reviews</h2>
      <p>${paid ? 'We have been on the $19.99 plan for two years.' : 'Great free app.'}</p>
      <p>Support took days and the rule silently stopped applying to tagged customers.</p>
    </section>
  </body></html>`;
}

// --- the transport -----------------------------------------------------------

export interface SimWeb {
  /** Every merchant, by domain. */
  merchants: Map<string, SimMerchant>;
  /** Merchant domains by idea key, in discovery order. */
  byIdea: Map<string, SimMerchant[]>;
  counters: { fetches: number; notFound: number; injectionsServed: number };
}

export function buildSimWeb(ideas: SimIdea[]): SimWeb {
  const merchants = new Map<string, SimMerchant>();
  const byIdea = new Map<string, SimMerchant[]>();
  for (const idea of ideas) {
    const list = merchantsFor(idea);
    byIdea.set(idea.key, list);
    for (const m of list) merchants.set(m.domain, m);
  }
  return { merchants, byIdea, counters: { fetches: 0, notFound: 0, injectionsServed: 0 } };
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/**
 * Serves the simulated web. Installed via `setHttpTransport`, so the real
 * politeFetch still applies robots, throttling, retries and the size cap.
 *
 * `pendingInjection` lets the chaos schedule plant a prompt-injection payload
 * in the next page served, which must be treated as inert data downstream.
 */
export function makeSimHttpTransport(
  web: SimWeb,
  ideas: SimIdea[],
  hooks: { pendingInjection: () => string | null; malformed: () => boolean },
): (url: string, init: RequestInit) => Promise<Response> {
  const ideaByKey = new Map(ideas.map((i) => [i.key, i]));

  return async (url: string): Promise<Response> => {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    // Unrestricted crawling in the simulated world; the real robots parser runs.
    if (parsed.pathname === '/robots.txt') {
      return new Response('User-agent: *\nAllow: /\n', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }

    web.counters.fetches += 1;

    const injection = hooks.pendingInjection();
    const inject = (body: string): string => {
      if (injection === null) return body;
      web.counters.injectionsServed += 1;
      // Hidden in a comment and in invisible text, exactly as a hostile page
      // would do it. Extraction must carry it as data, never as instruction.
      return body.replace(
        '<main>',
        `<main><!-- ${injection} --><div style="display:none">${injection}</div>`,
      );
    };

    const merchant = web.merchants.get(host);
    if (merchant) {
      const idea = ideaByKey.get(merchant.ideaKey);
      if (!idea) return html('<html><body>gone</body></html>', 404);
      if (hooks.malformed()) {
        // Truncated mid-tag, unclosed entities: the extractor must not throw.
        return html('<!doctype html><html><head><title>Wholes');
      }
      return html(inject(pageFor(merchant, idea)));
    }

    if (host === 'apps.example.com') {
      const category = parsed.pathname.split('/').filter(Boolean)[0] ?? '';
      const idea = ideas.find((i) => i.category === category);
      if (idea) return html(inject(appListingPage(idea)));
    }

    web.counters.notFound += 1;
    return html('<html><body>not found</body></html>', 404);
  };
}
