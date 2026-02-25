#!/bin/bash
# UserPromptSubmit hook: Inject git branch and uncommitted file count

BRANCH=$(git branch --show-current 2>/dev/null)

if [ -n "$BRANCH" ]; then
  DIRTY=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"[git] branch: %s | uncommitted files: %s"}}' "$BRANCH" "$DIRTY"
fi
