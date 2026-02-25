#!/bin/bash
# PostToolUse hook: Inject git status context after every tool call
# Provides branch, uncommitted file count, and remote sync status

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

[[ -z "$CWD" ]] && exit 0

# Must be a git repository
if ! git -C "$CWD" rev-parse --git-dir > /dev/null 2>&1; then
  exit 0
fi

BRANCH=$(git -C "$CWD" branch --show-current 2>/dev/null)
[[ -z "$BRANCH" ]] && BRANCH="(detached)"

UNCOMMITTED=$(git -C "$CWD" status --porcelain 2>/dev/null | wc -l | tr -d ' ')

# Remote status
AHEAD=""
BEHIND=""
UPSTREAM=$(git -C "$CWD" rev-parse --abbrev-ref "@{upstream}" 2>/dev/null)
if [[ -n "$UPSTREAM" ]]; then
  AHEAD=$(git -C "$CWD" rev-list --count "@{upstream}..HEAD" 2>/dev/null)
  BEHIND=$(git -C "$CWD" rev-list --count "HEAD..@{upstream}" 2>/dev/null)
fi

# Build compact status line
STATUS="[git] branch: $BRANCH"
STATUS+=" | uncommitted files: $UNCOMMITTED"

if [[ -n "$UPSTREAM" ]]; then
  if [[ "$AHEAD" -gt 0 && "$BEHIND" -gt 0 ]]; then
    STATUS+=" | diverged: ${AHEAD} ahead, ${BEHIND} behind"
  elif [[ "$AHEAD" -gt 0 ]]; then
    STATUS+=" | ${AHEAD} unpushed commit(s)"
  elif [[ "$BEHIND" -gt 0 ]]; then
    STATUS+=" | ${BEHIND} behind remote"
  fi
fi

printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"%s"}}' "$STATUS"
