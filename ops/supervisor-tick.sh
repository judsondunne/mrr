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

code=$(curl -sS -o /tmp/mrr-tick.json -w '%{http_code}' \
  -X POST "http://localhost:3300/api/cron?job=supervisor" \
  -H "Authorization: Bearer ${SECRET}" \
  --max-time 780 --retry 2 --retry-delay 10 --retry-connrefused) || code=000

echo "$(date -u +%FT%TZ) supervisor tick HTTP ${code}: $(cat /tmp/mrr-tick.json 2>/dev/null)"
# A failed tick is not an incident: the next one is 15 minutes away and the
# supervisor recovers its own state. Exit 0 so launchd does not back off.
exit 0
