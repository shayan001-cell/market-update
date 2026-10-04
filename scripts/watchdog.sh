#!/usr/bin/env bash
# OneView watchdog (launchd, every 2 minutes). It never spawns long-running processes itself, because launchd
# kills a periodic job's children when the job ends. It only (1) starts the KeepAlive agents when the server or
# the tunnel is not running, and (2) publishes the tunnel's current address when it has changed.
set -uo pipefail
cd "$(dirname "$0")/.."
source ~/.zshrc >/dev/null 2>&1 || true
LOG=/tmp/mu-watchdog.log
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }
UIDN=$(id -u)
if ! curl -sf -m 5 http://127.0.0.1:8000/healthz >/dev/null; then
  launchctl load ~/Library/LaunchAgents/com.oneview.server.plist 2>/dev/null; launchctl kickstart -k "gui/$UIDN/com.oneview.server" 2>/dev/null
  log "server not answering: launchd agent started"; sleep 10
fi
# One-shot requests dropped into output/ (gitignored) by an admin or an assistant working on the folder:
#   output/.restart-server        restart the server (e.g. after a new key in .env); the file is removed
#   output/.gh-secret-NAME        set repository secret NAME to the file's contents, then delete the file
RESTARTED=""
if [ -f output/.restart-server ]; then
  rm -f output/.restart-server
  launchctl kickstart -k "gui/$UIDN/com.oneview.server" 2>/dev/null && log "restart requested: server restarted" && RESTARTED=1
fi
for f in output/.gh-secret-*; do
  [ -f "$f" ] || continue
  name="${f##*/.gh-secret-}"
  if gh secret set "$name" --repo "${MU_REPO:-shayan001-cell/market-update}" < "$f" >/dev/null 2>&1; then log "secret $name set on GitHub"; else log "secret $name: gh secret set failed"; fi
  rm -f "$f"
done
[ -n "${MU_PUBLIC_API:-}" ] && exit 0
# The permanent address (Tailscale Funnel) wins whenever it answers; the Cloudflare quick tunnel is the fallback.
REPO="${MU_REPO:-shayan001-cell/market-update}"
FUNNEL=$(cat output/tv_webhook_base.txt 2>/dev/null || true)
if [ -n "$FUNNEL" ] && curl -sf -m 10 "$FUNNEL/healthz" >/dev/null; then
  if [ "$FUNNEL" != "$(cat /tmp/mu-tunnel-url.txt 2>/dev/null || true)" ]; then
    echo "$FUNNEL" > /tmp/mu-tunnel-url.txt
    gh variable set MU_API_URL --body "$FUNNEL" --repo "$REPO" >/dev/null 2>&1 && gh variable set MU_APP_URL --body "$FUNNEL" --repo "$REPO" >/dev/null 2>&1 && gh workflow run build.yml --repo "$REPO" >/dev/null 2>&1
    log "permanent address $FUNNEL answering: published, page rebuild started"
  fi
  exit 0
fi
# The permanent address only fails here because the server behind it is down (just restarted, still starting):
# then there is nothing to switch to. Fall back to the Cloudflare tunnel only when the server itself answers.
if [ -n "$RESTARTED" ] || ! curl -sf -m 5 http://127.0.0.1:8000/healthz >/dev/null; then
  [ -n "$FUNNEL" ] && log "permanent address not answering while the server starts: address left as is"
  exit 0
fi
[ -n "$FUNNEL" ] && log "permanent address $FUNNEL not answering: falling back to the Cloudflare tunnel"
if ! pgrep -f "cloudflared tunnel" >/dev/null; then
  : > /tmp/mu-tunnel.log
  launchctl load ~/Library/LaunchAgents/com.oneview.tunnel.plist 2>/dev/null; launchctl kickstart -k "gui/$UIDN/com.oneview.tunnel" 2>/dev/null
  log "tunnel not running: launchd agent started"; sleep 15
elif tail -30 /tmp/mu-tunnel.log 2>/dev/null | grep -q "Tunnel not found"; then
  : > /tmp/mu-tunnel.log
  launchctl kickstart -k "gui/$UIDN/com.oneview.tunnel" 2>/dev/null || { pkill -f "cloudflared tunnel"; launchctl load ~/Library/LaunchAgents/com.oneview.tunnel.plist 2>/dev/null; }
  log "tunnel forgotten by Cloudflare: restarted"; sleep 15
fi
CUR=$(grep -a -o "https://[a-z0-9-]*\.trycloudflare\.com" /tmp/mu-tunnel.log | tail -1 || true)
PUB=$(cat /tmp/mu-tunnel-url.txt 2>/dev/null || true)
case "$CUR" in https://*.trycloudflare.com) ;; *) CUR="" ;; esac     # only ever publish a real tunnel address
if [ -n "$CUR" ] && [ "$CUR" != "$PUB" ]; then
  echo "$CUR" > /tmp/mu-tunnel-url.txt
  gh variable set MU_API_URL --body "$CUR" --repo "$REPO" >/dev/null 2>&1 && gh variable set MU_APP_URL --body "$CUR" --repo "$REPO" >/dev/null 2>&1 && gh workflow run build.yml --repo "$REPO" >/dev/null 2>&1
  log "tunnel address changed to $CUR: published, page rebuild started"
fi
