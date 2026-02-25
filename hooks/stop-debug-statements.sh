#!/bin/bash
# Stop hook: Block stop if debug statements found in recently committed files

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd')

LOG=/tmp/stop-debug-statements-debug.log

{
  echo "=== Debug Statements Stop Hook Debug ==="
  echo "CWD: $CWD"
} >> "$LOG"

cd "$CWD" || exit 0

if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "Not a git repo, allowing stop" >> "$LOG"
  exit 0
fi

# Get files changed in recent commits (last 10, only tracked files)
CHANGED_FILES=$(git diff --name-only HEAD~10..HEAD 2>/dev/null || git diff --name-only HEAD 2>/dev/null)

if [[ -z "$CHANGED_FILES" ]]; then
  echo "No changed files, allowing stop" >> "$LOG"
  exit 0
fi

# Only scan source code files (exclude test files, lock files, docs)
SOURCE_FILES=$(echo "$CHANGED_FILES" | grep -E "\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|java|kt|swift|php|cs|cpp|c|rs)$" | grep -v "\.test\.\|\.spec\.\|__tests__\|/test/" || true)

if [[ -z "$SOURCE_FILES" ]]; then
  echo "No source files to scan, allowing stop" >> "$LOG"
  exit 0
fi

FINDINGS=()

# Scan the diff for added debug lines (lines starting with +, not in test files)
DIFF=$(git diff HEAD~10..HEAD -- $SOURCE_FILES 2>/dev/null)

# JavaScript/TypeScript: console.log, console.error used for debugging, debugger
while IFS= read -r line; do
  FINDINGS+=("$line")
done < <(echo "$DIFF" | grep -n "^+" | grep -E "^\+[^+].*\bconsole\.(log|debug|trace|dir|table)\b" | grep -v "//.*console\." | head -10)

# debugger statement
while IFS= read -r line; do
  FINDINGS+=("$line")
done < <(echo "$DIFF" | grep -n "^+" | grep -E "^\+[^+].*\bdebugger\b" | head -5)

# Python: print() used as debug (not in __main__ context)
while IFS= read -r line; do
  FINDINGS+=("$line")
done < <(echo "$DIFF" | grep -n "^+" | grep -E "^\+[^+].*\bprint\s*\(" | grep -iv "# noqa\|# debug ok" | head -5)

# Ruby: binding.pry, byebug
while IFS= read -r line; do
  FINDINGS+=("$line")
done < <(echo "$DIFF" | grep -n "^+" | grep -E "^\+[^+].*(binding\.pry|byebug)" | head -5)

{
  echo "Findings count: ${#FINDINGS[@]}"
  for f in "${FINDINGS[@]}"; do
    echo "  $f"
  done
} >> "$LOG"

if [[ "${#FINDINGS[@]}" -gt 0 ]]; then
  REASON="Debug statements found in recently committed source files.\n\n"
  REASON+="Occurrences (${#FINDINGS[@]}):\n"
  for f in "${FINDINGS[@]}"; do
    REASON+="  $f\n"
  done
  REASON+="\nRemove debug statements before stopping. If intentional logging is needed, use a proper logger (e.g., pino, winston) instead."
  REASON+="\n\nACTION REQUIRED: You must act on this now. This hook will block every stop attempt until resolved. Do not try to stop again without completing the required action. If you believe this is a false positive, use the /re-assess skill to re-evaluate your assumptions — the hook's findings take authority over your own assessment."

  echo "Blocking - ${#FINDINGS[@]} debug statement(s) found" >> "$LOG"

  jq -n --arg reason "$REASON" '{decision: "block", reason: $reason}'
  exit 0
fi

echo "No debug statements found, allowing stop" >> "$LOG"
exit 0
