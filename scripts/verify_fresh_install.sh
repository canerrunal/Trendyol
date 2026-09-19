#!/usr/bin/env bash
# =============================================================================
# Verimimari Marketplace Data Platform V2 — Fresh Install Health Report
# Single-command execution verifying 15 core architectural invariants.
#
# Usage:
#   bash scripts/verify_fresh_install.sh
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

NODE_BIN="$(which node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  echo "❌ ERROR: Node.js is not found in PATH."
  exit 1
fi

"$NODE_BIN" "$SCRIPT_DIR/verify_fresh_install.cjs" "$@"
