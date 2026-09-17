#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_BIN="${NODE_BIN:-$(which node)}"
PYTHON_BIN="${PYTHON_BIN:-$(which python3 || echo /usr/bin/python3)}"

cd "$PROJECT_DIR"
mkdir -p .runtime/cron-logs

echo "TAXONOMY_DISCOVERY_START time=$(TZ=Europe/Istanbul date +%FT%T%z)"
"$PYTHON_BIN" scripts/run_with_timeout.py --timeout 300 --heartbeat 30 -- \
  "$NODE_BIN" scripts/discover_bestseller_taxonomy.cjs
echo "TAXONOMY_DISCOVERY_DONE"
