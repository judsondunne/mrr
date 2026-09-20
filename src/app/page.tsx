/**
 * Root page. Deliberately contains no marketing claim of any kind: nothing here
 * is a product, and this system must never imply that one exists.
 */
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'MRR Validator',
  robots: { index: false, follow: false },
};

export default function HomePage() {
  return (
    <main className="wrap">
      <h1>MRR Validator</h1>
      <p className="muted">
        Internal demand-validation system. There is nothing to sign up for on this page.
      </p>
      <p className="small muted">
        Pilot pages live at <code>/v/&lt;slug&gt;</code> and are linked directly from the email
        that referenced them. Operators: <a href="/admin">/admin</a>.
      </p>
    </main>
  );
}
