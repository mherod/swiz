#!/bin/bash
# PostToolUse hook: Remind about sibling test file when editing source files

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // ""')
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')

# Only act on edit/write tool calls (Edit/StrReplace/Write across agents)
if [[ "$TOOL" != "Edit" && "$TOOL" != "StrReplace" && "$TOOL" != "Write" ]]; then
  exit 0
fi

# Only care about TypeScript/JavaScript source files
if ! echo "$FILE" | grep -qE "\.(ts|tsx|js|jsx|mjs)$"; then
  exit 0
fi

# Skip if the file being edited is itself a test file
if echo "$FILE" | grep -qE "\.(test|spec)\.(ts|tsx|js|jsx)$|/__tests__/"; then
  exit 0
fi

# Derive candidate test file paths
BASE="${FILE%.*}"
EXT="${FILE##*.}"
CANDIDATES=(
  "${BASE}.test.${EXT}"
  "${BASE}.spec.${EXT}"
  "$(dirname "$FILE")/__tests__/$(basename "$BASE").test.${EXT}"
  "$(dirname "$FILE")/__tests__/$(basename "$BASE").spec.${EXT}"
)

FOUND_TEST=""
for candidate in "${CANDIDATES[@]}"; do
  if [[ -f "$candidate" ]]; then
    FOUND_TEST="$candidate"
    break
  fi
done

if [[ -n "$FOUND_TEST" ]]; then
  RELATIVE_TEST="${FOUND_TEST#$HOME}"
  printf '{
    "hookSpecificOutput": {
      "hookEventName": "PostToolUse",
      "additionalContext": "Test file exists for this source file: %s — check if it needs updating to reflect your changes."
    }
  }' "$FOUND_TEST"
fi

exit 0
