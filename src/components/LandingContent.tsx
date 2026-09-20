/**
 * The pilot landing page body.
 *
 * Pure and synchronous: it renders a `LandingView` and nothing else. All copy
 * comes from the stored campaign copy; the only fixed strings are the
 * transparency disclosure, the pilot terms and the build-decision note, which
 * are constants precisely so no generated copy can remove them.
 */
import PilotForm from './PilotForm';
import {
  BUILD_DECISION_NOTE,
  PILOT_TERMS,
  VALIDATION_DISCLOSURE,
  type LandingView,
} from '@/app/_lib/landing';

export default function LandingContent({ view }: { view: LandingView }) {
  const { copy } = view;

  return (
    <main className="wrap">
      <p className="eyebrow">Early access / pilot</p>

      <h1>{copy.productName}</h1>
      {copy.oneSentenceOutcome ? <p className="lede">{copy.oneSentenceOutcome}</p> : null}

      <div className="notice">
        <p>
          <strong>{VALIDATION_DISCLOSURE}</strong>
        </p>
        {copy.validationNote ? <p className="small">{copy.validationNote}</p> : null}
      </div>

      {copy.problem ? (
        <section>
          <h2>The problem</h2>
          <p>{copy.problem}</p>
        </section>
      ) : null}

      {copy.capabilities.length > 0 ? (
        <section>
          <h2>What it would do</h2>
          <ul>
            {copy.capabilities.map((item, i) => (
              <li key={`cap-${i}`}>{item}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {copy.notIncluded.length > 0 ? (
        <section>
          <h2>What it would not do</h2>
          <ul>
            {copy.notIncluded.map((item, i) => (
              <li key={`ex-${i}`}>{item}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {copy.whoItIsFor ? (
        <section>
          <h2>Who it is for</h2>
          <p>{copy.whoItIsFor}</p>
        </section>
      ) : null}

      {copy.currentAlternative ? (
        <section>
          <h2>Why we think it is worth building</h2>
          <p>{copy.currentAlternative}</p>
        </section>
      ) : null}

      <section>
        <h2>Proposed price</h2>
        <p>
          <strong>{view.priceLabel}/month</strong> per business. That is the price we are testing —
          it is the number we will build to if this validates.
        </p>
      </section>

      <section id="pilot">
        <h2>{view.ctaLabel}</h2>
        <p>{PILOT_TERMS}</p>
        {copy.pilotNote ? <p>{copy.pilotNote}</p> : null}
        <p>{BUILD_DECISION_NOTE}</p>

        <PilotForm
          slug={view.slug}
          ctaLabel={view.ctaLabel}
          priceLabel={view.priceLabel}
          priceCheckboxLabel={view.priceCheckboxLabel}
        />
      </section>

      <hr />

      <footer className="small muted">
        <p>
          We contacted you because your business looks like it has this problem today. If you would
          rather not hear from us again, use the unsubscribe link in the email — it takes effect
          immediately.
        </p>
      </footer>
    </main>
  );
}
