# Running this locally, permanently

Two launchd agents keep the system alive on this Mac. Nothing needs a deploy.

| agent | what it does | interval |
| --- | --- | --- |
| `com.mrr.server` | `next start -p 3300` — admin dashboard, `/api/cron`, Resend webhooks | kept alive |
| `com.mrr.supervisor` | POSTs `/api/cron?job=supervisor` | every 15 min |

The tick deliberately goes through the HTTP endpoint rather than calling the
job directly, so the local setup exercises the same path a deployed scheduler
would: bearer auth, dispatch, job locking and `job_runs` recording.

## Control

```bash
launchctl list | grep com.mrr                     # is it running?
tail -f ops/supervisor.log                        # what the scheduler is doing
tail -f ops/server.log                            # what the server is doing
launchctl unload ~/Library/LaunchAgents/com.mrr.supervisor.plist   # pause autonomy
launchctl load   ~/Library/LaunchAgents/com.mrr.supervisor.plist   # resume
```

The kill switch is in `.env`: `KILL_SWITCH=true` stops all outbound work at the
next tick without unloading anything.

## Database

Real Postgres (`brew services start postgresql@16`, database `mrr`), not PGlite.
PGlite allows one process at a time, so the server and the scheduler could not
both hold it — whichever started first won and the other reported `locked`.

## Health

```bash
npm run providers:health   # one real call per provider
npm run canary:email       # real round trip to OWNER_TEST_EMAIL
npm run canary:research    # live research against the public web
```
