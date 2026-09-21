#!/usr/bin/env tsx
/**
 * LIVE SHADOW RESEARCH CANARY — `npm run canary:research`.
 *
 * Runs the real research pipeline against the real public internet with
 * outreach forced OFF, to prove the internet-facing half works TODAY rather
 * than against fixtures. Fixtures prove the logic; this proves the world has
 * not moved underneath it — a changed marketplace layout or a dead source is
 * invisible to every unit test in the repo.
 *
 * What it proves, in order:
 *   1. the search provider answers a real query
 *   2. discovery turns real results into candidate rows
 *   3. sources are fetched and parsed into competitor/evidence rows
 *   4. the classifier reaches a verdict — and a legitimate REJECTION is a pass,
 *      because rejection is the correct answer for most of the internet
 *   5. prospect discovery runs when a candidate earns it
 *
 * Safety: OUTREACH_ENABLED and AUTONOMY_ENABLED are forced to false in-process
 * before any module loads config, so no outbound email is possible on any code
 * path this script can reach. It asserts that at the end by counting rows.
 *
 * Exits non-zero if the pipeline cannot do real work.
 *
 * Usage: npm run canary:research [-- --candidates 5]
 */
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: '.env', quiet: true });

// Shadow mode is not negotiable here, and is set before config is ever read.
process.env.OUTREACH_ENABLED = 'false';
process.env.AUTONOMY_ENABLED = 'false';
process.env.KILL_SWITCH = 'false';

const { getConfig, isShadowMode } = await import('../lib/config');
const { getDb, closeDb } = await import('../lib/db');
const { runMigrations } = await import('../lib/migrate');
const { getSearchProvider, search } = await import('../lib/search/index');
const { getLlmProvider } = await import('../lib/llm/index');
const { discoverOpportunities } = await import('../pipeline/discovery/index');
const { verifyCategories } = await import('../pipeline/verification/index');
const { getBudgetSnapshot } = await import('../lib/cost');

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const CANDIDATES = Math.max(1, Number(arg('candidates', '5')));

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (detail) console.log(`        ${detail}`);
}

