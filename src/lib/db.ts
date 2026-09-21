/**
 * Database access.
 *
 * One SQL dialect, two runtimes:
 *   - postgres  : Supabase (or any Postgres) via DATABASE_URL, using postgres.js
 *   - pglite    : real Postgres compiled to WASM, zero credentials, zero install
 *
 * Shadow mode and the whole test suite run on PGlite, so the exact same
 * migrations and the exact same queries are exercised as in production.
 *
 * Queries use $1-style positional parameters everywhere. Nothing in this file
 * ever interpolates a value into SQL text.
 */
import type { PGlite } from '@electric-sql/pglite';
import { getConfig } from './config';
import { AppError } from './errors';
import { createLogger } from './logger';

const logger = createLogger('db');

export interface QueryResult<T> {
  rows: T[];
  /**
   * Rows AFFECTED for INSERT/UPDATE/DELETE, rows RETURNED for SELECT.
   *
   * This distinction matters: the optimistic-concurrency idiom
   * (`UPDATE ... WHERE state = $expected` then check the count) is how this
   * codebase avoids double-sends and lost updates, and it is silently broken
   * if an UPDATE without RETURNING reports 0.
   */
  rowCount: number;
}

export interface Db {
  readonly kind: 'postgres' | 'pglite';
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Runs fn inside a transaction; rolls back on throw. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// --- PGlite ------------------------------------------------------------------

class PgliteDb implements Db {
  readonly kind = 'pglite' as const;
  constructor(private readonly client: PGlite, private readonly inTx = false) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.client.query<T>(sql, params as never[]);
    // PGlite reports affectedRows for DML and 0 for SELECT, so prefer it and
    // fall back to the returned-row count.
    const affected = (res as unknown as { affectedRows?: number }).affectedRows ?? 0;
    return { rows: res.rows as T[], rowCount: affected > 0 ? affected : res.rows.length };
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (this.inTx) return fn(this); // already inside one; keep it flat
    await this.client.exec('BEGIN');
    try {
      const out = await fn(new PgliteDb(this.client, true));
      await this.client.exec('COMMIT');
      return out;
    } catch (err) {
      await this.client.exec('ROLLBACK').catch(() => undefined);
      throw err;
    }
  }

  async close(): Promise<void> {
    if (!this.inTx) await this.client.close();
  }
}

// --- postgres.js -------------------------------------------------------------

type Sql = {
  unsafe: (sql: string, params?: unknown[]) => Promise<unknown[] & { count?: number }>;
  begin: <T>(fn: (tx: Sql) => Promise<T>) => Promise<T>;
  end: (opts?: { timeout?: number }) => Promise<void>;
};

class PostgresDb implements Db {
  readonly kind = 'postgres' as const;
  constructor(private readonly sql: Sql, private readonly inTx = false) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const result = await this.sql.unsafe(sql, params);
    const rows = result as unknown as T[];
    // postgres.js exposes the affected-row count as `.count` on the result.
    const affected = typeof result.count === 'number' ? result.count : 0;
    return { rows, rowCount: affected > 0 ? affected : rows.length };
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (this.inTx) return fn(this);
    return this.sql.begin(async (tx) => fn(new PostgresDb(tx, true)));
  }

  async close(): Promise<void> {
    if (!this.inTx) await this.sql.end({ timeout: 5 });
  }
}

// --- factory -----------------------------------------------------------------

let instance: Db | null = null;

function resolveKind(): 'postgres' | 'pglite' {
  const cfg = getConfig();
  if (cfg.databaseMode === 'postgres') {
    if (!cfg.databaseUrl) throw new AppError('DATABASE_MODE=postgres but DATABASE_URL is empty', 'CONFIG_INVALID');
    return 'postgres';
  }
  if (cfg.databaseMode === 'pglite') return 'pglite';
  return cfg.databaseUrl ? 'postgres' : 'pglite';
}

export async function getDb(): Promise<Db> {
  if (instance) return instance;
  const cfg = getConfig();
  const kind = resolveKind();

  if (kind === 'postgres') {
    const { default: postgres } = await import('postgres');
    const sql = postgres(cfg.databaseUrl, {
      max: 3,
      idle_timeout: 20,
      connect_timeout: 15,
      prepare: false, // Supabase transaction-mode pooler compatibility
      onnotice: () => undefined,
    });
    logger.info('database connected', { kind });
    instance = new PostgresDb(sql as unknown as Sql);
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    // In-memory when explicitly requested (tests); file-backed otherwise so a
    // local shadow run keeps its state between invocations.
    const dir = cfg.pgliteDataDir === ':memory:' ? undefined : cfg.pgliteDataDir;
    const client = dir ? await PGlite.create(dir) : await PGlite.create();
    logger.info('database connected', { kind, dir: dir ?? ':memory:' });
    instance = new PgliteDb(client);
  }
  return instance;
}

/** Test/CLI helper: drop the cached handle so the next getDb() reconnects. */
export async function closeDb(): Promise<void> {
  if (instance) {
    await instance.close();
    instance = null;
  }
}

export function setDbForTesting(db: Db | null): void {
  instance = db;
}

// --- small query helpers -----------------------------------------------------

export async function one<T>(sql: string, params: unknown[] = []): Promise<T | null> {
  const db = await getDb();
  const { rows } = await db.query<T>(sql, params);
  return rows[0] ?? null;
}

export async function many<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = await getDb();
  const { rows } = await db.query<T>(sql, params);
  return rows;
}

export async function exec(sql: string, params: unknown[] = []): Promise<number> {
  const db = await getDb();
  const { rowCount } = await db.query(sql, params);
  return rowCount;
}

/** COUNT(*) helper that always returns a real number regardless of driver. */
export async function count(sql: string, params: unknown[] = []): Promise<number> {
  const row = await one<{ n: string | number }>(sql, params);
  return row ? Number(row.n) : 0;
}

/** Postgres NUMERIC comes back as a string in both drivers. Normalize it. */
export function toNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}
