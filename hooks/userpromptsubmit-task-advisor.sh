#!/bin/bash
# UserPromptSubmit hook: Gently suggest TaskCreate when no pending tasks exist

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

# Can't check without a session ID
[[ -z "$SESSION_ID" ]] && exit 0

TASKS_DIR="$HOME/.claude/tasks/$SESSION_ID"

# Count pending or in_progress tasks
PENDING_COUNT=0
if [[ -d "$TASKS_DIR" ]]; then
  for task_file in "$TASKS_DIR"/*.json; do
    [[ ! -f "$task_file" ]] && continue
    STATUS=$(jq -r '.status // empty' "$task_file" 2>/dev/null)
    if [[ "$STATUS" == "pending" || "$STATUS" == "in_progress" ]]; then
      PENDING_COUNT=$((PENDING_COUNT + 1))
    fi
  done
fi

# Only advise when there are precisely zero pending tasks
if [[ "$PENDING_COUNT" -eq 0 ]]; then
  printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"No pending tasks in this session. If the upcoming work is non-trivial, use TaskCreate to plan it before starting."}}'
fi

exit 0
