#!/usr/bin/env bash
# =============================================================================
# Verimimari Marketplace Data Platform V2 — Fresh Mac Bootstrap System
# Single-command turnkey provisioning for secondary or replacement macOS machines.
#
# Usage:
#   git clone <repo>
#   cd Trendyol
#   bash scripts/bootstrap_new_mac.sh
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_DIR="$PROJECT_DIR/.runtime"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"

echo "============================================================================="
echo "  VERIMIMARI PLATFORM V2 — FRESH MAC BOOTSTRAP SYSTEM"
echo "  Target Directory: $PROJECT_DIR"
echo "============================================================================="

# -----------------------------------------------------------------------------
# 1. macOS & Architecture Check
# -----------------------------------------------------------------------------
echo -e "\n[1/10] Verifying Operating System & Architecture..."
OS="$(uname -s)"
ARCH="$(uname -m)"

if [ "$OS" != "Darwin" ]; then
  echo "❌ ERROR: This bootstrap script requires macOS (Darwin). Detected: $OS"
  exit 1
fi
echo "  ✓ macOS detected ($ARCH architecture)."

# -----------------------------------------------------------------------------
# 2. Node.js 24 LTS Verification & Setup
# -----------------------------------------------------------------------------
echo -e "\n[2/10] Verifying Node.js 24 LTS..."
NODE_BIN="$(which node 2>/dev/null || true)"
NODE_VER=""

if [ -n "$NODE_BIN" ]; then
  NODE_VER="$($NODE_BIN -v 2>/dev/null || true)"
fi

NEED_NODE_INSTALL=0
if [ -z "$NODE_VER" ]; then
  NEED_NODE_INSTALL=1
else
  NODE_MAJOR="$(echo "$NODE_VER" | sed 's/^v//' | cut -d. -f1)"
  if [ "$NODE_MAJOR" -lt 24 ]; then
    echo "  Current Node.js version $NODE_VER is below required 24.x LTS."
    NEED_NODE_INSTALL=1
  fi
fi

if [ "$NEED_NODE_INSTALL" -eq 1 ]; then
  echo "  Attempting to resolve Node.js 24 via NVM or Homebrew..."
  # Try loading nvm if present
  export NVM_DIR="$HOME/.nvm"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh"
    nvm install 24
    nvm use 24
    NODE_BIN="$(which node)"
  elif command -v brew >/dev/null 2>&1; then
    echo "  Installing node@24 via Homebrew..."
    brew install node@24
    brew link --overwrite --force node@24 2>/dev/null || true
    NODE_BIN="$(brew --prefix node@24)/bin/node"
  else
    echo "❌ ERROR: Node.js 24+ is required. Please install via: https://nodejs.org or 'nvm install 24'"
    exit 1
  fi
fi

NODE_BIN="$(which node)"
echo "  ✓ Node.js ready: $("$NODE_BIN" -v) ($NODE_BIN)"

# -----------------------------------------------------------------------------
# 3. Dependencies Installation (npm ci)
# -----------------------------------------------------------------------------
echo -e "\n[3/10] Installing Node.js project dependencies..."
cd "$PROJECT_DIR"
if [ -f "package-lock.json" ]; then
  npm ci
else
  npm install
fi
echo "  ✓ Dependencies installed successfully."

# -----------------------------------------------------------------------------
# 4. Cloudflare Named Tunnel (cloudflared) Check
# -----------------------------------------------------------------------------
echo -e "\n[4/10] Checking cloudflared binary..."
CLOUDFLARED_BIN="$(which cloudflared 2>/dev/null || true)"
if [ -z "$CLOUDFLARED_BIN" ]; then
  if command -v brew >/dev/null 2>&1; then
    echo "  cloudflared not found. Installing via Homebrew..."
    brew install cloudflared || true
    CLOUDFLARED_BIN="$(which cloudflared 2>/dev/null || true)"
  fi
fi

if [ -n "$CLOUDFLARED_BIN" ]; then
  echo "  ✓ cloudflared ready: $CLOUDFLARED_BIN ($($CLOUDFLARED_BIN --version | head -n1))"
else
  echo "  ⚠️ cloudflared not found. Local operation will work; tunnel setup can be installed later via 'brew install cloudflared'."
fi

