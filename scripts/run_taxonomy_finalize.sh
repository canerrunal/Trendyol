#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_BIN="${NODE_BIN:-$(which node)}"

cd "$PROJECT_DIR"

"$NODE_BIN" --max-old-space-size=2048 scripts/finalize_taxonomy_run.cjs

status_file="$PROJECT_DIR/taxonomy/status.json"
run_date=$(TZ=Europe/Istanbul date +%F)

if [[ -f "$status_file" ]]; then
  quality_status=$("$NODE_BIN" -e "const s = require('./taxonomy/status.json'); console.log(s.status || 'UNKNOWN');")
  if [[ "$quality_status" == "PASS" ]]; then
    echo "TAXONOMY_PUBLISH_APPROVED status=PASS. Publishing to main..."
    scripts/publish_paths_to_main.sh "data: Trendyol kategori evreni ${run_date}" taxonomy
  else
    echo "TAXONOMY_PUBLISH_BLOCKED status=${quality_status}. Production main branch will NOT be updated."
  fi
else
  echo "TAXONOMY_STATUS_MISSING status.json not found." >&2
  exit 1
fi

cat taxonomy/reports/telegram-latest.txt
