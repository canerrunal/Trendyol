#!/usr/bin/env bash
# =============================================================================
# Verimimari Marketplace Data Platform V2 — Mac Mini Production Continuity Setup
# Configures:
# 1. macOS power management (sleep disabled, auto-restart on power failure)
# 2. ClickHouse 26.8 LTS LaunchAgent (com.verimimari.clickhouse)
# 3. Outbox auto-recovery LaunchAgent (com.verimimari.outbox-recovery)
# 4. Cloudflare Named Tunnel LaunchAgent template (com.verimimari.cloudflared)
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"
NODE_BIN="${NODE_BIN:-$(which node)}"

CLICKHOUSE_SERVER_BIN="$PROJECT_DIR/.runtime/clickhouse_prod/usr/local/bin/clickhouse-server"
CLICKHOUSE_CONFIG="$PROJECT_DIR/.runtime/clickhouse_prod/etc/clickhouse-server/config.xml"
CLICKHOUSE_PID="$PROJECT_DIR/.runtime/clickhouse_prod/var/run/clickhouse-server/clickhouse-server.pid"

echo "============================================================================="
echo "  VERIMIMARI MAC MINI PRODUCTION CONTINUITY & LAUNCHAGENT SETUP"
echo "============================================================================="

mkdir -p "$LAUNCH_AGENTS_DIR" "$PROJECT_DIR/.runtime"

# -----------------------------------------------------------------------------
# 1. Verify / Configure macOS Power Management
# -----------------------------------------------------------------------------
echo -e "\n[1/4] Checking macOS Power Management..."
CURRENT_SLEEP=$(pmset -g | awk '/^\s*sleep\s+/ {print $2}')
CURRENT_AUTORESTART=$(pmset -g | awk '/^\s*autorestart\s+/ {print $2}')
echo "  Current sleep setting: $CURRENT_SLEEP"
echo "  Current autorestart setting: $CURRENT_AUTORESTART"

if [ "$CURRENT_AUTORESTART" != "1" ] || [ "$CURRENT_SLEEP" != "0" ]; then
  echo "  NOTE: To guarantee auto-restart after power loss and prevent sleep, run:"
  echo "  sudo pmset -a autorestart 1 womp 1 sleep 0 disksleep 0 standby 0"
  if sudo -n true 2>/dev/null; then
    echo "  Applying power settings via sudo..."
    sudo pmset -a autorestart 1 womp 1 sleep 0 disksleep 0 standby 0
    echo "  ✓ Power settings applied successfully."
  else
    echo "  (Skipping automated sudo execution; please run command above if not already set)"
  fi
else
  echo "  ✓ macOS power settings already optimal (sleep=0, autorestart=1)."
fi

# -----------------------------------------------------------------------------
# 2. ClickHouse Server 26.8 LTS LaunchAgent
# -----------------------------------------------------------------------------
echo -e "\n[2/4] Configuring ClickHouse 26.8 LTS LaunchAgent..."
CH_LABEL="com.verimimari.clickhouse"
CH_PLIST="$LAUNCH_AGENTS_DIR/$CH_LABEL.plist"

if [ -x "$CLICKHOUSE_SERVER_BIN" ] && [ -f "$CLICKHOUSE_CONFIG" ]; then
  cat <<EOF > "$CH_PLIST"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$CH_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$CLICKHOUSE_SERVER_BIN</string>
    <string>--config-file</string>
    <string>$CLICKHOUSE_CONFIG</string>
    <string>--pid-file</string>
    <string>$CLICKHOUSE_PID</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$PROJECT_DIR/.runtime/clickhouse.stdout.log</string>
  <key>StandardErrorPath</key><string>$PROJECT_DIR/.runtime/clickhouse.stderr.log</string>
</dict>
</plist>
EOF
  chmod 644 "$CH_PLIST"
  echo "  ✓ ClickHouse plist generated at: $CH_PLIST"
else
  echo "  WARNING: ClickHouse binary or config not found at expected path. Skipping plist generation."
fi

# -----------------------------------------------------------------------------
# 3. Outbox Auto-Recovery LaunchAgent
# -----------------------------------------------------------------------------
echo -e "\n[3/4] Configuring Outbox Auto-Recovery LaunchAgent..."
OUTBOX_LABEL="com.verimimari.outbox-recovery"
OUTBOX_PLIST="$LAUNCH_AGENTS_DIR/$OUTBOX_LABEL.plist"

cat <<EOF > "$OUTBOX_PLIST"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$OUTBOX_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$PROJECT_DIR/scripts/outbox_recovery_runner.cjs</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT_DIR</string>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$PROJECT_DIR/.runtime/outbox_recovery.stdout.log</string>
  <key>StandardErrorPath</key><string>$PROJECT_DIR/.runtime/outbox_recovery.stderr.log</string>
</dict>
</plist>
EOF
chmod 644 "$OUTBOX_PLIST"
echo "  ✓ Outbox recovery plist generated at: $OUTBOX_PLIST (runs every 300s)"

# -----------------------------------------------------------------------------
# 4. Cloudflare Named Tunnel LaunchAgent Template
# -----------------------------------------------------------------------------
echo -e "\n[4/4] Checking Cloudflare Tunnel (cloudflared)..."
CLOUDFLARED_BIN="$(which cloudflared 2>/dev/null || true)"
CF_LABEL="com.verimimari.cloudflared"
CF_PLIST="$LAUNCH_AGENTS_DIR/$CF_LABEL.plist"

if [ -n "$CLOUDFLARED_BIN" ]; then
  cat <<EOF > "$CF_PLIST"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$CF_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$CLOUDFLARED_BIN</string>
    <string>tunnel</string>
    <string>run</string>
    <string>verimimari-prod</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$PROJECT_DIR/.runtime/cloudflared.stdout.log</string>
  <key>StandardErrorPath</key><string>$PROJECT_DIR/.runtime/cloudflared.stderr.log</string>
</dict>
</plist>
EOF
  chmod 644 "$CF_PLIST"
  echo "  ✓ cloudflared plist generated at: $CF_PLIST"
else
  echo "  cloudflared is not currently installed in PATH."
  echo "  To install: brew install cloudflared"
  echo "  To configure named tunnel:"
  echo "    cloudflared tunnel create verimimari-prod"
  echo "    cloudflared tunnel route dns verimimari-prod ch.verimimari.com"
fi

echo -e "\n============================================================================="
echo "  PRODUCTION MAC MINI CONTINUITY SETUP COMPLETE"
echo "============================================================================="
