#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_BIN="${NODE_BIN:-$(which node)}"
PYTHON_BIN="${PYTHON_BIN:-$(which python3 || echo /usr/bin/python3)}"
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
mkdir -p categories

echo "DAILY_RUN_START profile=$PROFILE time=$(TZ=Europe/Istanbul date +%FT%T%z)"
run_date=$(TZ=Europe/Istanbul date +%F)

run_collector() {
  "$PYTHON_BIN" scripts/run_with_timeout.py --timeout 1200 --heartbeat 30 -- \
    "$NODE_BIN" scripts/collect.cjs --profile "$PROFILE" --use-listing-cache "$@"
}

collector_ok=0
if run_collector; then
  collector_ok=1
else
  echo "İlk toplama denemesi başarısız: $PROFILE. 120 saniye sonra bir kez daha denenecek." >&2
  sleep 120
  if run_collector; then
    collector_ok=1
  fi
fi

if [[ "$collector_ok" -ne 1 ]]; then
  recovery_path=""
  if [[ "$PROFILE" == "cocuk" ]]; then
    recovery_path="data/backups"
  else
    recovery_path="categories/$PROFILE/data/backups"
  fi
  if [[ -d "$PROJECT_DIR/$recovery_path" ]]; then
    echo "RECOVERY_PUBLISH_START profile=$PROFILE path=$recovery_path"
    scripts/publish_paths_to_main.sh "recovery: Trendyol partial scan backup ${PROFILE} ${run_date}" "$recovery_path"
    echo "RECOVERY_PUBLISH_OK profile=$PROFILE path=$recovery_path"
  else
    echo "RECOVERY_PUBLISH_SKIPPED profile=$PROFILE reason=no-backup"
  fi
  exit 1
fi
"$NODE_BIN" scripts/quality_check.cjs --profile "$PROFILE"

if [[ "$PROFILE" == "cocuk" ]]; then
  scripts/publish_paths_to_main.sh "data: Trendyol ${PROFILE} günlük raporu ${run_date}" \
    data snapshots lists reports quality
else
  scripts/publish_paths_to_main.sh "data: Trendyol ${PROFILE} günlük raporu ${run_date}" \
    "categories/$PROFILE"
fi

echo "DAILY_RUN_OK ${PROFILE} ${run_date}"
