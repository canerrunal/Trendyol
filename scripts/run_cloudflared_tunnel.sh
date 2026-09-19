#!/usr/bin/env bash
# =============================================================================
# Verimimari Platform V2 — Cloudflare Named Tunnel Launch Wrapper
# Manages persistent cloudflared daemon execution for ch.verimimari.com
# Zero secret logging guarantee.
# =============================================================================

set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

CLOUDFLARED_BIN="$DIR/.runtime/bin/cloudflared"
if [ ! -x "$CLOUDFLARED_BIN" ]; then
  echo "[ERR] cloudflared binary not found at $CLOUDFLARED_BIN" >&2
  exit 1
fi

# Load .env if present (without echoing or logging)
if [ -f "$DIR/.env" ]; then
  set -a
  source "$DIR/.env"
  set +a
fi

METRICS_PORT="${CLOUDFLARE_METRICS_PORT:-20241}"
CLICKHOUSE_ORIGIN="${CLICKHOUSE_LOCAL_ORIGIN:-http://127.0.0.1:8123}"

echo "[INFO] Starting cloudflared tunnel daemon (Metrics: 127.0.0.1:$METRICS_PORT)..."

if [ -n "$CLOUDFLARE_TUNNEL_TOKEN" ]; then
  echo "[INFO] Running named tunnel with Cloudflare Tunnel Token..."
  exec "$CLOUDFLARED_BIN" tunnel run --token "$CLOUDFLARE_TUNNEL_TOKEN" --metrics "127.0.0.1:$METRICS_PORT"
elif [ -f "$HOME/.cloudflared/config.yml" ] || [ -f "$HOME/.cloudflared/config.yaml" ]; then
  echo "[INFO] Running named tunnel using ~/.cloudflared configuration..."
  exec "$CLOUDFLARED_BIN" tunnel run verimimari-prod --metrics "127.0.0.1:$METRICS_PORT"
else
  # Loopback tunnel forwarding to ClickHouse on 127.0.0.1:8123 with metrics server
  echo "[INFO] Running cloudflared tunnel forwarding to $CLICKHOUSE_ORIGIN..."
  exec "$CLOUDFLARED_BIN" tunnel --url "$CLICKHOUSE_ORIGIN" --metrics "127.0.0.1:$METRICS_PORT"
fi
