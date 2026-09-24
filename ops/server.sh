#!/bin/zsh
# The web + webhook server. Kept alive by launchd (com.mrr.server).
# Serves the admin dashboard, /api/cron, and the Resend webhooks.
export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/opt/postgresql@16/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd /Users/judsondunne/mrr || exit 1
exec npm run start -- -p 3300
