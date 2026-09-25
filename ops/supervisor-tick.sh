#!/bin/zsh
# One autonomous supervisor tick, fired by launchd every 15 minutes.
#
# It posts the SAME endpoint a deployed scheduler would (/api/cron?job=supervisor)
# rather than calling the job directly, so the local setup exercises the real
# production path — auth, dispatch, locking and job_runs recording included.
export PATH="/opt/homebrew/opt/node@22/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd /Users/judsondunne/mrr || exit 1

SECRET=$(grep -E '^CRON_SECRET=' .env | cut -d= -f2-)
if [ -z "$SECRET" ]; then echo "CRON_SECRET missing from .env"; exit 1; fi

# Three jobs, in this order. The supervisor alone is not enough: it has no work
# kind for the pollers, so without these the system would send at 08:00 and then
# be deaf — no delivery state, no bounce suppression, and no replies, which is
# the only thing that can actually validate anything.
#
# reconcile_delivery first so bounce/complaint suppression lands before more
# sending is considered; poll_inbound last so a reply is classified as soon as
# it arrives.
run_job() {
  local job="$1"
  local code
  code=$(curl -sS -o "/tmp/mrr-${job}.json" -w '%{http_code}' \
    -X POST "http://localhost:3300/api/cron?job=${job}" \
    -H "Authorization: Bearer ${SECRET}" \
    --max-time 780 --retry 2 --retry-delay 10 --retry-connrefused) || code=000
  echo "$(date -u +%FT%TZ) ${job} HTTP ${code}: $(cat "/tmp/mrr-${job}.json" 2>/dev/null)"
}

run_job reconcile_delivery
run_job supervisor
run_job poll_inbound
# A failed tick is not an incident: the next one is 15 minutes away and the
# supervisor recovers its own state. Exit 0 so launchd does not back off.
exit 0
