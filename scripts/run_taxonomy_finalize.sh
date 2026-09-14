#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/Users/canerramazanunal/Documents/Trendyol"
NODE_BIN="/Users/canerramazanunal/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
NODE_MODULES="/Users/canerramazanunal/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules"

cd "$PROJECT_DIR"
export NODE_PATH="$NODE_MODULES"

"$NODE_BIN" --max-old-space-size=2048 scripts/finalize_taxonomy_run.cjs
run_date=$(TZ=Europe/Istanbul date +%F)
scripts/publish_paths_to_main.sh "data: Trendyol kategori evreni ${run_date}" taxonomy

cat taxonomy/reports/telegram-latest.txt
