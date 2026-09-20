# Optional: monetary validation

Off by default. Never enabled automatically. This document is the design; the code
behind `ENABLE_PAYMENT_METHOD_VALIDATION` is intentionally not wired into the MVP.

## Why it is optional

The standard gate already requires evidence that is hard to fake: a named company
explicitly accepting a price, asking for an install, or handing over setup details.
Asking for a card raises the bar further but also suppresses response rate and adds a
payments compliance surface. That trade is the owner's call, not the system's.

## The two switches

| Flag | Effect |
|---|---|
| `EXTREME_VALIDATION=true` | Raises the **gate**: additionally requires one of — 5 price-accepted pilot reservations, 3 voluntarily supplied payment methods, or real refundable deposits. Works without Stripe if you rely on the first option. |
| `ENABLE_PAYMENT_METHOD_VALIDATION=true` | Adds the **Stripe SetupIntent flow** below to the pilot form, producing `PAYMENT_METHOD_ADDED` commitments. |

Enabling the second without the first simply records a stronger commitment type.

## The flow

```
/v/[slug]  ──► pilot form  ──► (flag on) optional "reserve with a card" step
                                    │
                                    ▼
                    POST /api/pilot/setup-intent
                    stripe.setupIntents.create({
                      usage: 'off_session',
                      payment_method_types: ['card'],
                      metadata: { campaignId, companyKey },
                    })
                                    │
                                    ▼
                   Stripe Elements confirms the SetupIntent
                                    │
                                    ▼
        webhook  setup_intent.succeeded  ──► commitments row
                                              type = PAYMENT_METHOD_ADDED
                                              verified = true
```

**A `SetupIntent` is not a charge.** It stores a payment method for future use. No
`PaymentIntent` is ever created by this system.

## What the customer must be told, verbatim and on the same screen as the card field

> **You will not be charged today.**
> This product does not exist yet. We are validating whether to build it.
> Your card will not be charged unless and until the product is available **and you
> affirmatively start the subscription**. If we do not build it, your card is never
> charged and we delete the saved payment method.

Non-negotiable rules:

- No pre-checked consent box.
- No trial that silently converts.
- No charge on any timer, on launch, or on any event other than the customer
  affirmatively subscribing.
- Cancel/remove must be one click and must work before launch.
- **There is no surprise billing anywhere in this system.** If a design choice makes a
  charge possible without a fresh affirmative action, that design is wrong.

## Refundable deposits

`DEPOSIT` exists as a commitment type for completeness. It is the strongest possible
pre-launch signal and also the highest-friction and highest-obligation one: taking money
for an unbuilt product creates a real refund obligation and, depending on jurisdiction,
consumer-protection duties. Do not enable it without deciding, in advance and in writing,
how and when refunds are issued.

## Implementation checklist, if enabled later

1. `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` (already in `.env.example`).
2. `POST /api/pilot/setup-intent` — creates the SetupIntent, returns only the client secret.
3. Stripe Elements card step on `/v/[slug]`, behind the flag, with the disclosure above.
4. `POST /api/webhooks/stripe` — verify the signature with `stripe.webhooks.constructEvent`
   against the **raw** body; on `setup_intent.succeeded`, write a `PAYMENT_METHOD_ADDED`
   commitment using the same `dedupe_key` discipline as every other commitment.
5. A deletion path that detaches the payment method, wired to the kill/archive flow so
   abandoning an opportunity also cleans up stored cards.
6. Tests: no `PaymentIntent` is ever created; the disclosure text is present whenever the
   card field renders; a replayed webhook is a no-op.

## Where the gate reads it

`MONETARY_COMMITMENT_TYPES` in `src/lib/contracts.ts` is the single definition of what
counts as monetary (`PAYMENT_METHOD_ADDED`, `DEPOSIT`). The gate's extreme-validation
branch reads that set. Nothing else needs to change.
