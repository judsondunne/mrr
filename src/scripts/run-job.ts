#!/usr/bin/env tsx
/** Usage: npm run job -- <job_name>   |   npm run job -- --all */
import { runMigrations } from '../lib/migrate.js';
import { closeDb } from '../lib/db.js';
import { JOB_NAMES, runJob, runPipeline } from '../jobs/registry.js';
import { isShadowMode } from '../lib/config.js';

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg || arg === '--help') {
    console.log('Usage: npm run job -- <job_name>\n       npm run job -- --all\n');
    console.log('Jobs:');
    for (const j of JOB_NAMES) console.log(`  ${j}`);
    return;
  }

  await runMigrations();
  if (isShadowMode()) console.log('*** SHADOW MODE — no real email can be sent ***\n');

  const summaries = arg === '--all' ? await runPipeline() : [await runJob(arg)];

  console.log('\nJob results');
  console.log('-'.repeat(78));
  for (const s of summaries) {
    const mark = s.status === 'SUCCESS' ? 'ok  ' : s.status === 'SKIPPED' ? 'skip' : 'FAIL';
    console.log(
      `[${mark}] ${s.job.padEnd(32)} ${String(s.recordsProcessed).padStart(5)} records` +
        `  ${String(s.durationMs).padStart(6)}ms  $${s.cost.toFixed(4)}` +
        (s.error ? `  (${s.error})` : ''),
    );
  }
  const failed = summaries.filter((s) => s.status === 'FAILED');
  await closeDb();
  if (failed.length > 0) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error('Job runner failed:', err);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
