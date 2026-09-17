#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LABEL="com.caner.trendyol-dashboard"
SOURCE="$PROJECT_DIR/dashboard/$LABEL.plist"
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

NODE_BIN="${NODE_BIN:-$(which node)}"

mkdir -p "$PROJECT_DIR/.runtime" "$HOME/Library/LaunchAgents"
launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true

cat <<EOF > "$TARGET"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$PROJECT_DIR/dashboard/server.cjs</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>EnvironmentVariables</key>
  <dict><key>TZ</key><string>Europe/Istanbul</string><key>DASHBOARD_PORT</key><string>4317</string></dict>
  <key>StandardOutPath</key><string>$PROJECT_DIR/.runtime/dashboard.stdout.log</string>
  <key>StandardErrorPath</key><string>$PROJECT_DIR/.runtime/dashboard.stderr.log</string>
</dict>
</plist>
EOF

chmod 644 "$TARGET"
launchctl bootstrap "$DOMAIN" "$TARGET"
launchctl enable "$DOMAIN/$LABEL"
launchctl kickstart -k "$DOMAIN/$LABEL"
echo "DASHBOARD_INSTALLED http://127.0.0.1:4317"
