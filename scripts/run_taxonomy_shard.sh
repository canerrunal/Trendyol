#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/Users/canerramazanunal/Documents/Trendyol"
NODE_BIN="/Users/canerramazanunal/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
NODE_MODULES="/Users/canerramazanunal/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules"
PYTHON_BIN="/usr/bin/python3"
SHARD="${1:?Shard numarası gerekli}"
SHARD_COUNT="${2:-4}"

if [[ ! "$SHARD" =~ ^[0-9]+$ ]] || [[ ! "$SHARD_COUNT" =~ ^[1-9][0-9]*$ ]] || (( SHARD >= SHARD_COUNT )); then
  echo "Geçersiz shard: $SHARD/$SHARD_COUNT" >&2
  exit 2
fi

cd "$PROJECT_DIR"
export NODE_PATH="$NODE_MODULES"
mkdir -p .runtime/cron-logs

echo "TAXONOMY_SHARD_START shard=$SHARD/$SHARD_COUNT time=$(TZ=Europe/Istanbul date +%FT%T%z)"
"$PYTHON_BIN" scripts/run_with_timeout.py --timeout 6600 --heartbeat 30 -- \
  "$NODE_BIN" --max-old-space-size=2048 scripts/collect_taxonomy_shard.cjs --shard "$SHARD" --shards "$SHARD_COUNT"
echo "TAXONOMY_SHARD_DONE shard=$SHARD/$SHARD_COUNT"
