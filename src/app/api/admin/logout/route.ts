/** Clears the admin cookie. Safe to call unauthenticated — it only removes. */
import { clearAdminCookie } from '@/app/admin/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  return new Response(null, {
    status: 303,
    headers: {
      location: new URL('/admin/login', req.url).toString(),
      'set-cookie': clearAdminCookie(),
      'cache-control': 'no-store',
    },
  });
}