# -----------------------------------------------------------------------------
# 5. Runtime Directory Structure & Permissions
# -----------------------------------------------------------------------------
echo -e "\n[5/10] Initializing runtime directories & permissions..."
mkdir -p \
  "$RUNTIME_DIR" \
  "$RUNTIME_DIR/bin" \
  "$RUNTIME_DIR/clickhouse_prod/data" \
  "$RUNTIME_DIR/clickhouse_prod/tmp" \
  "$RUNTIME_DIR/clickhouse_prod/user_files" \
  "$RUNTIME_DIR/clickhouse_prod/format_schemas" \
  "$RUNTIME_DIR/clickhouse_prod/logs" \
  "$RUNTIME_DIR/clickhouse_prod/etc/clickhouse-server/config.d" \
  "$RUNTIME_DIR/clickhouse_prod/etc/clickhouse-server/users.d" \
  "$RUNTIME_DIR/clickhouse_prod/var/lib/clickhouse" \
  "$RUNTIME_DIR/clickhouse_prod/var/log/clickhouse-server" \
  "$RUNTIME_DIR/clickhouse_prod/var/run/clickhouse-server" \
  "$RUNTIME_DIR/clickhouse_outbox/dead_letter" \
  "$RUNTIME_DIR/backup_staging" \
  "$LAUNCH_AGENTS_DIR"

chmod 700 "$RUNTIME_DIR"
chmod 700 "$RUNTIME_DIR/clickhouse_outbox"
echo "  ✓ Runtime directory hierarchy provisioned with restricted permissions."

# -----------------------------------------------------------------------------
# 6. ClickHouse 26.8 LTS Binary Resolution & Configuration
# -----------------------------------------------------------------------------
echo -e "\n[6/10] Resolving ClickHouse 26.8 LTS binary & configs..."
CH_BIN=""
for candidate in \
  "$PROJECT_DIR/.runtime/clickhouse_prod/usr/local/bin/clickhouse-server" \
  "$PROJECT_DIR/.runtime/bin/clickhouse" \
  "$(which clickhouse-server 2>/dev/null || true)" \
  "$(which clickhouse 2>/dev/null || true)" \
  "/usr/local/bin/clickhouse" \
  "/opt/homebrew/bin/clickhouse"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    CH_BIN="$candidate"
    break
  fi
done

