#!/usr/bin/env bash
# OneView watchdog: keeps the app server and its public address alive. Run every 2 minutes by launchd.
#  - starts the server if it is not answering
#  - if the public address is a Cloudflare quick tunnel and it is dead, starts a new one, publishes the
#    new URL to GitHub and rebuilds the public page (the page also re-reads api.json by itself)
#  - if MU_PUBLIC_API is set (a permanent address such as Tailscale Funnel), only the server is watched
set -uo pipefail
cd "$(dirname "$0")/.."
source ~/.zshrc >/dev/null 2>&1 || true
LOG=/tmp/mu-watchdog.log
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }
if ! curl -sf -m 5 http://127.0.0.1:8000/healthz >/dev/null; then
  nohup .venv/bin/uvicorn market_update.server:app --host 127.0.0.1 --port 8000 > /tmp/mu-server.log 2>&1 &
  log "server was down: started"; sleep 8
fi
[ -n "${MU_PUBLIC_API:-}" ] && exit 0
URL=$(cat /tmp/mu-tunnel-url.txt 2>/dev/null || true)
alive=0
if [ -n "$URL" ] && pgrep -f "cloudflared tunnel" >/dev/null; then
  host=${URL#https://}
  ip=$(dig +short @1.1.1.1 "$host" | head -1)
  if [ -n "$ip" ] && curl -sf -m 12 --resolve "$host:443:$ip" "$URL/healthz" >/dev/null; then alive=1; fi
  # cloudflared keeps retrying a tunnel Cloudflare has forgotten; that is the failure we saw
  if tail -20 /tmp/mu-tunnel.log 2>/dev/null | grep -q "Tunnel not found"; then alive=0; fi
fi
[ "$alive" = 1 ] && exit 0
log "tunnel dead ($URL): restarting"
pkill -f "cloudflared tunnel" 2>/dev/null || true; sleep 1
: > /tmp/mu-tunnel.log
nohup cloudflared tunnel --url http://localhost:8000 --no-autoupdate > /tmp/mu-tunnel.log 2>&1 &
NEW=""
for i in $(seq 1 45); do NEW=$(grep -o "https://[a-z0-9-]*\.trycloudflare\.com" /tmp/mu-tunnel.log | head -1 || true); [ -n "$NEW" ] && break; sleep 1; done
[ -n "$NEW" ] || { log "new tunnel did not come up"; exit 1; }
echo "$NEW" > /tmp/mu-tunnel-url.txt
REPO="${MU_REPO:-shayan001-cell/market-update}"
gh variable set MU_API_URL --body "$NEW" --repo "$REPO" >/dev/null 2>&1 && gh variable set MU_APP_URL --body "$NEW" --repo "$REPO" >/dev/null 2>&1 && gh workflow run build.yml --repo "$REPO" >/dev/null 2>&1
log "new tunnel $NEW published; page rebuild started"
