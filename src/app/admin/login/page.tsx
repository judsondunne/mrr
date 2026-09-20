/**
 * Admin sign-in page. The only unauthenticated page under /admin.
 * It never renders the expected token, only whether one is configured.
 */
import { getConfig } from '@/lib/config';
import { safeNextPath } from '@/app/admin/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type PageProps = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export default async function AdminLoginPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const error = first(query.error);
  const next = safeNextPath(first(query.next));
  const configured = getConfig().adminToken !== '';

  return (
    <main className="wrap">
      <h1>Admin sign in</h1>

      {!configured ? (
        <p className="notice blocked">
          <strong>ADMIN_TOKEN is not set.</strong> Admin access is disabled until it is configured
          in the environment.
        </p>
      ) : null}

      {error === 'rate' ? (
        <p className="notice blocked">Too many attempts. Wait a minute and try again.</p>
      ) : null}
      {error && error !== 'rate' ? (
        <p className="notice blocked">That token was not accepted.</p>
      ) : null}

      <form method="post" action="/api/admin/login">
        <label htmlFor="admin-token">Admin token</label>
        <input
          id="admin-token"
          name="token"
          type="password"
          required
          autoComplete="off"
          maxLength={512}
        />
        <input type="hidden" name="next" value={next} />
        <button type="submit">Sign in</button>
      </form>

      <p className="small muted">
        The token is stored in an httpOnly cookie for this browser. Automated callers may send
        <code> Authorization: Bearer &lt;ADMIN_TOKEN&gt;</code> instead.
      </p>
    </main>
  );
}
