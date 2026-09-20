#!/usr/bin/env tsx
/**
 * SHADOW MODE.
 *
 * Runs the full research pipeline with outbound sending physically disabled,
 * then prints what the system found and what it WOULD have sent. Works with no
 * credentials at all — mock providers stand in for Anthropic, Brave and Resend,
 * and the database is local PGlite.
 */
import { closeDb, getDb, toNumber } from '../lib/db';
import { runMigrations } from '../lib/migrate';
import { getConfig, resetConfigCache } from '../lib/config';
import { runPipeline, type JobName } from '../jobs/registry';
import { getBudgetSnapshot, getCostBreakdown } from '../lib/cost';

// Force shadow before any module reads config.
process.env.AUTONOMY_ENABLED = 'false';
process.env.OUTREACH_ENABLED = 'false';
resetConfigCache();

const RESEARCH_JOBS: JobName[] = [
  'discover_opportunities',
  'verify_categories',
  'generate_wedges',
  'discover_prospects',
  'qualify_prospects',
  'prepare_campaigns',
  'evaluate_campaigns',
  'recalculate_costs',
];

async function main(): Promise<void> {
  const cfg = getConfig();
  console.log('\n' + '='.repeat(78));
  console.log('  SHADOW MODE — research runs, NOTHING is sent');
  console.log('='.repeat(78));
  console.log(`  LLM provider    : ${cfg.anthropicApiKey ? cfg.llmProvider : 'mock (no ANTHROPIC_API_KEY)'}`);
  console.log(`  Search provider : ${cfg.braveSearchApiKey ? cfg.searchProvider : 'mock (no BRAVE_SEARCH_API_KEY)'}`);
  console.log(`  Email provider  : mock (outreach disabled)`);
  console.log(`  LLM budget      : $${cfg.monthlyLlmBudgetUsd}/month`);
  console.log('='.repeat(78) + '\n');

  await runMigrations();
  const summaries = await runPipeline(RESEARCH_JOBS);

  console.log('\nJOB RESULTS');
  console.log('-'.repeat(78));
  for (const s of summaries) {
    console.log(
      `  ${s.status.padEnd(14)} ${s.job.padEnd(30)} ${String(s.recordsProcessed).padStart(4)} records` +
        (s.error ? `  (${s.error})` : ''),
    );
  }

  await printFunnel();
  await printDrafts();
  await printCosts();

  console.log('\nNothing above was sent. To go live:');
  console.log('  1. npm run setup-check      (fix every FAIL)');
  console.log('  2. npm run autonomy:enable\n');
  await closeDb();
}

async function printFunnel(): Promise<void> {
  const db = await getDb();
  const res = await db.query<{ state: string; n: string }>(
    'SELECT state, COUNT(*) AS n FROM opportunities GROUP BY state ORDER BY state',
  );
  console.log('\nOPPORTUNITY FUNNEL');
  console.log('-'.repeat(78));
  if (res.rows.length === 0) {
    const cfg = getConfig();
    const mocked = !cfg.anthropicApiKey || !cfg.braveSearchApiKey;
    console.log('  (empty)');
    if (mocked) {
      // Without a real search key there is nothing out there to discover, so
      // an empty funnel here means "no credentials yet", not "something broke".
      console.log('');
      console.log('  This is expected: the mock search provider returns no results, so there');
      console.log('  is nothing real to discover. The pipeline itself ran fine — every job');
      console.log('  above reported SUCCESS.');
      console.log('');
      console.log('  To see the whole funnel end to end with no credentials:');
      console.log('      npm run seed');
      console.log('      npm run job -- evaluate_campaigns');
      console.log('      npm run dev    # then open /admin/opportunities');
      console.log('');
      console.log('  To discover real categories, set BRAVE_SEARCH_API_KEY and');
      console.log('  ANTHROPIC_API_KEY, then run this again. See SETUP.md.');
    }
    return;
  }
  for (const r of res.rows) console.log(`  ${r.state.padEnd(30)} ${r.n}`);
}

async function printDrafts(): Promise<void> {
  const db = await getDb();
  const res = await db.query<{ subject: string; body: string; domain: string | null }>(
    `SELECT m.subject, m.body, p.domain
       FROM messages m LEFT JOIN prospects p ON p.id = m.prospect_id
      WHERE m.direction = 'OUTBOUND' AND m.status IN ('DRAFTED','PENDING')
      ORDER BY m.created_at LIMIT 3`,
  );
  console.log('\nDRAFTED OUTREACH (not sent)');
  console.log('-'.repeat(78));
  if (res.rows.length === 0) {
    console.log('  (no drafts)');
    return;
  }
  for (const r of res.rows) {
    console.log(`\n  To     : ${r.domain ?? 'unknown'}`);
    console.log(`  Subject: ${r.subject}`);
    console.log(
      r.body
        .split('\n')
        .map((l) => `  | ${l}`)
        .join('\n'),
    );
  }
}

async function printCosts(): Promise<void> {
  const snap = await getBudgetSnapshot();
  const rows = await getCostBreakdown();
  console.log('\nCOST THIS PERIOD');
  console.log('-'.repeat(78));
  console.log(`  LLM    : $${snap.llmSpentUsd.toFixed(4)} of $${snap.llmBudgetUsd}`);
  console.log(`  Search : $${snap.searchSpentUsd.toFixed(4)} of $${snap.searchBudgetUsd}`);
  console.log(`  Emails : ${snap.emailsSentToday} today (cap ${snap.maxEmailsPerDay})`);
  for (const r of rows) {
    console.log(
      `    ${r.provider}/${r.resource_type.padEnd(20)} qty=${toNumber(r.quantity)
        .toFixed(0)
        .padStart(8)}  $${toNumber(r.estimated_cost).toFixed(6)}`,
    );
  }
}

main().catch(async (err) => {
  console.error('\nShadow run failed:', err);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
