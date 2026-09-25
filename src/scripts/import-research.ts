#!/usr/bin/env tsx
/**
 * IMPORT RESEARCH INTO THE VALIDATION LOOP — `npm run import:research`.
 *
 * The broad scan produced findings on disk; the autonomous loop operates on
 * database rows. This moves one researched opportunity into the loop so the
 * supervisor can actually run an experiment on it.
 *
 * Two things it refuses to take on trust:
 *
 *  - The WEDGE is checked by the production `validateWedge`, the same gate a
 *    model-generated wedge faces. A hand-written one gets no easier ride.
 *  - Every PROSPECT is re-verified live: its site is fetched now, the country
 *    is detected from the page by the production detector, and the contact
 *    address must still be published. A contact that was on a page last week
 *    is not evidence that it is there today, and emailing a stale address is
 *    how a sending domain gets burned.
 *
 * Contacts nobody. Import only.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: '.env', quiet: true });
process.env.OUTREACH_ENABLED = 'false';

const { getDb, closeDb, one } = await import('../lib/db');
const { runMigrations } = await import('../lib/migrate');
const { newId } = await import('../lib/hash');
const { politeFetch } = await import('../lib/fetch');
const { extractText } = await import('../pipeline/prospecting/html');
const { findPublicContact, detectCountry } = await import('../pipeline/prospecting/contact');
const { validateWedge } = await import('../pipeline/wedge/generate');
const { getConfig } = await import('../lib/config');

interface Doss {
  cluster: { vertical: string; workflow: string; buyer: string; findings: Array<{ url: string; quote: string }> };
  prospects: Array<{ companyName: string; domain: string; whatTheyDo: string; workflowEvidence: string; contact: string | null }>;
  incumbents: Array<{ productName: string; url: string; pricingText: string }>;
}

/**
 * The wedge, written from the real evidence and nothing else.
 *
 * Price is anchored on what the research actually found: practitioners
 * reported 30-60 minutes per client per month, so an agency with 20 clients
 * spends roughly 10-20 hours. $299/month is a fraction of that labour and sits
 * in the self-serve band the validator enforces.
 */
const AGENCY_WEDGE = {
  statement:
    'For digital marketing agencies with 10 or more retained paid-media clients, assemble each ' +
    'monthly client report from the ad platforms the agency already uses, instead of exporting and ' +
    'pasting screenshots by hand.',
  productName: 'Monthly Client Report Assembly',
  targetCustomer: 'digital marketing agencies with 10 or more retained paid-media clients who report monthly',
  coreWorkflow: 'assembling every retained client\'s monthly performance report at month end',
  v1Features: [
    'scheduled pull of campaign metrics per client',
    'one branded report per client from a saved template',
    'consistent metric definitions across platforms',
  ],
  excludedFromV1: ['real-time dashboards', 'white-label client portals', 'invoicing or billing'],
  proposedPriceMonthly: 299,
  estimatedBuildDays: 6,
  primaryCompetitor: 'a spreadsheet plus Adobe Acrobat',
  reasonSomeoneWouldSwitch:
    'the current process costs 30 to 60 minutes per client every month and the numbers disagree between platforms',
  oneSentenceOutcome: 'Month-end client reports assemble themselves.',
  capabilities: [
    'scheduled pull of campaign metrics per client',
    'one branded report per client from a saved template',
    'consistent metric definitions across platforms',
  ],
  whoItIsFor: 'digital marketing agencies with 10 or more retained paid-media clients who report monthly',
};

