# MRR Validator — Architecture & Implementation Plan

## What this is

An autonomous **validation machine**. It finds small SaaS categories where businesses
*already pay*, invents a narrow wedge, finds and emails real qualified prospects, measures
**direct purchase intent**, kills failures, and contacts the owner **only** when multiple
real companies have given concrete evidence they will pay $X/month for a specifically
described product.

It is **not** an idea generator, not a dashboard, and not a product-building machine.

## The absolute principle (encoded in code, not prompts)

> RESEARCH IS NOT VALIDATION.

A competitor having customers establishes **category demand**. It does **not** establish
that customers want **our wedge**. Therefore no LLM call, score, or heuristic may move an
opportunity to `READY_TO_BUILD`. Only `src/pipeline/validation/gate.ts` — pure,
deterministic, unit-tested TypeScript reading counts of **unique companies** out of
Postgres — may do that.

## Funnel

```
DISCOVER → VERIFY EXISTING MONEY → FIND WEDGE → VERIFY PROSPECTABILITY
  → BUILD OFFER → CONTACT REAL PROSPECTS → MEASURE PURCHASE INTENT
  → KILL OR VALIDATE → NOTIFY OWNER
```

## State machine

```
DISCOVERED ─► CATEGORY_VERIFYING ─┬─► CATEGORY_REJECTED ─► ARCHIVED
                                  └─► CATEGORY_VERIFIED ─► WEDGE_GENERATED
                                        ─► PROSPECTING ─┬─► PROSPECTABILITY_REJECTED ─► ARCHIVED
                                                        └─► CAMPAIGN_READY ─► VALIDATING
                                        VALIDATING ─┬─► VALIDATION_FAILED ─► ARCHIVED
                                                    └─► VALIDATION_STRONG ─► READY_TO_BUILD
```

Every transition goes through `assertTransition()` in `src/lib/state-machine.ts`, is
written to `audit_events`, and is rejected if not in the allowed-edge table.
`READY_TO_BUILD` has exactly **one** legal caller, enforced by a transition reason token.

## Layering (ownership boundaries)

| Layer | Path | Responsibility |
|---|---|---|
| Foundation | `src/lib/**` | config, db, migrations runner, state machine, cost ledger, LLM providers, search, fetch, logging, crypto, contracts |
| Discovery | `src/pipeline/discovery/**` | Shopify adapter, Brave research adapter, source docs |
| Verification | `src/pipeline/verification/**` | payment-evidence rules, auto-rejection rules |
| Wedge | `src/pipeline/wedge/**` | complaint clustering, wedge synthesis |
| Prospecting | `src/pipeline/prospecting/**` | prospect discovery, ICP qualification, public contact extraction |
| Outreach | `src/pipeline/outreach/**` | Resend send, batching, webhooks, inbound parse, reply classify, follow-ups, suppression |
| Validation | `src/pipeline/validation/**` | commitment counting, campaign evaluation, READY_TO_BUILD gate |
| Notify | `src/pipeline/notify/**` | owner notifications (4 reasons only) |
| Build spec | `src/pipeline/buildspec/**` | `validated/[slug]/` export |
| Jobs | `src/jobs/**` | 12 idempotent scheduled jobs + advisory locking |
| Web | `src/app/**` | landing pages `/v/[slug]`, admin dashboard, API routes, `/health`, `/setup-check` |

Cross-layer calls go **downward only**. `src/lib/contracts.ts` holds the shared types so
layers compile independently.

## Data flow (vertical slice)

1. `discover_opportunities` → Shopify App Store category crawl → `source_documents` (hashed)
   → `opportunities` (DISCOVERED) + `competitors`.
2. `verify_categories` → deterministic extraction of pricing/reviews → payment-evidence
   scoring (`HIGH`/`MEDIUM`/`LOW`) + auto-rejection rule set → CATEGORY_VERIFIED / REJECTED.
3. `generate_wedges` → deterministic complaint tagging, then **reasoner** LLM to cluster +
   synthesize one narrow wedge → WEDGE_GENERATED.
