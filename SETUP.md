# SETUP

One-time setup. Budget about 30 minutes, most of it waiting for DNS.

You can explore the entire system **before** doing any of this — see
[Step 0](#step-0--try-it-with-no-credentials-2-minutes).

---

## Step 0 — Try it with no credentials (2 minutes)

```bash
npm install
npm run migrate     # local PGlite: real Postgres, no install, no account, no cost
npm run seed        # four synthetic demo scenarios
npm run job -- evaluate_campaigns
npm run dev
```

Open <http://localhost:3000/admin/opportunities> (log in with whatever you set as
`ADMIN_TOKEN`; if unset, set one first — see Step 6).

You will see four seeded opportunities. The interesting one is
**"Pickup Window Rules (demo, no demand)"**: perfect category evidence, 110 delivered
emails, zero commitments → `VALIDATION_FAILED`. That is the system's entire point.

Then:

```bash
npm run shadow      # full research loop with mock providers; nothing leaves the machine
```

---

## What you actually need

Only five external things. Everything else has a default.

| Service | Purpose | Free tier | Cost at this scale |
|---|---|---|---|
| **Supabase** | Postgres | Yes | $0 |
| **Resend** | Send + receive email | 3,000/mo, 100/day | $0 |
| **Brave Search** | Programmatic search | 2,000 queries/mo | $0 |
| **Anthropic** | LLM | No | ~$5–20/mo, hard-capped |
| **Vercel** | Hosting | Yes | $0 |

Plus a **domain you own** for sending, and an email address to be notified at.

---

## Step 1 — Database (Supabase)

1. Create a project at <https://supabase.com>. Any region. Free tier.
2. **Project Settings → Database → Connection string → URI.** Use the **Session pooler**
   string (port `5432`).
3. Put it in `.env` as `DATABASE_URL`, replacing `[YOUR-PASSWORD]` with the project password.

```bash
cp .env.example .env
# edit .env
npm run migrate
```

You should see `Applied 1 migration(s): + 0001_init.sql`.

> Leaving `DATABASE_URL` blank keeps everything on local PGlite. That is fine for shadow
> mode but you want real Postgres before going live, so state survives deploys.

---

## Step 2 — Sending domain

You need a domain you control. A subdomain is ideal — keep outreach reputation away from
your main mail.

Recommended: `send.yourdomain.com`.

---

## Step 3 — Email (Resend)

1. Sign up at <https://resend.com>.
2. **Domains → Add Domain** → enter your sending domain.
3. Add the DKIM/SPF DNS records Resend shows you. Wait for **Verified** (minutes to a few hours).
4. **API Keys → Create** with *Sending access*. Copy it once — set `RESEND_API_KEY`.

### Delivery webhook (bounces, complaints, delivery)

**Webhooks → Add Webhook**
- Endpoint: `https://YOUR_APP_URL/api/webhooks/resend`
- Events: `email.sent`, `email.delivered`, `email.bounced`, `email.complained`,
  `email.delivery_delayed`, `email.opened`, `email.clicked`
- Copy the signing secret → `RESEND_WEBHOOK_SECRET`

### Inbound webhook (replies) — this is what makes the loop autonomous

