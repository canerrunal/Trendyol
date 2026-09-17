#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-$(which python3 || echo /usr/bin/python3)}"

if [[ "$#" -lt 2 ]]; then
  echo "Kullanım: $0 <commit mesajı> <yol> [yol...]" >&2
  exit 2
fi

commit_message="$1"
shift
publish_paths=("$@")

cd "$PROJECT_DIR"

for relative_path in "${publish_paths[@]}"; do
  if [[ -z "$relative_path" || "$relative_path" == /* || "$relative_path" == "." || "$relative_path" == *".."* ]]; then
    echo "Güvensiz yayın yolu: $relative_path" >&2
    exit 2
  fi
  if [[ ! -e "$PROJECT_DIR/$relative_path" ]]; then
    echo "Yayın kaynağı bulunamadı: $relative_path" >&2
    exit 2
  fi
done

publish_dir=$(/usr/bin/mktemp -d /tmp/trendyol-main-publish.XXXXXX)
cleanup() {
  git -C "$PROJECT_DIR" worktree remove --force "$publish_dir" >/dev/null 2>&1 || true
  if [[ "$publish_dir" == /tmp/trendyol-main-publish.* ]]; then
    /bin/rm -rf "$publish_dir"
  fi
}
trap cleanup EXIT INT TERM

"$PYTHON_BIN" scripts/run_with_timeout.py --timeout 180 --heartbeat 30 -- git fetch origin main
git worktree add --detach "$publish_dir" origin/main

for relative_path in "${publish_paths[@]}"; do
  source_path="$PROJECT_DIR/$relative_path"
  target_path="$publish_dir/$relative_path"
  /bin/mkdir -p "$(/usr/bin/dirname "$target_path")"
  if [[ -d "$source_path" ]]; then
    /bin/mkdir -p "$target_path"
    /usr/bin/rsync -a --delete "$source_path/" "$target_path/"
  else
    /bin/cp "$source_path" "$target_path"
  fi
done

git -C "$publish_dir" add -- "${publish_paths[@]}"
if git -C "$publish_dir" diff --cached --quiet; then
  echo "MAIN_PUBLISH_SKIPPED değişiklik yok: ${publish_paths[*]}"
  exit 0
fi

git -C "$publish_dir" commit -m "$commit_message"
"$PYTHON_BIN" "$PROJECT_DIR/scripts/run_with_timeout.py" --timeout 180 --heartbeat 30 -- \
  git -C "$publish_dir" push origin HEAD:main
echo "MAIN_PUBLISH_OK paths=${publish_paths[*]}"
