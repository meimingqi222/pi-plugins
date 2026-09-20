#!/bin/sh
# Verify the regression-notes tree.
#
# Why this wrapper exists rather than calling the verifier directly from
# `package.json`: on Windows, `bun run <script>` does not put the Python launcher
# on PATH, so `python ...` fails with "command not found: python" even though a
# shell can find it. Going through `sh` (Git Bash) restores that, and the same
# form works on macOS and Linux.
#
# The verifier is a shared skill, installed outside this repository, so its
# location is searched rather than hard-coded: the repository root's sibling
# first, then the standard Agent Skills locations.
set -e

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
notes="$root/.agents/notes"

[ -d "$notes" ] || { echo "no notes directory at $notes" >&2; exit 0; }

verifier=""
for candidate in \
  "$root/../.agents/skills/regression-notes/scripts/verify-notes.py" \
  "$HOME/.agents/skills/regression-notes/scripts/verify-notes.py" \
  "$HOME/.claude/skills/regression-notes/scripts/verify-notes.py" \
  "$HOME/.config/opencode/skills/regression-notes/scripts/verify-notes.py" \
  "$HOME/.codex/skills/regression-notes/scripts/verify-notes.py"
do
  if [ -f "$candidate" ]; then
    verifier=$candidate
    break
  fi
done

if [ -z "$verifier" ]; then
  echo "regression-notes: verifier not found; skipping gate" >&2
  exit 0
fi

if command -v python3 >/dev/null 2>&1; then
  py=python3
elif command -v python >/dev/null 2>&1; then
  py=python
elif command -v py >/dev/null 2>&1; then
  py="py -3"
else
  echo "regression-notes: no python found; skipping gate" >&2
  exit 0
fi

# shellcheck disable=SC2086
exec $py "$verifier" --notes-dir "$notes"
