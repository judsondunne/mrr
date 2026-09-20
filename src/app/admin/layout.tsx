import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Admin — MRR Validator',
  robots: { index: false, follow: false, nocache: true },
};

/**
 * Nav only. Authentication is enforced by every page and route individually
 * (see ./auth.ts) — a layout is not a security boundary.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <nav className="admin">
        <a href="/admin">Overview</a>
        <a href="/admin/opportunities">Opportunities</a>
        <a href="/admin/costs">Costs</a>
        <a href="/admin/settings">Settings</a>
        <a href="/setup-check">Setup check</a>
        <form method="post" action="/api/admin/logout" style={{ marginLeft: 'auto' }}>
          <button type="submit" style={{ margin: 0, padding: '0.15rem 0.6rem' }}>
            Sign out
          </button>
        </form>
      </nav>
      {children}
    </>
  );
}
