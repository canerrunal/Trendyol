#!/usr/bin/env bash
set -euo pipefail

echo "============================================================================="
echo "  CLOUDFLARE ACCESS SERVICE AUTH — KEYCHAIN STORAGE"
echo "  Token values are masked during typing and never stored in shell history."
echo "============================================================================="

printf "Enter CF_ACCESS_CLIENT_ID (input hidden): "
read -s CF_ID
echo ""
if [ -z "$CF_ID" ]; then
  echo "ERROR: Client ID cannot be empty."
  exit 1
fi

security add-generic-password \
  -U \
  -s "verimimari-cf-access-client-id" \
  -a "client-id" \
  -w "$CF_ID"
unset CF_ID
echo "✓ Stored 'verimimari-cf-access-client-id' in macOS Keychain."

printf "Enter CF_ACCESS_CLIENT_SECRET (input hidden): "
read -s CF_SECRET
echo ""
if [ -z "$CF_SECRET" ]; then
  echo "ERROR: Client Secret cannot be empty."
  exit 1
fi

security add-generic-password \
  -U \
  -s "verimimari-cf-access-client-secret" \
  -a "client-secret" \
  -w "$CF_SECRET"
unset CF_SECRET
echo "✓ Stored 'verimimari-cf-access-client-secret' in macOS Keychain."

echo "============================================================================="
echo "Running verification probe..."
node scripts/verify_tunnel_probes.cjs
