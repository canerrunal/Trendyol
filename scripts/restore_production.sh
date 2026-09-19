#!/usr/bin/env bash
# =============================================================================
# Verimimari Marketplace Data Platform V2 — Production Restore Entrypoint
# Single-command restore from private GitHub Releases backups.
#
# Usage:
#   bash scripts/restore_production.sh --latest
#   bash scripts/restore_production.sh --tag v-verimimari-backup-2026-09-19T15-22-03-761Z
#   bash scripts/restore_production.sh --latest --verify-only
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Verify gh is authenticated
if ! gh auth status >/dev/null 2>&1; then
  echo "❌ ERROR: GitHub CLI (gh) is not authenticated."
  echo "  Please run 'gh auth login' to authenticate with private backup repo access."
  exit 1
fi

NODE_BIN="$(which node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  echo "❌ ERROR: Node.js is not found in PATH."
  exit 1
fi

"$NODE_BIN" "$SCRIPT_DIR/restore_production.cjs" "$@"
