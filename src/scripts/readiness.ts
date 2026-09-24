#!/usr/bin/env tsx
/**
 * `npm run readiness` — can this system contact real businesses yet?
 *
 * Prints the machine-enforced gate that `send_due_messages` consults. Exits
 * non-zero while outreach is blocked.
 */
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: '.env', quiet: true });

const { evaluateReadiness } = await import('../autonomy/readiness');
const { closeDb } = await import('../lib/db');
const { runMigrations } = await import('../lib/migrate');

try {
  await runMigrations();
  const report = await evaluateReadiness();
  console.log('='.repeat(78));
  console.log(`  OUTREACH READINESS — ${report.ready ? 'OPEN' : 'CLOSED'}`);
  console.log('='.repeat(78));
  for (const c of report.checks) {
    console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.label}`);
    console.log(`        ${c.detail}`);
  }
  if (report.ownerActions.length > 0) {
    console.log('\n  OWNER ACTION REQUIRED:');
    for (const c of report.ownerActions) console.log(`    - [${c.id}] ${c.ownerAction}`);
  }
  console.log('');
  console.log(`  ${report.checks.length - report.blocking.length}/${report.checks.length} checks pass`);
  if (!report.ready) process.exitCode = 1;
} catch (err) {
  console.error(`readiness error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await closeDb().catch(() => undefined);
}
