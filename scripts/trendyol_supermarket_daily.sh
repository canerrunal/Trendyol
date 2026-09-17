#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$PROJECT_DIR/.runtime/cron-logs"
LOG_FILE="$LOG_DIR/supermarket-$(TZ=Europe/Istanbul date +%F-%H%M%S).log"

cd "$PROJECT_DIR"
mkdir -p "$LOG_DIR"

if bash scripts/run_supermarket_daily.sh >"$LOG_FILE" 2>&1; then
  cat categories/supermarket/reports/telegram-latest.txt
else
  echo "⚠️ Trendyol Süpermarket günlük işi başarısız oldu. Son geçerli rapor korundu."
  echo "Teknik log: $LOG_FILE"
  tail -n 30 "$LOG_FILE"
  exit 1
fi
