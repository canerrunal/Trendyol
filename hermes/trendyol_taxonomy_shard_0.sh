#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="${PROJECT_DIR:-${TRENDYOL_PROJECT_DIR:-$HOME/Documents/Trendyol}}"
LOG_DIR="$PROJECT_DIR/.runtime/cron-logs"; mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/taxonomy-shard-0-$(TZ=Europe/Istanbul date +%F-%H%M%S).log"
if bash "$PROJECT_DIR/scripts/run_taxonomy_shard.sh" 0 4 >"$LOG_FILE" 2>&1; then tail -n 3 "$LOG_FILE"; else echo "⚠️ Kategori işçisi 1/4 başarısız. Log: $LOG_FILE"; tail -n 30 "$LOG_FILE"; exit 1; fi
