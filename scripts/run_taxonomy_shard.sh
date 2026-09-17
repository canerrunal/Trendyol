#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_BIN="${NODE_BIN:-$(which node)}"
PYTHON_BIN="${PYTHON_BIN:-$(which python3 || echo /usr/bin/python3)}"
SHARD="${1:?Shard numarası gerekli}"
SHARD_COUNT="${2:-4}"

if [[ ! "$SHARD" =~ ^[0-9]+$ ]] || [[ ! "$SHARD_COUNT" =~ ^[1-9][0-9]*$ ]] || (( SHARD >= SHARD_COUNT )); then
  echo "Geçersiz shard: $SHARD/$SHARD_COUNT" >&2
  exit 2
fi

cd "$PROJECT_DIR"
mkdir -p .runtime/cron-logs

echo "TAXONOMY_SHARD_START shard=$SHARD/$SHARD_COUNT time=$(TZ=Europe/Istanbul date +%FT%T%z)"
"$PYTHON_BIN" scripts/run_with_timeout.py --timeout 6600 --heartbeat 30 -- \
  "$NODE_BIN" --max-old-space-size=2048 scripts/collect_taxonomy_shard.cjs --shard "$SHARD" --shards "$SHARD_COUNT"
echo "TAXONOMY_SHARD_DONE shard=$SHARD/$SHARD_COUNT"
