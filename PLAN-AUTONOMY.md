# Autonomy Plan — from "runs when told" to "runs itself"

This extends the existing system. It does not replace it. Everything already
working (deterministic gate, unique-company counting, Shopify discovery,
prospecting, Resend in/out, landing pages, reply classification, shadow mode,
cost ledger, build spec, notifications, 370 tests) is preserved.

## Verified starting point

Confirmed present: `src/pipeline/{discovery,verification,wedge,prospecting,outreach,validation,notify,buildspec}`,
`src/jobs/{registry,runner,lock}`, `src/lib/**`, `migrations/0001_init.sql`, 19 test files.

Confirmed **absent** (grep over `src/` and `migrations/` returned zero):
supervisor · watchdog · dead-letter · bandit/Thompson · `strategy_*` tables ·
prompt versioning · injection defenses · company cooldown · domain warm-up ·
price experiments · `AUTO_START` · runtime state · source registry.

So this phase is additive. The only existing files that change are the ones
that must (config, llm types, send ramp, job registry).

## The two planes

```
┌─ IMMUTABLE CONTROL PLANE ────────── typed code + env. No AI write path. ─┐
│ gate thresholds · unique-company rule · strong-commitment definition      │
│ cost ceilings · daily email ceiling · allowed countries · max follow-ups  │
│ suppression + opt-out · bounce/complaint pause · auth + secrets           │
│ no-fabricated-evidence · no-pretending-product-exists                     │
└──────────────────────────────────────────────────────────────────────────┘
┌─ ADAPTIVE STRATEGY PLANE ───────── DB rows inside constrained schemas. ───┐
│ categories · queries · ecosystems · ICPs · qualification heuristics       │
│ positioning · price hypotheses · landing + email copy · contact role      │
│ send-time bucket · follow-up wording/timing · explore-vs-exploit          │
└──────────────────────────────────────────────────────────────────────────┘
```

Enforcement is mechanical, not conventional:
- `src/autonomy/guard.ts` exposes the **only** write path into strategy tables,
  and it rejects any mutation touching a control-plane field.
- `tests/unit/architecture.test.ts` (already enforcing gate invariants) gains
  checks that no module under `src/autonomy/` imports the gate's mint function,
  writes `opportunities.state` directly, or widens a budget.

## New layer: `src/autonomy/`

| Module | Responsibility |
|---|---|
| `runtime.ts` | global runtime state machine + persistence + audited transitions |
| `autostart.ts` | readiness probe → RUNNING, or BLOCKED_CONFIGURATION with one actionable notice |
| `supervisor.ts` | the brain: inspect state, rank work, enqueue idempotently |
| `priority.ts` | the 7-level priority order; interested prospects beat discovery |
| `queue.ts` | durable work queue with attempts/backoff/dead-letter |
| `watchdog.ts` | subsystem heartbeats, staleness detection, self-recovery |
| `budget.ts` | per-phase sub-budgets + expected-information-value ranking |
| `strategy/store.ts` | versioned hypotheses, outcomes, immutable history |
| `strategy/bandit.ts` | Beta-Bernoulli Thompson sampling + min-sample guards |
| `strategy/memory.ts` | failure memory (similarity-rejected) + success patterns |
| `strategy/propose.ts` | LLM proposes; deterministic eligibility gate admits |
| `discovery/queries.ts` | query-family expansion scored by downstream validation |
| `discovery/sources.ts` | source registry, UNVERIFIED → VERIFIED promotion |
| `deliverability.ts` | domain warm-up + per-campaign ramp 10/25/50/75 |
| `company.ts` | cross-campaign company identity + 90-day fatigue cooldown |
| `injection.ts` | untrusted-content fencing for every external string |
| `calibration.ts` | classifier accuracy against frozen fixtures; blocks regressions |

## Runtime states

```
BOOTING → SELF_TESTING → SHADOW_VERIFYING → RUNNING
                              ↓                ↕
                    BLOCKED_CONFIGURATION   DEGRADED
                                             ↕   ↕
                          PAUSED_BUDGET ─────┘   └───── PAUSED_DELIVERABILITY
                                        EMERGENCY_STOP
```

Persisted in `runtime_state`, every transition audited. `BLOCKED_CONFIGURATION`
resolves itself: when the missing dependency becomes healthy the watchdog
promotes to RUNNING with no owner command.

