#!/usr/bin/env tsx
/**
 * Seeds the four demo scenarios so you can explore the dashboard and the
 * validation gate with zero credentials and zero outbound email.
 *
 * Everything seeded is SYNTHETIC: domains are *.example.com, which cannot
 * resolve to a real business, and seeding never triggers a send.
 */
import { runMigrations } from '../lib/migrate.js';
import { closeDb, getDb } from '../lib/db.js';
import { seedAll, SCENARIOS, seedScenario, type ScenarioName } from './fixtures.js';

async function main(): Promise<void> {
  const only = process.argv[2] as ScenarioName | undefined;
  if (only && !SCENARIOS.includes(only)) {
    console.error(`Unknown scenario "${only}". Known: ${SCENARIOS.join(', ')}`);
    process.exit(1);
  }

  await runMigrations();
  const seeded = only ? [await seedScenario(only)] : await seedAll();

  console.log('\nSeeded demo scenarios (all synthetic, nothing will be emailed):');
  console.log('-'.repeat(78));
  for (const s of seeded) {
    console.log(`  ${s.scenario.padEnd(26)} ${s.opportunityId}  expects ${s.expectedFinalState}`);
  }

  const db = await getDb();
  const counts = await db.query<{ state: string; n: string }>(
    'SELECT state, COUNT(*) AS n FROM opportunities GROUP BY state ORDER BY state',
  );
  console.log('\nOpportunities by state:');
  for (const r of counts.rows) console.log(`  ${r.state.padEnd(28)} ${r.n}`);

  console.log('\nNext:');
  console.log('  npm run job -- evaluate_campaigns   # runs the deterministic gate');
  console.log('  npm run dev                         # then open /admin/opportunities');
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