async function main(): Promise<void> {
  const cfg = getConfig();
  await runMigrations();
  const db = await getDb();

  const dir = path.resolve(process.cwd(), 'research');
  const files = (await readdir(dir)).filter((f) => f.startsWith('deep-dive-') && f.endsWith('.json')).sort();
  const latest = files[files.length - 1];
  if (!latest) throw new Error('no deep-dive output; run npm run deep:dive');
  const dossiers = JSON.parse(await readFile(path.join(dir, latest), 'utf8')) as Doss[];
  const agency = dossiers.find((d) => d.cluster.vertical === 'agencies');
  if (!agency) throw new Error('no agency dossier found');

  console.log('='.repeat(78));
  console.log('  IMPORT: agency client reporting');
  console.log('='.repeat(78));

  // The wedge faces the production validator.
  const validation = validateWedge(AGENCY_WEDGE, { maxBuildDays: cfg.gate.maxMvpBuildDays });
  if (!validation.ok) {
    console.error('wedge rejected by the production validator:');
    for (const p of validation.problems) console.error(`  [${p.code}] ${p.message}`);
    process.exitCode = 1;
    return;
  }
  console.log('  wedge passes the production validator');

  const dedupeKey = 'b2b:agency-client-reporting';
  const existing = await one<{ id: string }>('SELECT id FROM opportunities WHERE dedupe_key = $1', [dedupeKey]);
  let opportunityId = existing?.id ?? '';

  if (!opportunityId) {
    opportunityId = newId('opp');
    await db.query(
      `INSERT INTO opportunities
         (id, name, ecosystem, category, description, source_url, state, dedupe_key,
          evidence_confidence, estimated_build_days, proposed_wedge, target_customer,
          proposed_price_monthly, wedge_json, validation_stage)
       VALUES ($1,$2,'web','client-reporting',$3,$4,'WEDGE_GENERATED',$5,'HIGH',$6,$7,$8,$9,$10,'EVIDENCE_BACKED')`,
      [
        opportunityId,
        'Agency monthly client reporting',
        agency.cluster.workflow.slice(0, 900),
        agency.cluster.findings[0]?.url ?? null,
        dedupeKey,
        AGENCY_WEDGE.estimatedBuildDays,
        AGENCY_WEDGE.statement,
        AGENCY_WEDGE.targetCustomer,
        AGENCY_WEDGE.proposedPriceMonthly,
        JSON.stringify(AGENCY_WEDGE),
      ],
    );
    console.log(`  opportunity created: ${opportunityId}`);
  } else {
    console.log(`  opportunity already present: ${opportunityId}`);
  }

  // --- prospects, re-verified live ----------------------------------------
  let imported = 0;
  let rejected = 0;
  for (const p of agency.prospects) {
    if (!p.contact) continue;
    const already = await one<{ id: string }>(
      'SELECT id FROM prospects WHERE opportunity_id = $1 AND domain = $2',
      [opportunityId, p.domain],
    );
    if (already) continue;

    let text = '';
    try {
      const res = await politeFetch(`https://${p.domain}/`);
      text = extractText(res.body).slice(0, 12_000);
    } catch {
      console.log(`  REJECT ${p.domain}: site not reachable now`);
      rejected += 1;
      continue;
    }

    // A company's postal address is usually on the contact or about page, not
    // the homepage, so country detection reads those too. The allowlist is a
    // legal boundary and is never guessed — but it should not reject a real US
    // business simply because we looked at the wrong page.
    for (const suffix of ['contact', 'contact-us', 'about', 'about-us']) {
      if (detectCountry(text, p.domain) === 'US') break;
      try {
        const extra = await politeFetch(`https://${p.domain}/${suffix}`);
        text += `\n${extractText(extra.body).slice(0, 8000)}`;
      } catch {
        /* page absent: try the next one */
      }
    }

    const country = detectCountry(text, p.domain);
    if (country !== 'US') {
      console.log(`  REJECT ${p.domain}: country=${country ?? 'unknown'}, allowlist is ${cfg.allowedOutreachCountries.join(',')}`);
      rejected += 1;
      continue;
    }

    // The address must still be published today.
    const contact = await findPublicContact({ domain: p.domain, seedUrls: [], prefetched: [], maxPages: 3 });
    if (!contact) {
      console.log(`  REJECT ${p.domain}: no public address found now`);
      rejected += 1;
      continue;
    }

    await db.query(
      `INSERT INTO prospects
         (id, opportunity_id, company_name, domain, ecosystem, status, contact_email,
          email_is_public, country, public_evidence_url, contact_source_url,
          qualification_reason, qualification_score, evidence_json)
       VALUES ($1,$2,$3,$4,'web','QUALIFIED',$5,true,$6,$7,$8,$9,$10,$11)`,
      [
        newId('pr'),
        opportunityId,
        p.companyName.slice(0, 200),
        p.domain,
        contact.email,
        country,
        `https://${p.domain}/`,
        contact.sourceUrl,
        `${p.workflowEvidence.slice(0, 300)} (re-verified ${new Date().toISOString().slice(0, 10)})`,
        0.8,
        JSON.stringify({ importedFrom: latest, whatTheyDo: p.whatTheyDo, roleAddress: contact.isRole }),
      ],
    );
    imported += 1;
    console.log(`  OK     ${p.companyName} — ${contact.email}${contact.isRole ? ' (role)' : ''}`);
  }

  const total = await one<{ n: string }>(
    `SELECT COUNT(*) AS n FROM prospects WHERE opportunity_id = $1 AND status = 'QUALIFIED'`,
    [opportunityId],
  );
  console.log('');
  console.log(`  imported ${imported}, rejected ${rejected}; ${total?.n ?? 0} qualified prospects on this opportunity`);
  console.log(`  opportunity: ${opportunityId}`);
}

try {
  await main();
} catch (err) {
  console.error(`import error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await closeDb().catch(() => undefined);
}
