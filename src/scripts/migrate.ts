#!/usr/bin/env tsx
import { runMigrations } from '../lib/migrate';
import { closeDb, getDb } from '../lib/db';

async function main(): Promise<void> {
  const db = await getDb();
  console.log(`Database: ${db.kind}`);
  const { applied, alreadyApplied } = await runMigrations();
  if (applied.length === 0) {
    console.log(`Up to date (${alreadyApplied} migrations already applied).`);
  } else {
    console.log(`Applied ${applied.length} migration(s):`);
    for (const f of applied) console.log(`  + ${f}`);
  }
  await closeDb();
}

main().catch(async (err) => {
  console.error('Migration failed:', err instanceof Error ? err.message : err);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