async function main(): Promise<void> {
  const cfg = getConfig();

  console.log('='.repeat(78));
  console.log('  LIVE SHADOW RESEARCH CANARY');
  console.log('='.repeat(78));
  console.log(`  search provider : ${getSearchProvider().name}`);
  console.log(`  llm provider    : ${getLlmProvider().name}`);
  console.log(`  shadow mode     : ${isShadowMode(cfg) ? 'ON (no outbound possible)' : 'OFF'}`);
  console.log('');

  check('outreach is disabled', isShadowMode(cfg), 'no code path reached here can send email');

  // Refuse to pretend. A mock provider cannot prove anything about the live
  // internet, and reporting a green canary from mocks is the exact failure
  // mode this script exists to prevent.
  if (getSearchProvider().name === 'mock') {
    check(
      'live search provider configured',
      false,
      'SEARCH_PROVIDER resolved to the mock: BRAVE_SEARCH_API_KEY is missing, so no real ' +
        'search can be made and this canary cannot prove anything about the live internet',
    );
  } else {
    check('live search provider configured', true, `provider=${getSearchProvider().name}`);
  }
  if (getLlmProvider().name === 'mock') {
    check(
      'live LLM provider configured',
      false,
      'LLM_PROVIDER resolved to the mock: ANTHROPIC_API_KEY is missing, so classification ' +
        'would be fabricated rather than real',
    );
  } else {
    check('live LLM provider configured', true, `provider=${getLlmProvider().name}`);
  }

  const liveProviders =
    getSearchProvider().name !== 'mock' && getLlmProvider().name !== 'mock';

  await runMigrations();
  const db = await getDb();

  const before = {
    opportunities: await count(db, 'opportunities'),
    sources: await count(db, 'source_documents'),
    competitors: await count(db, 'competitors'),
    evidence: await count(db, 'evidence_claims'),
    messages: await count(db, 'messages'),
  };

  if (!liveProviders) {
    console.log('');
    console.log('  Stopping before any pipeline work: with a mock provider this run would');
    console.log('  report success without touching the internet. Set the missing key and');
    console.log('  run it again.');
    report();
    return;
  }

  // 1. One real public search.
  const query = `${arg('ecosystem', 'shopify')} app minimum order quantity pricing`;
  let results: Awaited<ReturnType<typeof search>> = [];
  try {
    results = await search(query, 5);
    check('real public search returned results', results.length > 0, `${results.length} result(s) for "${query}"`);
    if (results[0]) console.log(`        first: ${results[0].url}`);
  } catch (err) {
    check('real public search returned results', false, `search threw: ${String(err).slice(0, 200)}`);
  }

  // 2. Discovery against the live internet.
  try {
    const discovery = await discoverOpportunities(CANDIDATES);
    check(
      'discovery found real candidates',
      discovery.candidatesFound > 0,
      `candidatesFound=${discovery.candidatesFound} created=${discovery.opportunitiesCreated} ` +
        `duplicatesSkipped=${discovery.duplicatesSkipped}`,
    );
  } catch (err) {
    check('discovery found real candidates', false, `discovery threw: ${String(err).slice(0, 300)}`);
  }

  const afterDiscovery = {
    opportunities: await count(db, 'opportunities'),
    sources: await count(db, 'source_documents'),
  };
  check(
    'source documents were fetched and stored',
    afterDiscovery.sources > before.sources,
    `source_documents ${before.sources} -> ${afterDiscovery.sources}`,
  );

  // 3. Verification: extract payment evidence and reach a verdict. A rejection
  //    IS a pass — most of the internet should be rejected, and the thing being
  //    proven is that the pipeline can decide, not that it says yes.
  try {
    const outcomes = await verifyCategories(Math.min(3, CANDIDATES));
    const verified = outcomes.filter((o) => o.verified);
    const rejected = outcomes.filter((o) => !o.verified);
    check(
      'classification reached a verdict on real evidence',
      outcomes.length > 0,
      outcomes.length === 0
        ? 'nothing was in a verifiable state; discovery produced no new candidate'
        : `${verified.length} verified, ${rejected.length} rejected — ` +
          `reasons: ${[...new Set(rejected.map((r) => r.rejectionReason ?? 'none'))].join(', ') || 'n/a'}`,
    );
    const withEvidence = outcomes.filter(
      (o) => o.strongEvidence.length + o.supportingEvidence.length > 0,
    );
    check(
      'payment evidence was extracted',
      withEvidence.length > 0 || outcomes.length === 0,
      withEvidence.length > 0
        ? `${withEvidence.length} candidate(s) carried evidence rows`
        : 'no candidate carried evidence (all rejected before evidence weighing)',
    );
  } catch (err) {
    check('classification reached a verdict on real evidence', false, `verification threw: ${String(err).slice(0, 300)}`);
  }

  const afterVerify = {
    competitors: await count(db, 'competitors'),
    evidence: await count(db, 'evidence_claims'),
  };
  check(
    'evidence rows recorded',
    afterVerify.competitors > before.competitors || afterVerify.evidence > before.evidence,
    `competitors ${before.competitors} -> ${afterVerify.competitors}, ` +
      `evidence_claims ${before.evidence} -> ${afterVerify.evidence}`,
  );

  // 4. Prospect discovery, but only for a candidate that earned it. Running it
  //    for nothing is not a pass and not a failure — it is "nothing qualified",
  //    which is reported as such.
  const prospectable = await db.query<{ id: string }>(
    `SELECT id FROM opportunities WHERE state IN ('WEDGE_GENERATED','PROSPECTING') LIMIT 1`,
  );
  if (prospectable.rows.length > 0) {
    const { discoverProspects } = await import('../pipeline/prospecting/index');
    try {
      const results2 = await discoverProspects(1);
      check(
        'prospect discovery ran for an eligible candidate',
        true,
        `${results2.reduce((n, r) => n + r.discovered, 0)} prospect(s) discovered`,
      );
    } catch (err) {
      check('prospect discovery ran for an eligible candidate', false, String(err).slice(0, 200));
    }
  } else {
    console.log('  ----  prospect discovery not attempted: no candidate reached WEDGE_GENERATED');
    console.log('        (correct when every live candidate was legitimately rejected)');
  }

  // 5. Nothing may have been sent, on any path.
  const messages = await count(db, 'messages');
  const outbound = await db.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM messages WHERE direction = 'OUTBOUND' AND sent_at IS NOT NULL`,
  );
  check(
    'no email was sent',
    Number(outbound.rows[0]?.n ?? 0) === 0 && messages === before.messages,
    `outbound sent rows = ${outbound.rows[0]?.n ?? 0}`,
  );

  const snap = await getBudgetSnapshot();
  console.log('');
  console.log(`  spend this run : LLM $${snap.llmSpentUsd.toFixed(4)} of $${snap.llmBudgetUsd}, ` +
    `search $${snap.searchSpentUsd.toFixed(4)} of $${snap.searchBudgetUsd}`);

  report();
}

async function count(db: Awaited<ReturnType<typeof getDb>>, table: string): Promise<number> {
  const res = await db.query<{ n: string }>(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(res.rows[0]?.n ?? 0);
}

function report(): void {
  const failed = checks.filter((c) => !c.ok);
  console.log('');
  console.log('='.repeat(78));
  console.log(`  ${checks.length - failed.length}/${checks.length} canary checks passed`);
  console.log('='.repeat(78));
  if (failed.length > 0) {
    console.error('\nFAILED CHECKS:');
    for (const c of failed) console.error(`  - ${c.name}: ${c.detail}`);
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (err) {
  console.error(`\ncanary error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await closeDb().catch(() => undefined);
}
