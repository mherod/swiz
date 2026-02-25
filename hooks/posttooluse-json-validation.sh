#!/bin/bash
# PostToolUse hook: Validate JSON files after writing

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)

if [[ "$FILE_PATH" == *.json ]]; then
  if ! jq . "$FILE_PATH" > /dev/null 2>&1; then
    printf '{"decision":"block","reason":"JSON validation failed — the file is not valid JSON. Fix the syntax errors."}'
  fi
fi
