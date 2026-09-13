#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/Users/canerramazanunal/Documents/Trendyol"
HERMES_BIN="/Users/canerramazanunal/.local/bin/hermes"
HERMES_SCRIPT_DIR="/Users/canerramazanunal/.hermes/scripts"
JOBS_FILE="/Users/canerramazanunal/.hermes/cron/jobs.json"

mkdir -p "$HERMES_SCRIPT_DIR"
for source in "$PROJECT_DIR"/hermes/trendyol_taxonomy_*.sh; do
  install -m 755 "$source" "$HERMES_SCRIPT_DIR/$(basename "$source")"
done

job_id_for_name() {
  /usr/bin/python3 - "$JOBS_FILE" "$1" <<'PY'
import json, pathlib, sys
file, name = pathlib.Path(sys.argv[1]), sys.argv[2]
if file.exists():
    for job in json.loads(file.read_text()).get('jobs', []):
        if job.get('name') == name:
            print(job.get('id', ''))
            break
PY
}

upsert_job() {
  local name="$1" schedule="$2" script="$3" deliver="$4"
  local job_id
  job_id="$(job_id_for_name "$name")"
  if [[ -n "$job_id" ]]; then
    "$HERMES_BIN" cron edit "$job_id" --schedule "$schedule" --name "$name" --deliver "$deliver" --script "$script" --no-agent --workdir "$PROJECT_DIR"
  else
    "$HERMES_BIN" cron create "$schedule" --name "$name" --deliver "$deliver" --script "$script" --no-agent --workdir "$PROJECT_DIR"
  fi
}

upsert_job "trendyol-taxonomy-discovery" "0 15 * * *" "trendyol_taxonomy_discovery.sh" "local"
upsert_job "trendyol-taxonomy-shard-0" "10 15 * * *" "trendyol_taxonomy_shard_0.sh" "local"
upsert_job "trendyol-taxonomy-shard-1" "0 16 * * *" "trendyol_taxonomy_shard_1.sh" "local"
upsert_job "trendyol-taxonomy-shard-2" "50 16 * * *" "trendyol_taxonomy_shard_2.sh" "local"
upsert_job "trendyol-taxonomy-shard-3" "40 17 * * *" "trendyol_taxonomy_shard_3.sh" "local"
upsert_job "trendyol-taxonomy-finalize" "10 19 * * *" "trendyol_taxonomy_finalize.sh" "telegram"

echo "TAXONOMY_HERMES_INSTALL_OK jobs=6"
