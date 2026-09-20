#!/usr/bin/env tsx
import { runSetupChecks } from '../lib/setup-check';
import { closeDb } from '../lib/db';

async function main(): Promise<void> {
  const report = await runSetupChecks();

  console.log('\nMRR VALIDATOR — SETUP CHECK');
  console.log('='.repeat(72));
  for (const c of report.checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(20)} ${c.detail}`);
    if (!c.ok) console.log(`      -> ${c.remediation}`);
  }
  console.log('='.repeat(72));
  console.log(`AUTONOMY_ENABLED : ${report.autonomyEnabled}`);
  console.log(`OUTREACH_ENABLED : ${report.outreachEnabled}`);
  console.log(`MODE             : ${report.shadowMode ? 'SHADOW (nothing is sent)' : 'LIVE'}`);
  console.log('');

  if (report.safeToSend) {
    console.log('Configuration is complete. Run `npm run autonomy:enable` to go live.');
  } else {
    console.log('Outreach is BLOCKED until every safety-critical FAIL above is fixed.');
    console.log('Shadow mode still works — run `npm run shadow`.');
  }
  await closeDb();
  if (!report.safeToSend) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error(err);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
