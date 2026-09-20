import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getDb } from './db';
import { createLogger } from './logger';

const logger = createLogger('migrate');

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');

/**
 * Applies every unapplied .sql file in migrations/, in filename order, each in
 * its own transaction. Safe to run repeatedly and safe to run concurrently —
 * the advisory-style guard is the schema_migrations primary key.
 */
export async function runMigrations(): Promise<{ applied: string[]; alreadyApplied: number }> {
  const db = await getDb();
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const existing = await db.query<{ version: string }>('SELECT version FROM schema_migrations');
  const done = new Set(existing.rows.map((r) => r.version));

  let files: string[];
  try {
    files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    logger.warn('no migrations directory found', { dir: MIGRATIONS_DIR });
    return { applied: [], alreadyApplied: done.size };
  }

  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    await db.transaction(async (tx) => {
      // Statements are split on semicolons at line ends; our migrations are
      // plain DDL with no function bodies, so this is sufficient and avoids
      // pulling in a SQL parser.
      for (const stmt of splitStatements(sql)) {
        await tx.query(stmt);
      }
      await tx.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
    });
    applied.push(file);
    logger.info('migration applied', { file });
  }
  return { applied, alreadyApplied: done.size };
}

export function splitStatements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
