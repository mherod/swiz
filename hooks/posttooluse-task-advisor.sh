#!/bin/bash
# PostToolUse hook: Remind agents to create/update tasks regularly
# Provides countdown hints showing remaining calls until mandatory enforcement
# Uses transcript scan (no external state) to determine position

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty')

# Can't check without session ID or transcript
[[ -z "$SESSION_ID" || -z "$TRANSCRIPT" || ! -f "$TRANSCRIPT" ]] && exit 0

# Count tool calls and distance from last task tool in transcript
STATS=$(jq -sr '
  [.[] | select(.type == "assistant") | .message.content[]? | select(.type == "tool_use") | .name] |
  {
    total: length,
    calls_since_task: (
      length - 1 - (
        to_entries |
        map(select(.value == "TaskCreate" or .value == "TaskUpdate" or .value == "TaskList" or .value == "TaskGet" or .value == "TodoWrite")) |
        last.key // -1
      )
    )
  }
' "$TRANSCRIPT" 2>/dev/null)

TOTAL=$(echo "$STATS" | jq -r '.total // 0')
CALLS_SINCE=$(echo "$STATS" | jq -r '.calls_since_task // 0')

# Thresholds must match pretooluse-require-tasks.sh
CREATION_THRESHOLD=5
STALENESS_THRESHOLD=10

# --- No tasks ever created: countdown to mandatory creation ---
NEVER_CREATED=false
if [[ "$CALLS_SINCE" -ge "$TOTAL" ]]; then
  NEVER_CREATED=true
  REMAINING=$((CREATION_THRESHOLD - TOTAL))

  if [[ "$REMAINING" -le 0 ]]; then
    # Already past threshold — PreToolUse will block, no need to advise
    exit 0
  elif [[ "$REMAINING" -le 1 ]]; then
    printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"TaskCreate required in %d tool call(s) — tools will be blocked until tasks are defined."}}' "$REMAINING"
  elif [[ "$REMAINING" -le 3 ]]; then
    printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"TaskCreate required in %d tool calls. Plan your tasks now to avoid interruption."}}' "$REMAINING"
  elif [[ "$TOTAL" -ge 2 ]]; then
    printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"%d/%d tool calls before TaskCreate is required."}}' "$TOTAL" "$CREATION_THRESHOLD"
  fi
  exit 0
fi

# --- Tasks exist: countdown to staleness enforcement ---
STALE_REMAINING=$((STALENESS_THRESHOLD - CALLS_SINCE))

if [[ "$STALE_REMAINING" -le 0 ]]; then
  # Already past threshold — PreToolUse will block
  exit 0
elif [[ "$STALE_REMAINING" -le 2 ]]; then
  printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"Task update required in %d tool call(s) — tools will be blocked until tasks are reviewed."}}' "$STALE_REMAINING"
elif [[ "$STALE_REMAINING" -le 4 ]]; then
  printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"Task update due in %d tool calls. Review progress — mark completed tasks done or create new ones."}}' "$STALE_REMAINING"
fi

exit 0
