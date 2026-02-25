#!/bin/bash
# Stop hook: Block stop if new TODO/FIXME/HACK lines were introduced in commits

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd')

LOG=/tmp/stop-todo-tracker-debug.log

{
  echo "=== TODO Tracker Stop Hook Debug ==="
  echo "CWD: $CWD"
} >> "$LOG"

cd "$CWD" || exit 0

if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "Not a git repo, allowing stop" >> "$LOG"
  exit 0
fi

# Only scan recognised source code files — not shell scripts, hooks, docs, lock files, or test files
# Test files often contain TODO/FIXME as test fixture strings, not actual developer notes
CHANGED_SOURCE=$(git diff --name-only HEAD~10..HEAD 2>/dev/null | grep -E "\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|java|kt|swift|php|cs|cpp|c|rs|vue|svelte)$" | grep -v "node_modules\|\.claude/hooks/\|__tests__\|\.test\.\|\.spec\." || true)

if [[ -z "$CHANGED_SOURCE" ]]; then
  echo "No source files changed, allowing stop" >> "$LOG"
  exit 0
fi

# Get diff of last 10 commits scoped to source files only
DIFF=$(git diff HEAD~10..HEAD -- $CHANGED_SOURCE 2>/dev/null)

if [[ -z "$DIFF" ]]; then
  echo "No diff in source files, allowing stop" >> "$LOG"
  exit 0
fi

# Find added lines (starting with +, not +++) containing TODO/FIXME/HACK/XXX/WORKAROUND
# Exclude lines where the keyword appears inside a regex literal (e.g. /\/\/\s*TODO:/i)
# These are pattern strings used in rule implementations, not actual developer notes.
# After grep -n on a diff, lines look like "403:+  /pattern/flags," so we exclude
# lines where the diff content (after the leading +) is a regex literal starting with /
TODOS=$(echo "$DIFF" | grep -n "^+" | grep -v "^+++" | grep -iE "\b(TODO|FIXME|HACK|XXX|WORKAROUND)\b" | grep -vE ":[+][[:space:]]*/[^/]" | head -15)

{
  echo "New TODOs found:"
  echo "$TODOS"
} >> "$LOG"

if [[ -n "$TODOS" ]]; then
  TODO_COUNT=$(echo "$TODOS" | wc -l | tr -d ' ')

  REASON="$TODO_COUNT new TODO/FIXME/HACK comment(s) introduced in recent commits.\n\n"
  REASON+="Items:\n"
  while IFS= read -r line; do
    REASON+="  $line\n"
  done <<< "$TODOS"
  REASON+="\nEither resolve these now, or use the /farm-out-issues skill to file them as GitHub issues before stopping."
  REASON+="\n\nACTION REQUIRED: You must act on this now. This hook will block every stop attempt until resolved. Do not try to stop again without completing the required action. If you believe this is a false positive, use the /re-assess skill to re-evaluate your assumptions — the hook's findings take authority over your own assessment."

  echo "Blocking - $TODO_COUNT TODO(s) found" >> "$LOG"

  jq -n --arg reason "$REASON" '{decision: "block", reason: $reason}'
  exit 0
fi

echo "No new TODOs, allowing stop" >> "$LOG"
exit 0
