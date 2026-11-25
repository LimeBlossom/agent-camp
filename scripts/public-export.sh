#!/bin/bash
# Build a single-commit public export from a commit of the scrubbed tree.
# Usage: public-export.sh <repo or worktree> <rev> <new empty dir>
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$1"; REV="$2"; OUT="$3"
[ -e "$OUT" ] && { echo "refusing: $OUT exists" >&2; exit 2; }
mkdir -p "$OUT"
git -C "$SRC" archive "$REV" | tar -x -C "$OUT"
rm -rf "$OUT/research"
node "$SCRIPT_DIR/public-export-audit.cjs" "$OUT"
if [ -f "$OUT/test/public-names.test.cjs" ]; then
  (cd "$OUT" && node --test test/public-names.test.cjs | grep -E '^# (pass|fail)')
fi
git -C "$OUT" init -q -b main
git -C "$OUT" add -A
git -C "$OUT" commit -q -m "Initial public release" -m "Fork of chaitanyagiri/munder-difflin (MIT) that adds a multi-agent hive harness."
git -C "$OUT" log --oneline
