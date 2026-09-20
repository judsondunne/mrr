# MRR Validator

An autonomous machine for finding a small SaaS product that people will actually pay for —
and proving it with **real businesses**, not with research.

It runs continuously and, after setup, contacts you for essentially one reason:

> **Several real companies appear ready to use this exact product at $X/month. Here is what to build.**

---

## The principle this whole system exists to enforce

> ### RESEARCH IS NOT VALIDATION.

A competitor having customers establishes **category demand**.
It does **not** establish that customers want **our wedge**.

So nothing in this system may reach `READY_TO_BUILD` on the strength of:
AI judgement · opportunity scores · review counts · competitor revenue · market size ·
complaints · search volume · positive vibes · "strong market fit" · a reply saying "interesting".

Those things can qualify an opportunity for a **market experiment**.
They may **never** qualify it for a **build recommendation**.

A build recommendation requires **direct evidence from prospective customers of our proposed product**.

### How that is enforced mechanically

This is not a prompt instruction. It is a type-system and database constraint:

- `src/lib/state-machine.ts` defines a `GateToken` whose **constructor is not exported**.
- `READY_TO_BUILD` and `VALIDATION_STRONG` are the only states that require one.
- The **only** function that can mint a token is the deterministic gate in
  `src/pipeline/validation/gate.ts`, which reads SQL counts of **unique companies**.
- There are **zero LLM imports** anywhere under `src/pipeline/validation/` — enforced by a test
  that greps the source tree.

No amount of model output can forge a path to a build recommendation.

### What counts as validation

**Strong (counts):** prospect says they'd install/use it · explicitly accepts the monthly price ·
submits "Join pilot at $X/month" · gives their store domain for onboarding · attempts a trial ·
volunteers setup information · adds a payment method to a transparent future paid pilot ·
explicitly asks when they can start.

**Weak (never counts):** email opens · page views · "sounds interesting" · "cool idea" ·
LinkedIn likes · generic survey answers.

Opens are recorded and deliberately ignored. Clicks are secondary. Replies matter.
**Commitments matter most, counted by unique company — never by message count.**

---

## The funnel

```
DISCOVER → VERIFY EXISTING MONEY → FIND WEDGE → VERIFY PROSPECTABILITY
  → BUILD OFFER → CONTACT REAL PROSPECTS → MEASURE PURCHASE INTENT
  → KILL OR VALIDATE → NOTIFY OWNER
```

Opportunities move through exactly one state at a time. Every transition is deterministic,
audited, and rejected if it is not in the edge table:

```
DISCOVERED → CATEGORY_VERIFYING ─┬→ CATEGORY_REJECTED → ARCHIVED
                                 └→ CATEGORY_VERIFIED → WEDGE_GENERATED
   → PROSPECTING ─┬→ PROSPECTABILITY_REJECTED → ARCHIVED
                  └→ CAMPAIGN_READY → VALIDATING ─┬→ VALIDATION_FAILED → ARCHIVED
                                                  └→ VALIDATION_STRONG → READY_TO_BUILD
```

The system is designed to **kill things aggressively**. Most opportunities should die at
category verification or prospectability. That is the machine working, not failing.

---

## What you are not involved in

Researching SaaS ideas · reading app reviews · finding prospects · qualifying prospects ·
finding contact pages · writing outreach · sending outreach · tracking outreach ·
responding to basic replies · sending follow-ups · deciding whether an experiment failed ·
looking at a dashboard every day.

## When it contacts you

Only for these, and nothing else:

| Reason | Meaning |
|---|---|
| `READY_TO_BUILD` | The one you want. Multiple real companies committed at the stated price. |
| `COST_LIMIT` | A budget is spent; the affected jobs halted rather than overspend. |
| `CREDENTIAL_FAILURE` | A key stopped working. |
| `DOMAIN_FAILURE` | Sending domain/deliverability problem. |
| `SECURITY_FAILURE` | Something needs your attention. |
| `JOB_FAILURE` | One job failed 3 times in a row — **one** alert per job per day, not a stream. |

There is deliberately **no** code path that emails you "found a promising idea",
"research complete", "campaign started", "50 emails sent", or "10 people replied".
That all lives in logs and the dashboard.

---

## Quick start (no credentials needed)

```bash
npm install
npm run migrate          # local PGlite — real Postgres, no install, no account
npm run seed             # four synthetic demo scenarios
npm run job -- evaluate_campaigns
npm run dev              # open http://localhost:3000/admin/opportunities
```

Then run the research loop with nothing able to leave the machine:

```bash
npm run shadow
```

Full setup for live operation: **[SETUP.md](SETUP.md)**.

---

## Architecture

