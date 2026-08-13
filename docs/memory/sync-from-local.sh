#!/usr/bin/env bash
# Mirrors this session's local auto-memory files into docs/memory/ so they get
# committed and pushed to GitHub alongside the repo. Run this, review the diff,
# then commit — it never commits or pushes on its own.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOCAL_MEMORY_DIR="$HOME/.claude/projects/-home-kennethdungca-Documents-Business-kcmps/memory"
DEST_DIR="$REPO_ROOT/docs/memory"

if [ ! -d "$LOCAL_MEMORY_DIR" ]; then
  echo "Local memory directory not found: $LOCAL_MEMORY_DIR" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
rsync -av --delete --exclude 'sync-from-local.sh' --exclude 'README.md' \
  "$LOCAL_MEMORY_DIR"/ "$DEST_DIR"/

echo
echo "Synced. Review with: git -C \"$REPO_ROOT\" status --short docs/memory/"
echo "Then stage explicit paths and commit — never git add -A."
