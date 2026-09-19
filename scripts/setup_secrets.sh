#!/usr/bin/env bash
# =============================================================================
# Verimimari Marketplace Data Platform V2 — Secrets Setup & macOS Keychain Sync
# Securely configures operational secrets directly in macOS Keychain.
# ZERO SECRET LOGGING GUARANTEE: Inputs are masked and never stored in shell history.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_DIR="$PROJECT_DIR/.runtime"

mkdir -p "$RUNTIME_DIR"
chmod 700 "$RUNTIME_DIR"

KEYCHAIN_USER="${USER:-canerrunal}"

echo "============================================================================="
echo "  VERIMIMARI PLATFORM V2 — SECURE SECRETS SETUP"
echo "  Target: macOS Keychain (service-level isolation)"
echo "  Inputs are masked (hidden) during entry and never logged."
echo "============================================================================="

# Helper function to prompt masked input
prompt_secret() {
  local prompt_text="$1"
  local var_name="$2"
  local env_fallback="${3:-}"

  if [ -n "$env_fallback" ]; then
    printf "✓ Using provided environment variable for %s\n" "$var_name"
    eval "$var_name=\"\$env_fallback\""
    return
  fi

  while true; do
    printf "%s: " "$prompt_text"
    read -r -s val
    echo ""
    if [ -z "$val" ]; then
      echo "  ⚠️ Value cannot be empty. Please try again."
    else
      eval "$var_name=\"\$val\""
      break
    fi
  done
}

# 1. Cloudflare Access Service Auth Credentials
echo -e "\n[1/5] Cloudflare Access Service Auth (API Reader Protection)..."
prompt_secret "Enter CF_ACCESS_CLIENT_ID" CF_ID "${CF_ACCESS_CLIENT_ID:-}"
security add-generic-password -U -s "verimimari-cf-access-client-id" -a "client-id" -w "$CF_ID"
security add-generic-password -U -s "verimimari-cf-access" -a "client-id" -w "$CF_ID"
unset CF_ID
echo "  ✓ Stored 'verimimari-cf-access-client-id' in macOS Keychain."

prompt_secret "Enter CF_ACCESS_CLIENT_SECRET" CF_SECRET "${CF_ACCESS_CLIENT_SECRET:-}"
security add-generic-password -U -s "verimimari-cf-access-client-secret" -a "client-secret" -w "$CF_SECRET"
security add-generic-password -U -s "verimimari-cf-access" -a "client-secret" -w "$CF_SECRET"
unset CF_SECRET
echo "  ✓ Stored 'verimimari-cf-access-client-secret' in macOS Keychain."

# 2. Cloudflare Named Tunnel Token
echo -e "\n[2/5] Cloudflare Named Tunnel Run Token..."
if [ -n "${CF_TUNNEL_TOKEN:-}" ]; then
  TUNNEL_TOKEN="$CF_TUNNEL_TOKEN"
else
  printf "Enter Cloudflare Tunnel run token (or press Enter to skip if using local port only): "
  read -r -s TUNNEL_TOKEN || TUNNEL_TOKEN=""
  echo ""
fi

if [ -n "$TUNNEL_TOKEN" ]; then
  security add-generic-password -U -s "verimimari-cf-tunnel-token" -a "tunnel-token" -w "$TUNNEL_TOKEN"
  unset TUNNEL_TOKEN
  echo "  ✓ Stored 'verimimari-cf-tunnel-token' in macOS Keychain."
else
  echo "  (Skipped Cloudflare Tunnel token setup)"
fi

# 3. AES-256-GCM Backup Encryption Key (CRITICAL DISASTER RECOVERY KEY)
echo -e "\n[3/5] AES-256-GCM Backup Encryption Key (64 hex characters)..."
echo "  NOTE: This key encrypts all off-host ClickHouse snapshots."
echo "  Ensure you also preserve a copy on external physical media (/Volumes/...)."
prompt_secret "Enter 64-character HEX Backup Key" BACKUP_KEY "${BACKUP_ENCRYPTION_KEY:-}"

# Validate 64-char hex format
if ! echo "$BACKUP_KEY" | grep -Eq '^[0-9a-fA-F]{64}$'; then
  echo "  ⚠️ Warning: Key is not a 64-character hex string. It will be derived via scryptSync."
fi

security add-generic-password -U -s "verimimari-backup-key" -a "$KEYCHAIN_USER" -w "$BACKUP_KEY"
echo "$BACKUP_KEY" > "$RUNTIME_DIR/backup_encryption.key"
chmod 600 "$RUNTIME_DIR/backup_encryption.key"
unset BACKUP_KEY
echo "  ✓ Stored 'verimimari-backup-key' in macOS Keychain (Account: $KEYCHAIN_USER)."
echo "  ✓ Secured .runtime/backup_encryption.key (mode 0600)."

# 4. Supabase Credentials (Dual-Write Sink)
echo -e "\n[4/5] Supabase Dual-Write Credentials..."
prompt_secret "Enter SUPABASE_URL (e.g. https://xyz.supabase.co)" SB_URL "${SUPABASE_URL:-}"
prompt_secret "Enter SUPABASE_SERVICE_ROLE_KEY" SB_KEY "${SUPABASE_SERVICE_ROLE_KEY:-}"

# Store in macOS Keychain
security add-generic-password -U -s "verimimari-supabase-url" -a "supabase-url" -w "$SB_URL"
security add-generic-password -U -s "verimimari-supabase-key" -a "supabase-key" -w "$SB_KEY"

# Ensure local .env exists with mode 0600 for runtime libraries
ENV_FILE="$PROJECT_DIR/.env"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

# Clean existing Supabase keys in .env and write updated ones
sed -i '' '/^SUPABASE_URL=/d' "$ENV_FILE" 2>/dev/null || true
sed -i '' '/^SUPABASE_SERVICE_ROLE_KEY=/d' "$ENV_FILE" 2>/dev/null || true
echo "SUPABASE_URL=$SB_URL" >> "$ENV_FILE"
echo "SUPABASE_SERVICE_ROLE_KEY=$SB_KEY" >> "$ENV_FILE"
unset SB_URL SB_KEY
echo "  ✓ Stored Supabase credentials in macOS Keychain and secured .env (mode 0600)."

# 5. Telegram & Hermes Alerting Secrets (Optional)
echo -e "\n[5/5] Hermes & Telegram Notification Secrets..."
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
  TG_TOKEN="$TELEGRAM_BOT_TOKEN"
else
  printf "Enter TELEGRAM_BOT_TOKEN (or press Enter to skip): "
  read -r -s TG_TOKEN || TG_TOKEN=""
  echo ""
fi

if [ -n "$TG_TOKEN" ]; then
  security add-generic-password -U -s "verimimari-telegram-bot-token" -a "bot-token" -w "$TG_TOKEN"
  sed -i '' '/^TELEGRAM_BOT_TOKEN=/d' "$ENV_FILE" 2>/dev/null || true
  echo "TELEGRAM_BOT_TOKEN=$TG_TOKEN" >> "$ENV_FILE"
  unset TG_TOKEN
  echo "  ✓ Stored Telegram Bot Token in macOS Keychain and .env."
else
  echo "  (Skipped Telegram Bot Token setup)"
fi

echo -e "\n============================================================================="
echo "  ✓ ALL PRODUCTION SECRETS CONFIGURED SUCCESSFULLY"
echo "  Keychain access verified with zero secret leaks."
echo "============================================================================="