| Layer | Path | Responsibility |
|---|---|---|
| Foundation | `src/lib/` | config, db, migrations, state machine, cost ledger, providers, fetch, audit |
| Discovery | `src/pipeline/discovery/` | Shopify App Store adapter, Brave research adapter |
| Verification | `src/pipeline/verification/` | payment-evidence rules, auto-rejection rules |
| Wedge | `src/pipeline/wedge/` | complaint clustering, wedge synthesis |
| Prospecting | `src/pipeline/prospecting/` | prospect discovery, ICP qualification, public contact extraction |
| Outreach | `src/pipeline/outreach/` | send, batching, webhooks, reply classification, follow-ups, suppression |
| Validation | `src/pipeline/validation/` | **pure code.** commitment counting, campaign evaluation, the gate |
| Notify | `src/pipeline/notify/` | the six owner notifications |
| Build spec | `src/pipeline/buildspec/` | `validated/<slug>/` export |
| Jobs | `src/jobs/` | 12 idempotent scheduled jobs + locking |
| Web | `src/app/` | landing pages, admin dashboard, API routes, health, setup-check |

**Stack:** TypeScript · Next.js (App Router) · Postgres (Supabase in production,
PGlite locally) · Resend · Brave Search · Zod · Cheerio.
No Kubernetes, no Redis, no vector DB, no queue, no agent framework. Boring on purpose.

### Ecosystem extension points

Shopify is implemented end-to-end. The domain model is ecosystem-agnostic via
`OpportunitySource`, `EvidenceExtractor`, `ProspectFinder`, `MarketplaceAdapter` in
`src/lib/contracts.ts`. Atlassian, WooCommerce, HubSpot, QuickBooks/Xero and Chrome
extensions are deliberately **not** implemented — add one only after Shopify works end to end.

---

## Cost control is a product requirement

Targets: **~$20/month LLM**, **$5/month search**, free infrastructure tiers.

- Every metered call writes a `cost_ledger` row.
- `assertBudget()` runs **before** each spend and refuses the call that would cross the line.
  Nothing is ever silently overspent.
- LLM results are cached by content hash. Unchanged content is never analyzed twice.
- Search results are cached with a TTL; search is for discovery, not for every fetch.
- Two model tiers, never hard-coded at a call site:
  - `LLM_FAST` (default `claude-haiku-4-5`) — classification, extraction, qualification,
    reply triage, short personalization.
  - `LLM_REASONER` (default `claude-sonnet-5`) — complaint clustering, wedge synthesis,
    final build spec. That is the entire list.

Before any LLM call the rule is: **"Can normal code do this?"** If yes, it is normal code.
Reply rates are SQL. Threshold comparisons are `if` statements.

---

## Safety switches

| Variable | Default | Effect |
|---|---|---|
| `AUTONOMY_ENABLED` | `false` | Master switch. `false` ⇒ **shadow mode**: research and draft, never send. |
| `OUTREACH_ENABLED` | `false` | Separate switch, so research can be autonomous with zero outbound. |
| `KILL_SWITCH` | `false` | Hard stop on every job. |
| `EXTREME_VALIDATION` | `false` | Raises the gate to monetary commitments. Never enabled automatically. |
| `ENABLE_PAYMENT_METHOD_VALIDATION` | `false` | Optional Stripe SetupIntent pilot flow. Off by default. |

`getEmailProvider()` returns the **mock** provider unless `canSendRealEmail()` passes every
precondition — API key, sender identity, postal address, verified domain, signed-unsubscribe
secret, https base URL, and both switches. Shadow mode cannot send even by mistake.

---

## Commands

| Command | What it does |
|---|---|
| `npm run migrate` | Apply migrations (idempotent) |
| `npm run seed` | Seed the four demo scenarios |
| `npm run shadow` | Full research loop, nothing sent, prints drafts + costs |
| `npm run setup-check` | ✅/❌ per requirement with remediation |
| `npm run job -- <name>` | Run one job |
| `npm run job -- --all` | Run the whole pipeline |
| `npm run autonomy:enable` | Go live — refuses while any safety check fails |
| `npm run autonomy:disable` | Back to shadow mode |
| `npm run verify` | typecheck + lint + test + build |

---

## What this optimizes for

**Existing spend · recurring pain · small MVP · identifiable customers · cheap customer
contact · real purchase intent · fast path to first MRR.**

Explicitly **not**: number of ideas, TAM, virality, novelty, AI sophistication,
beautiful design, huge markets, fundraising potential.

## A claim this software will never make

It will never say **"Guaranteed MRR."** There is a code-level assertion that throws if
guarantee language reaches a notification body. The strongest claim it is permitted to make is:

> **VALIDATED — X real businesses explicitly indicated they are prepared to use this at $Y/month.**

Observed facts and predictions are kept separate, always.
