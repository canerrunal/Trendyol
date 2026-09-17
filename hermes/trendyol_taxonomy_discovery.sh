#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="${PROJECT_DIR:-${TRENDYOL_PROJECT_DIR:-$HOME/Documents/Trendyol}}"
LOG_DIR="$PROJECT_DIR/.runtime/cron-logs"
LOG_FILE="$LOG_DIR/taxonomy-discovery-$(TZ=Europe/Istanbul date +%F-%H%M%S).log"
mkdir -p "$LOG_DIR"
if bash "$PROJECT_DIR/scripts/run_taxonomy_discovery.sh" >"$LOG_FILE" 2>&1; then
  tail -n 3 "$LOG_FILE"
else
  echo "⚠️ Trendyol kategori ağacı yenilenemedi. Son katalog korunuyor."
  echo "Teknik log: $LOG_FILE"
  tail -n 30 "$LOG_FILE"
  exit 1
fi
