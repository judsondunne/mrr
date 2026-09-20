/**
 * Public health endpoint. Unauthenticated, so it says as little as possible:
 * whether the database answers, whether migrations have been applied, and the
 * status of the most recent job run. No configuration, no names, no versions,
 * no error text.
 */
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  let database = false;
  let migrationsApplied = false;
  let lastJobStatus: string | null = null;
  let lastJobAt: string | null = null;

  try {
    const db = await getDb();
    await db.query('SELECT 1');
    database = true;

    const migrations = await db.query<{ n: string | number }>(
      `SELECT COUNT(*) AS n FROM schema_migrations`,
    );
    migrationsApplied = Number(migrations.rows[0]?.n ?? 0) > 0;

    if (migrationsApplied) {
      const jobs = await db.query<{ status: string; started_at: string | null }>(
        `SELECT status, started_at FROM job_runs ORDER BY started_at DESC LIMIT 1`,
      );
      const row = jobs.rows[0];
      if (row) {
        lastJobStatus = row.status;
        lastJobAt = row.started_at ? new Date(row.started_at).toISOString() : null;
      }
    }
  } catch {
    // Intentionally silent: the response below already says "not ok".
    database = false;
  }

  const ok = database && migrationsApplied;

  return new Response(
    JSON.stringify({
      ok,
      status: ok ? 'ok' : 'degraded',
      database,
      migrationsApplied,
      lastJobStatus,
      lastJobAt,
      time: new Date().toISOString(),
    }),
    {
      status: ok ? 200 : 503,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    },
  );
}
