#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/Users/canerramazanunal/Documents/Trendyol"
NODE_BIN="/Users/canerramazanunal/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
NODE_MODULES="/Users/canerramazanunal/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules"
PYTHON_BIN="/usr/bin/python3"
PROFILE="${1:-cocuk}"

if [[ ! "$PROFILE" =~ ^[a-z0-9-]+$ ]]; then
  echo "Geçersiz profil: $PROFILE" >&2
  exit 2
fi

if [[ "${TRENDYOL_GLOBAL_LOCK_HELD:-0}" != "1" ]]; then
  export TRENDYOL_GLOBAL_LOCK_HELD=1
  echo "GLOBAL_LOCK_WAIT profile=$PROFILE"
  exec /usr/bin/lockf -t 900 /tmp/trendyol-daily-global.lock "$0" "$PROFILE"
fi

cd "$PROJECT_DIR"
export NODE_PATH="$NODE_MODULES"
mkdir -p categories

echo "DAILY_RUN_START profile=$PROFILE time=$(TZ=Europe/Istanbul date +%FT%T%z)"

run_collector() {
  "$PYTHON_BIN" scripts/run_with_timeout.py --timeout 1200 --heartbeat 30 -- \
    "$NODE_BIN" scripts/collect.cjs --profile "$PROFILE"
}

if ! run_collector; then
  echo "İlk toplama denemesi başarısız: $PROFILE. 120 saniye sonra bir kez daha denenecek." >&2
  sleep 120
  run_collector
fi
"$NODE_BIN" scripts/quality_check.cjs --profile "$PROFILE"

run_date=$(TZ=Europe/Istanbul date +%F)
if [[ "$PROFILE" == "cocuk" ]]; then
  scripts/publish_paths_to_main.sh "data: Trendyol ${PROFILE} günlük raporu ${run_date}" \
    data snapshots lists reports quality
else
  scripts/publish_paths_to_main.sh "data: Trendyol ${PROFILE} günlük raporu ${run_date}" \
    "categories/$PROFILE"
fi

echo "DAILY_RUN_OK ${PROFILE} ${run_date}"