if [ -z "$CH_BIN" ]; then
  echo "  ClickHouse binary not found locally. Downloading official ClickHouse binary..."
  mkdir -p "$RUNTIME_DIR/bin"
  (cd "$RUNTIME_DIR/bin" && curl -s https://clickhouse.com/ | sh)
  CH_BIN="$RUNTIME_DIR/bin/clickhouse"
fi

echo "  ✓ ClickHouse binary located: $CH_BIN"

# Deploy templates from ops/clickhouse/
CH_ETC="$RUNTIME_DIR/clickhouse_prod/etc/clickhouse-server"
CH_PROD_DIR="$RUNTIME_DIR/clickhouse_prod"

cp "$PROJECT_DIR/ops/clickhouse/config.xml" "$CH_ETC/config.xml"
cp "$PROJECT_DIR/ops/clickhouse/users.xml" "$CH_ETC/users.xml"

# Replace template placeholders
for f in "$PROJECT_DIR/ops/clickhouse/config.d/"*.xml; do
  dest="$CH_ETC/config.d/$(basename "$f")"
  sed \
    -e "s|{{CLICKHOUSE_DIR}}|$CH_PROD_DIR|g" \
    -e "s|{{WORKSPACE_ROOT}}|$PROJECT_DIR|g" \
    "$f" > "$dest"
done

# Ensure single binary symlinks for clickhouse-server if needed
mkdir -p "$CH_PROD_DIR/usr/local/bin"
if [ ! -f "$CH_PROD_DIR/usr/local/bin/clickhouse-server" ]; then
  ln -sf "$CH_BIN" "$CH_PROD_DIR/usr/local/bin/clickhouse-server"
  ln -sf "$CH_BIN" "$CH_PROD_DIR/usr/local/bin/clickhouse-client"
  ln -sf "$CH_BIN" "$CH_PROD_DIR/usr/local/bin/clickhouse"
fi

CH_SERVER_EXEC="$CH_PROD_DIR/usr/local/bin/clickhouse-server"
echo "  ✓ ClickHouse configuration rendered to $CH_ETC."

# -----------------------------------------------------------------------------
# 7. Start ClickHouse & Verify HTTP Interface
# -----------------------------------------------------------------------------
echo -e "\n[7/10] Starting ClickHouse Server & verifying ping..."
CH_PID_FILE="$CH_PROD_DIR/var/run/clickhouse-server/clickhouse-server.pid"

IS_RUNNING=0
if curl -s -m 2 http://127.0.0.1:8123/ping | grep -q "Ok."; then
  IS_RUNNING=1
  echo "  ✓ ClickHouse server already running and healthy on port 8123."
fi

if [ "$IS_RUNNING" -eq 0 ]; then
  echo "  Starting ClickHouse server daemon..."
  "$CH_SERVER_EXEC" \
    --config-file="$CH_ETC/config.xml" \
    --pid-file="$CH_PID_FILE" \
    --daemon

  echo "  Waiting for ClickHouse to accept connections on port 8123..."
  for i in $(seq 1 20); do
    if curl -s -m 1 http://127.0.0.1:8123/ping | grep -q "Ok."; then
      IS_RUNNING=1
      echo "  ✓ ClickHouse server started successfully."
      break
    fi
    sleep 1
  done

  if [ "$IS_RUNNING" -eq 0 ]; then
    echo "❌ ERROR: ClickHouse server failed to start within 20 seconds."
    echo "  Check log: $RUNTIME_DIR/clickhouse_prod/var/log/clickhouse-server/clickhouse-server.err.log"
    exit 1
  fi
fi

# -----------------------------------------------------------------------------
# 8. Schema & RBAC Initialization
# -----------------------------------------------------------------------------
echo -e "\n[8/10] Applying ClickHouse schema & RBAC policies..."
# Function to execute SQL file cleanly
execute_sql_file() {
  local sql_file="$1"
  local ch_client="$CH_PROD_DIR/usr/local/bin/clickhouse-client"
  if [ -x "$ch_client" ]; then
    "$ch_client" --multiquery --queries-file="$sql_file"
  elif command -v clickhouse-client >/dev/null 2>&1; then
    clickhouse-client --multiquery --queries-file="$sql_file"
  else
    # Fallback to executing via node runner statement by statement
    node -e "
      const fs = require('fs');
      const { execFileSync } = require('child_process');
      const sql = fs.readFileSync(process.argv[1], 'utf8');
      const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 0 && !s.startsWith('--'));
      for (const stmt of statements) {
        try {
          execFileSync('curl', ['-s', '-S', '--fail-with-body', '-d', stmt, 'http://127.0.0.1:8123/'], { encoding: 'utf8' });
        } catch (e) {
          if (!stmt.includes('IF NOT EXISTS')) throw e;
        }
      }
    " "$sql_file"
  fi
}

curl -s -S --fail-with-body -d "CREATE DATABASE IF NOT EXISTS verimimari_prod" http://127.0.0.1:8123/

# Apply production tables schema
echo "  Applying scripts/sql/clickhouse_prod_schema.sql..."
execute_sql_file "$PROJECT_DIR/scripts/sql/clickhouse_prod_schema.sql"

# Apply RBAC roles
echo "  Applying scripts/sql/clickhouse_prod_rbac.sql..."
execute_sql_file "$PROJECT_DIR/scripts/sql/clickhouse_prod_rbac.sql"

# Verify 4 production tables
TABLES_FOUND="$(curl -s -d "SELECT count() FROM system.tables WHERE database = 'verimimari_prod' AND name IN ('product_observations', 'category_rank_observations', 'profile_observations', 'inventory_observations')" http://127.0.0.1:8123/ | tr -d '[:space:]')"

if [ "$TABLES_FOUND" -ne 4 ]; then
  echo "❌ ERROR: Expected 4 production tables in verimimari_prod, found: $TABLES_FOUND"
  exit 1
fi
echo "  ✓ All 4 production tables confirmed in verimimari_prod."

# -----------------------------------------------------------------------------
# 9. LaunchAgent Service Templates Deployment
# -----------------------------------------------------------------------------
echo -e "\n[9/10] Deploying macOS LaunchAgent service definitions..."

# 9a. ClickHouse LaunchAgent
CH_PLIST="$LAUNCH_AGENTS_DIR/com.verimimari.clickhouse.plist"
sed \
  -e "s|{{CLICKHOUSE_SERVER_BIN}}|$CH_SERVER_EXEC|g" \
  -e "s|{{WORKSPACE_ROOT}}|$PROJECT_DIR|g" \
  "$PROJECT_DIR/ops/launchd/com.verimimari.clickhouse.plist.template" > "$CH_PLIST"
