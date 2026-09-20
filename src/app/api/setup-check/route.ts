/**
 * Admin-protected setup check.
 *
 * Delegates entirely to `runSetupChecks()` in the foundation layer, which is
 * the single source of truth and is already non-destructive: it verifies
 * configuration presence and database connectivity, sends no test email and
 * spends no LLM tokens.
 */
import { guardAdminRequest } from '@/app/admin/auth';
import { runSetupChecks } from '@/lib/setup-check';
import { overallVerdict } from '@/app/_lib/setup-view';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request): Promise<Response> {
  const denied = guardAdminRequest(req);
  if (denied) return denied;

  const report = await runSetupChecks();
  return new Response(
    JSON.stringify({
      ...report,
      verdict: overallVerdict(report),
      generatedAt: new Date().toISOString(),
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    },
  );
}