4. `discover_prospects` + `qualify_prospects` → Brave search + direct site fetch → real
   businesses with **public** evidence URL + **public** business email → ≥100 qualified or
   PROSPECTABILITY_REJECTED.
5. `prepare_campaigns` → landing page slug + honest offer copy → CAMPAIGN_READY.
6. `send_due_messages` → batch 25 → health check → 50 → up to 150. Never exceeds
   `MAX_EMAILS_PER_DAY`. Idempotent via `messages.idempotency_key` unique index.
7. Resend webhook → delivery/bounce/complaint events; inbound webhook → reply → classify →
   extract commitments → maybe auto-reply (bounded, truthful) → maybe follow-up (max 2).
8. Landing page form POST → `PILOT_SIGNUP` + `EXPLICIT_PRICE_ACCEPTANCE` commitments.
9. `evaluate_campaigns` → **pure code** gate → VALIDATION_FAILED or READY_TO_BUILD.
10. `notify_validated_opportunities` → the single email the owner ever wants + `validated/[slug]/`.

## Cost control

- `cost_ledger` rows for every LLM call, search call, and email.
- `assertBudget()` is called **before** each metered operation; over budget ⇒ throws
  `BudgetExceededError`, job halts, `COST_LIMIT` owner notification fires once per period.
- LLM responses cached by `sha256(model + prompt + schema)` in `llm_cache` — unchanged
  content is never re-analyzed.
- Brave results cached by `sha256(query)` with TTL.
- Provider indirection: `LLM_FAST` (default `claude-haiku-4-5`) for classification /
  extraction / short personalization; `LLM_REASONER` (default `claude-sonnet-5`) only for
  complaint clustering, wedge synthesis, and final build spec. Never hard-coded at call sites.
- A `MockLLMProvider` + `MockSearchProvider` + `MockEmailProvider` make **shadow mode run
  with zero credentials**.

## Safety switches

| Env | Default | Effect |
|---|---|---|
| `AUTONOMY_ENABLED` | `false` | Master switch. False ⇒ SHADOW MODE: discover/research/prospect/draft, never send. |
| `OUTREACH_ENABLED` | `false` | Separate switch — allows research autonomy without any outbound. |
| `ENABLE_PAYMENT_METHOD_VALIDATION` | `false` | Optional Stripe SetupIntent flow (designed, off by default). |
| `EXTREME_VALIDATION` | `false` | Raises the gate to monetary-commitment thresholds. |
| `KILL_SWITCH` | `false` | Hard stop on every job. |

Both `AUTONOMY_ENABLED` **and** `OUTREACH_ENABLED` must be true *and* `/setup-check` must
be all-green before a single real email leaves the system.

## Database

Postgres. One dialect, two runtimes:
- **Production**: Supabase via `DATABASE_URL` (postgres.js).
- **Shadow/local/test**: PGlite (real Postgres compiled to WASM) — zero install, zero
  credentials, **identical SQL and identical migrations**.

Migrations are plain numbered `.sql` files in `migrations/`, applied in order, tracked in
`schema_migrations`. No ORM.

## Testing

- Unit: state transitions, validation gate, suppression, dedup, budget limits, reply
  classification, commitment counting, campaign evaluation, follow-up eligibility, cost
  accounting, email compliance.
- Integration (against real PGlite): Resend webhook, fake inbound reply, campaign state
  transition, landing page signup, fake qualifying opportunity, READY_TO_BUILD notification.
- Fixtures: `failed-idea`, `good-research-no-demand`, `weak-replies`, `strong-validated`.
  The strong fixture walks the **exact** state progression to READY_TO_BUILD.

## Implementation phases

1. **Foundation** (sequential, no parallelism — it is the coupling point): config, db,
   migrations, state machine, cost ledger, LLM/search/email providers, contracts, logging.
2. **Parallel fan-out** (isolated git worktrees, disjoint directory ownership):
   A) discovery+verification · B) wedge+prospecting · C) outreach ·
   D) validation+notify+buildspec · E) web UI + API routes.
3. **Integration** (Lead): merge, wire `src/jobs/**`, run full verify, end-to-end shadow run.