chmod 644 "$CH_PLIST"
echo "  ✓ Configured: $CH_PLIST"

# 9b. Outbox Auto-Recovery LaunchAgent
OUTBOX_PLIST="$LAUNCH_AGENTS_DIR/com.verimimari.outbox-recovery.plist"
sed \
  -e "s|{{NODE_BIN}}|$NODE_BIN|g" \
  -e "s|{{WORKSPACE_ROOT}}|$PROJECT_DIR|g" \
  "$PROJECT_DIR/ops/launchd/com.verimimari.outbox-recovery.plist.template" > "$OUTBOX_PLIST"
chmod 644 "$OUTBOX_PLIST"
echo "  ✓ Configured: $OUTBOX_PLIST"

# 9c. Cloudflare Tunnel LaunchAgent (if token exists in Keychain)
CF_TOKEN="$(security find-generic-password -s "verimimari-cf-tunnel-token" -w 2>/dev/null || true)"
if [ -n "$CLOUDFLARED_BIN" ] && [ -n "$CF_TOKEN" ]; then
  CF_PLIST="$LAUNCH_AGENTS_DIR/com.verimimari.cloudflared.plist"
  sed \
    -e "s|{{CLOUDFLARED_BIN}}|$CLOUDFLARED_BIN|g" \
    -e "s|{{CLOUDFLARED_TOKEN}}|$CF_TOKEN|g" \
    -e "s|{{WORKSPACE_ROOT}}|$PROJECT_DIR|g" \
    "$PROJECT_DIR/ops/launchd/com.verimimari.cloudflared.plist.template" > "$CF_PLIST"
  chmod 644 "$CF_PLIST"
  echo "  ✓ Configured: $CF_PLIST"
fi

# Sync immutable manifests to runtime if needed
mkdir -p "$RUNTIME_DIR"
for m in stage_2_10pct.json stage_3_25pct.json stage_4_50pct.json stage_5_100pct.json; do
  if [ -f "$PROJECT_DIR/ops/manifests/$m" ] && [ ! -f "$RUNTIME_DIR/$m" ]; then
    cp "$PROJECT_DIR/ops/manifests/$m" "$RUNTIME_DIR/$m"
  fi
done
echo "  ✓ Manifests verified and synchronized."

# -----------------------------------------------------------------------------
# 10. Secrets Verification & Next Steps Handoff
# -----------------------------------------------------------------------------
echo -e "\n[10/10] Checking operational secrets in macOS Keychain..."
HAS_BACKUP_KEY=0
if security find-generic-password -s "verimimari-backup-key" >/dev/null 2>&1 || [ -f "$RUNTIME_DIR/backup_encryption.key" ]; then
  HAS_BACKUP_KEY=1
fi

HAS_CF_ACCESS=0
if security find-generic-password -s "verimimari-cf-access-client-id" >/dev/null 2>&1; then
  HAS_CF_ACCESS=1
fi

echo "  macOS Keychain Status:"
echo "    • Backup Encryption Key (AES-256-GCM): $( [ "$HAS_BACKUP_KEY" -eq 1 ] && echo "CONFIGURED ✓" || echo "MISSING ⚠️" )"
echo "    • Cloudflare Access Service Auth:      $( [ "$HAS_CF_ACCESS" -eq 1 ] && echo "CONFIGURED ✓" || echo "MISSING ⚠️" )"

echo -e "\n============================================================================="
echo "  🎉 BOOTSTRAP PROVISIONING COMPLETE"
echo "============================================================================="

if [ "$HAS_BACKUP_KEY" -eq 0 ] || [ "$HAS_CF_ACCESS" -eq 0 ]; then
  echo ""
  echo "  👉 ACTION REQUIRED: Operational secrets are not yet configured in Keychain."
  echo "     Please run secret setup now:"
  echo "       bash scripts/setup_secrets.sh"
  echo ""
  echo "     After configuring secrets, restore production data from private backup:"
  echo "       bash scripts/restore_production.sh --latest"
  echo "     And verify the entire platform:"
  echo "       bash scripts/verify_fresh_install.sh"
else
  echo ""
  echo "  Next steps for full recovery:"
  echo "    1. Restore production data from private GitHub Releases backup:"
  echo "       bash scripts/restore_production.sh --latest"
  echo "    2. Run full platform verification:"
  echo "       bash scripts/verify_fresh_install.sh"
fi
echo "============================================================================="