## Learning loop

```
experiment → strategy_outcomes (input strategy + measured results)
    ↓
bandit posteriors per arm (Beta over downstream commitment events, not opens)
    ↓
allocation: exploit best arms, reserve EXPLORATION_RATIO for new hypotheses
    ↓
failure memory blocks near-identical retries; success patterns bias discovery
```

Reward is **downstream only**, weighted:
strong commitment > price acceptance > pilot signup > strong reply > qualified reply.
Opens are never a reward signal. A minimum sample size gates any "X beats Y"
conclusion; below it the arm stays in exploration.

## Cost intelligence

Global `MONTHLY_LLM_BUDGET_USD` stays a hard ceiling. Inside it, five
sub-budgets — DISCOVERY, RESEARCH, PROSPECTING, REPLY, FINAL_ANALYSIS — which
may borrow from each other but never exceed the global cap. Research runs in
five escalating stages so expensive models only ever see finalists.

## Simulation (the proof)

`npm run simulate` runs accelerated weeks against deterministic fixtures:
50 bad ideas, 10 decent categories, 5 campaigns, injected failures, one true
winner. It asserts bad ideas die, budget holds, cooldowns hold, strategy
allocation shifts toward what actually commits, exploration continues, the
immutable gate is never touched, and **only the true winner notifies the owner**.

## Phasing

1. **Foundation (Lead, sequential):** migration 0002, config, LLM prompt
   versioning + fallback, `src/autonomy/types.ts`, declare-only contracts.
2. **Parallel fan-out (isolated worktrees, disjoint ownership):**
   A runtime/watchdog/DLQ · B supervisor/priority/budget · C strategy/bandit/memory ·
   D discovery/queries/sources/staging · E deliverability/company/price/reply ·
   F provenance/staleness/feasibility/buildspec/two-tier validation ·
   G injection/calibration.
3. **Integration (Lead):** merge, wire supervisor into the scheduler, chaos
   tests, end-to-end simulation, full verify.


## Simulation status (honest)

`npm run simulate -- --days 45 --ticks 10` currently passes **10 of 14**
assertions. What it proves today:

- all 50 bad ideas die, via the real staged-research ladder, at the cheap
  stages — no reasoner spend on any of them
- the hard LLM budget ceiling holds ($1.51 of $20 over 45 simulated days)
- the daily email ceiling holds
- no company is emailed after `NEVER_CONTACT`
- follow-ups never exceed the configured cap
- **the immutable gate thresholds and limits are byte-identical before and
  after the run** — 450 supervisor ticks of autonomous operation changed
  nothing in the control plane
- injected prompt-injection payloads never altered behaviour
- every injected provider outage self-recovered with zero owner alerts

The four unmet assertions all depend on the simulated WINNER completing
validation, and it currently does not: the synthetic fixture keeps tripping
production's auto-rejection rules, which are keyword-based and tuned for real
marketplace copy. That is a fidelity limitation of the harness, not a gap in
the pipeline — and the winner path is covered elsewhere and passing:

- `tests/integration/ready-to-build.test.ts` walks the exact state progression
  to READY_TO_BUILD and asserts the notification and the build-spec export
- `npm run seed && npm run job -- evaluate_campaigns` reaches READY_TO_BUILD on
  the `strong-validated` fixture, emits the owner email, and writes
  `validated/<slug>/`

To finish the simulation properly, the fixture needs listing/description text
realistic enough to satisfy the rejection rules, or those rules need a
test-only injection seam. Worth doing; not worth blocking on.

## Real defects the simulation found

These were invisible to unit tests, which is the argument for having it:

1. **Pipeline livelock.** Eliminated candidates stayed in `DISCOVERED` because
   `DISCOVERED -> CATEGORY_REJECTED` is not a legal edge, so they re-consumed a
   research slot every tick and starved every live candidate. The pipeline
   processed three ideas and froze.
2. **Deep-research ceiling measured a permanent property.** It counted every
   opportunity that had *ever* reached stage 3, so after three candidates
   passed it, research halted forever.
3. **Staged research re-filtered verified categories** and could overturn a
   completed HIGH-confidence verdict with a cheap stage-2 classification.
4. **`RESEARCH_STAGE` was wired to the old whole-job path**, so staging never
   ran and its cost saving never materialised.
