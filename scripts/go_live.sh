#!/usr/bin/env bash
# Put the local app behind a public HTTPS address and point the public page at it.
#   ./scripts/go_live.sh          start the server (if needed) + a Cloudflare quick tunnel, publish its URL
# The quick tunnel needs no account but gets a new random URL every time it starts; this
# script re-publishes the URL to GitHub (repository variables) and rebuilds the public page.
# For a permanent address use the Render blueprint instead (see README).
set -euo pipefail
cd "$(dirname "$0")/.."
source ~/.zshrc >/dev/null 2>&1 || true
REPO="${MU_REPO:-shayan001-cell/market-update}"
if ! curl -sf http://127.0.0.1:8000/healthz >/dev/null; then
  nohup .venv/bin/uvicorn market_update.server:app --host 127.0.0.1 --port 8000 > /tmp/mu-server.log 2>&1 &
  echo "server starting on :8000"; sleep 5
fi
pkill -f "cloudflared tunnel --url http://localhost:8000" 2>/dev/null || true
nohup cloudflared tunnel --url http://localhost:8000 --no-autoupdate > /tmp/mu-tunnel.log 2>&1 &
for i in $(seq 1 30); do URL=$(grep -o "https://[a-z0-9-]*\.trycloudflare\.com" /tmp/mu-tunnel.log | head -1 || true); [ -n "$URL" ] && break; sleep 1; done
[ -n "${URL:-}" ] || { echo "tunnel did not come up; see /tmp/mu-tunnel.log"; exit 1; }
echo "$URL" > /tmp/mu-tunnel-url.txt
echo "public app address: $URL"
gh variable set MU_API_URL --body "$URL" --repo "$REPO"
gh variable set MU_APP_URL --body "$URL" --repo "$REPO"
gh workflow run build.yml --repo "$REPO"
echo "public page rebuild started: https://shayan001-cell.github.io/market-update/ will use $URL in a few minutes"