1. Add an MX record so replies route to Resend (Resend's inbound docs give the exact value).
2. Create an inbound endpoint: `https://YOUR_APP_URL/api/webhooks/resend-inbound`
3. Copy its secret → `RESEND_INBOUND_WEBHOOK_SECRET`

Without this the system can send but cannot understand replies, so it can never validate
anything. **It is not optional.**

---

## Step 4 — LLM (Anthropic)

1. Get a key at <https://console.anthropic.com> → `ANTHROPIC_API_KEY`.
2. Leave the model defaults alone unless you have a reason:
   - `LLM_FAST=claude-haiku-4-5` — the overwhelming majority of calls
   - `LLM_REASONER=claude-sonnet-5` — clustering, wedge synthesis, build spec only
3. `MONTHLY_LLM_BUDGET_USD=20` is a **hard stop**, not a warning. Jobs halt at the cap.

> Also set a spend limit in the Anthropic console as a second, independent backstop.

---

## Step 5 — Search (Brave)

1. <https://brave.com/search/api/> → free plan → `BRAVE_SEARCH_API_KEY`.
2. The free tier is 2,000 queries/month; `MONTHLY_SEARCH_BUDGET_USD=5` caps it further.
   Results are cached for a week, so repeat queries cost nothing.

---

## Step 6 — Identity, secrets and safety

Generate three secrets:

```bash
echo "ADMIN_TOKEN=$(openssl rand -hex 32)"
echo "CRON_SECRET=$(openssl rand -hex 32)"
echo "UNSUBSCRIBE_SECRET=$(openssl rand -hex 32)"
```

Then fill in your sender identity. **These are legally required in commercial email** —
outreach stays blocked until they are set:

```ini
OWNER_NAME=Your Name
OWNER_NOTIFICATION_EMAIL=you@yourdomain.com
SENDER_COMPANY=Your Company LLC
SENDER_EMAIL=you@send.yourdomain.com
SENDER_POSTAL_ADDRESS=123 Real Street, Suite 4, Your City, ST 01234, USA
SENDING_DOMAIN=send.yourdomain.com
ALLOWED_OUTREACH_COUNTRIES=US
PUBLIC_BASE_URL=https://your-app.vercel.app
```

`SENDER_POSTAL_ADDRESS` must be a real address that can receive mail. CAN-SPAM requires a
valid physical postal address in every commercial message. The system refuses to send
without one.

---

## Step 7 — Deploy (Vercel)

```bash
npm i -g vercel
vercel
```

Add every variable from your `.env` in **Project → Settings → Environment Variables**.
Then set `PUBLIC_BASE_URL` to the real deployment URL and redeploy.

Update both Resend webhook URLs to the deployed host.

---

## Step 8 — Scheduler

`.github/workflows/scheduler.yml` is included. Add two repository secrets:

- `APP_BASE_URL` — `https://your-app.vercel.app` (no trailing slash)
- `CRON_SECRET` — the same value as the deployment's

It calls `/api/cron`, so there is exactly one code path.

Vercel Cron works too — add to `vercel.json`:

```json
{ "crons": [{ "path": "/api/cron", "schedule": "10 12 * * *" }] }
```

---

## Step 9 — Verify

```bash
npm run setup-check
```

Every line must be `PASS`:

```
DATABASE · RESEND SEND · RESEND INBOUND · SEARCH · LLM
CRON · WEBHOOK · DOMAIN · OWNER NOTIFICATION · ADMIN AUTH
```

Also visit `https://YOUR_APP_URL/setup-check` (admin-protected) for the same report.

**Do not skip a FAIL.** Outreach stays blocked while any safety-critical check fails —
by design, not by convention.

---

## Step 10 — Warm up in shadow mode first

Leave `AUTONOMY_ENABLED=false` for a few days and let it research:

```bash
npm run job -- --all
```

Then read `/admin/opportunities`. Check that:

- opportunities are being **rejected** aggressively (that is correct behaviour)
- verified categories actually show real payment evidence with working URLs
- wedges are narrow and specific, not "AI-powered commerce platform"
- prospects are real businesses with a **public** evidence URL and a **public** email
- drafted emails read like something a person would send, and cite a real fact about
  that specific business

**Read at least twenty drafted emails before going live.** You are responsible for what
goes out under your name.

---

## Step 11 — Go live

```bash
npm run autonomy:enable
```

This re-runs the setup checks and refuses if any safety-critical one fails.

It then sets `AUTONOMY_ENABLED=true` and `OUTREACH_ENABLED=true` locally — set the same
two variables in Vercel and redeploy.

### What happens next

- Batch 1 = **25** emails. The system then stops and checks health.
- Hard bounce rate must be **< 5%**, complaint rate **0**, unsubscribes acceptable.
- Only then batch 2 = **50**, then up to **150** total.
- Never more than **75/day**, only inside your configured local-time window, weekdays only.
- Maximum sequence: initial + 2 follow-ups. Then it stops forever.

Then leave it alone. You should hear nothing until an opportunity passes the gate.

---

## Turning it off

```bash
npm run autonomy:disable        # back to shadow mode
```

Or set `KILL_SWITCH=true` in the deployment for an immediate hard stop on every job.

---

## Optional: monetary validation

`EXTREME_VALIDATION=true` raises the bar to require one of: 5 price-accepted pilot
reservations, 3 voluntarily supplied payment methods, or real refundable deposits.

`ENABLE_PAYMENT_METHOD_VALIDATION=true` enables a Stripe SetupIntent flow that states
plainly: **no charge today**, and the card will not be charged until the product exists and
the customer affirmatively starts the subscription. There is no surprise billing anywhere
in this system. Both are off by default and are never enabled automatically.

---

## Troubleshooting

**`npm run setup-check` says DATABASE fail** — wrong connection string. Use the *Session
pooler* URI, port 5432, and replace `[YOUR-PASSWORD]`.

**Emails send but replies never arrive** — the MX record or the inbound webhook is missing.
Without inbound, validation is impossible; check `RESEND_INBOUND_WEBHOOK_SECRET`.

**Everything gets rejected** — that is usually correct. Check `/admin/opportunities/<id>`
for the recorded `rejection_reason`. Most categories genuinely lack proof that anyone pays.

**Nothing reaches READY_TO_BUILD** — open the opportunity page and read
**"WHY THIS IS NOT READY"**. It lists every unmet gate check with actual-vs-required numbers.

**Budget halted a job** — expected at the cap. Raise `MONTHLY_LLM_BUDGET_USD` or wait for
the next period. It will not silently overspend.

**Bounce rate too high after batch 1** — prospect quality is the usual cause. The campaign
halts itself. Look at `/admin/campaigns/<id>`.
