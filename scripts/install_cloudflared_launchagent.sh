#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LABEL="com.verimimari.cloudflared"
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

# Locate cloudflared binary
CLOUDFLARED_BIN=""
for candidate in \
  "$HOME/.local/bin/cloudflared" \
  "/usr/local/bin/cloudflared" \
  "/opt/homebrew/bin/cloudflared" \
  "$(which cloudflared 2>/dev/null || true)"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    CLOUDFLARED_BIN="$candidate"
    break
  fi
done

if [ -z "$CLOUDFLARED_BIN" ]; then
  echo "ERROR: cloudflared binary not found in standard locations or PATH."
  echo "Please install cloudflared or place binary in ~/.local/bin/cloudflared"
  exit 1
fi

# Retrieve tunnel token from argument, environment, or macOS Keychain
TUNNEL_TOKEN="${1:-${CLOUDFLARE_TUNNEL_TOKEN:-}}"
if [ -z "$TUNNEL_TOKEN" ]; then
  TUNNEL_TOKEN="$(security find-generic-password -s verimimari-cf-tunnel-token -w 2>/dev/null || true)"
fi

if [ -z "$TUNNEL_TOKEN" ]; then
  echo "ERROR: Cloudflare named tunnel token not found in argument, environment, or macOS Keychain ('verimimari-cf-tunnel-token')."
  echo "Run: security add-generic-password -U -s verimimari-cf-tunnel-token -a $(whoami) -w <TOKEN>"
  exit 1
fi

mkdir -p "$PROJECT_DIR/.runtime" "$HOME/Library/LaunchAgents"

# Stop existing service gracefully if active
launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
launchctl unload "$TARGET" >/dev/null 2>&1 || true

# Terminate any stray cloudflared processes to free metrics port
pkill -x cloudflared >/dev/null 2>&1 || true
sleep 1

cat <<EOF > "$TARGET"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$CLOUDFLARED_BIN</string>
    <string>tunnel</string>
    <string>--metrics</string>
    <string>127.0.0.1:20241</string>
    <string>run</string>
    <string>--token</string>
    <string>$TUNNEL_TOKEN</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>$PROJECT_DIR/.runtime/cloudflared.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$PROJECT_DIR/.runtime/cloudflared.stderr.log</string>
</dict>
</plist>
EOF

chmod 600 "$TARGET"
launchctl load "$TARGET"
echo "CLOUDFLARED_LAUNCHAGENT_INSTALLED $LABEL using $CLOUDFLARED_BIN"

