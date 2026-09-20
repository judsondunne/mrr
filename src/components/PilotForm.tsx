'use client';

/**
 * Pilot signup form.
 *
 * Posts JSON to /api/pilot and renders an honest result state. Every claim in
 * this component is either supplied by the caller (price, CTA text) or is a
 * statement of fact about what the system just did.
 */
import { useState } from 'react';

export interface PilotFormProps {
  slug: string;
  /** "Join the pilot at $29/month" */
  ctaLabel: string;
  /** "$29" */
  priceLabel: string;
  /** "I'd like to use this at $29/month when available." */
  priceCheckboxLabel: string;
}

type Status = 'idle' | 'submitting' | 'done' | 'failed';

interface PilotResult {
  ok?: boolean;
  alreadyRecorded?: boolean;
  priceAccepted?: boolean;
  error?: string;
}

const ERROR_TEXT: Record<string, string> = {
  RATE_LIMITED: 'Too many submissions from this network just now. Please try again in a minute.',
  INVALID_INPUT: 'Please check the email address and the website/store URL, then try again.',
  UNKNOWN_CAMPAIGN: 'This pilot page is no longer active, so nothing was recorded.',
};

function errorText(code: string | undefined): string {
  if (code && ERROR_TEXT[code]) return ERROR_TEXT[code] as string;
  return 'Something went wrong on our side and nothing was recorded. Please try again later.';
}

export default function PilotForm({
  slug,
  ctaLabel,
  priceLabel,
  priceCheckboxLabel,
}: PilotFormProps) {
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<PilotResult | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === 'submitting') return;
    setStatus('submitting');

    const data = new FormData(event.currentTarget);
    const payload = {
      slug,
      email: String(data.get('email') ?? ''),
      domain: String(data.get('domain') ?? ''),
      question: String(data.get('question') ?? ''),
      priceAccepted: data.get('priceAccepted') === 'on',
      website: String(data.get('website') ?? ''),
    };

    try {
      const res = await fetch('/api/pilot', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = (await res.json()) as PilotResult;
      setResult(body);
      setStatus(res.ok && body.ok ? 'done' : 'failed');
    } catch {
      setResult({ ok: false });
      setStatus('failed');
    }
  }

  if (status === 'done') {
    return (
      <div className="panel" role="status">
        <h3>{result?.alreadyRecorded ? 'Already recorded' : 'Recorded — thank you'}</h3>
        {result?.alreadyRecorded ? (
          <p>
            We already had a signup from your company for this pilot. It was not counted twice.
          </p>
        ) : (
          <p>
            Your interest is recorded{result?.priceAccepted ? `, including that ${priceLabel}/month works for you` : ''}.
          </p>
        )}
        <p>
          To be clear: the product is not built yet, no payment was taken, and you have not bought
          anything. If enough businesses commit at this price, we build it and contact this list
          first. If not enough do, we do not build it.
        </p>
      </div>
    );
  }

  return (
    <form className="pilot" onSubmit={onSubmit} noValidate={false}>
      <label htmlFor="pilot-email">Business email</label>
      <input
        id="pilot-email"
        name="email"
        type="email"
        required
        maxLength={200}
        autoComplete="email"
        placeholder="you@yourcompany.com"
      />

      <label htmlFor="pilot-domain">Your website or store URL</label>
      <input
        id="pilot-domain"
        name="domain"
        type="text"
        required
        maxLength={400}
        autoComplete="url"
        placeholder="yourcompany.com"
      />

      <label htmlFor="pilot-question">
        Anything about your workflow we should know? <span className="muted">(optional)</span>
      </label>
      <textarea id="pilot-question" name="question" maxLength={2000} />

      <div className="hp" aria-hidden="true">
        <label htmlFor="pilot-website">Leave this field empty</label>
        <input id="pilot-website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <label className="check" htmlFor="pilot-price">
        <input id="pilot-price" name="priceAccepted" type="checkbox" required />
        <span>{priceCheckboxLabel}</span>
      </label>

      <button type="submit" disabled={status === 'submitting'}>
        {status === 'submitting' ? 'Sending…' : ctaLabel}
      </button>

      {status === 'failed' ? (
        <p className="bad small" role="alert">
          {errorText(result?.error)}
        </p>
      ) : null}
    </form>
  );
}
