/**
 * Unsubscribe confirmation page.
 *
 * Two ways in, both one-step:
 *  - redirected here by /api/unsubscribe with ?status=...
 *  - opened directly with ?token=..., in which case the suppression happens on
 *    this request. There is no confirm button anywhere on this page.
 */
import type { Metadata } from 'next';
import { outcomeFromStatus, runUnsubscribe, type UnsubscribeOutcome } from '@/app/_lib/unsubscribe';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const metadata: Metadata = {
  title: 'Unsubscribe',
  robots: { index: false, follow: false },
};

type PageProps = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export default async function UnsubscribePage({ searchParams }: PageProps) {
  const query = await searchParams;
  const token = first(query.token);

  let outcome: UnsubscribeOutcome;
  let email: string | null = null;

  if (token) {
    const result = await runUnsubscribe(token);
    outcome = result.outcome === 'MISSING_TOKEN' ? 'INVALID_TOKEN' : result.outcome;
    email = result.email;
  } else {
    outcome = outcomeFromStatus(first(query.status));
  }

  return (
    <main className="wrap">
      {outcome === 'UNSUBSCRIBED' ? (
        <>
          <h1>You are unsubscribed</h1>
          <p>
            {email ? <strong>{email}</strong> : 'That address'} has been added to our suppression
            list. We will not email it again from this system.
          </p>
          <p className="muted small">
            This took effect immediately. There is nothing to confirm and nothing else to do.
          </p>
        </>
      ) : null}

      {outcome === 'INVALID_TOKEN' ? (
        <>
          <h1>That unsubscribe link is not valid</h1>
          <p>
            The link was incomplete or could not be matched to an email address, so{' '}
            <strong>nothing was changed</strong>.
          </p>
          <p>
            Please open the original email and use the unsubscribe link in it, or reply to that
            email with the word <strong>STOP</strong> — either one will stop the mail.
          </p>
        </>
      ) : null}

      {outcome === 'ERROR' ? (
        <>
          <h1>We could not complete that just now</h1>
          <p>
            Something on our side failed. We will not tell you that you were unsubscribed when you
            may not have been. <strong>Please try the link again in a few minutes.</strong>
          </p>
          <p>
            If it keeps failing, reply to the email with the word <strong>STOP</strong> and your
            address will be suppressed by hand.
          </p>
        </>
      ) : null}
    </main>
  );
}
