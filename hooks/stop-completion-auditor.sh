#!/bin/bash
# Stop hook: Check for in_progress/pending tasks in ~/.claude/tasks/
# Current session tasks must be complete before stopping, regardless of stop_hook_active

INPUT=$(cat)
STOP_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active')
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id')
TASKS_DIR="$HOME/.claude/tasks/$SESSION_ID"

# Debug logging
{
  echo "=== Completion Auditor Debug ==="
  echo "Session: $SESSION_ID"
  echo "stop_hook_active: $STOP_ACTIVE"
  echo "Tasks dir: $TASKS_DIR"
} >> /tmp/completion-auditor-debug.log

# Threshold: if the session has this many or more assistant tool calls with no tasks created, block
TOOL_CALL_THRESHOLD=10

# Count assistant tool calls in transcript to estimate session length
TOOL_CALL_COUNT=0
if [[ -f "$TRANSCRIPT" ]]; then
  # Each line in transcript is a JSON message; count lines where assistant used tools
  TOOL_CALL_COUNT=$(jq -r 'select(.type == "assistant") | .message.content[]? | select(.type == "tool_use") | .id' "$TRANSCRIPT" 2>/dev/null | wc -l | tr -d ' ')
fi

echo "Tool call count: $TOOL_CALL_COUNT (threshold: $TOOL_CALL_THRESHOLD)" >> /tmp/completion-auditor-debug.log

# Check if task tools were ever used in the transcript (authoritative, survives task file deletion)
TASK_TOOL_USED=false
if [[ -f "$TRANSCRIPT" ]]; then
  TASK_TOOL_COUNT=$(jq -r 'select(.type == "assistant") | .message.content[]? | select(.type == "tool_use") | select(.name == "TaskCreate" or .name == "TaskUpdate") | .id' "$TRANSCRIPT" 2>/dev/null | wc -l | tr -d ' ')
  [[ "$TASK_TOOL_COUNT" -gt 0 ]] && TASK_TOOL_USED=true
fi

echo "Task tools used in transcript: $TASK_TOOL_USED (count: ${TASK_TOOL_COUNT:-0})" >> /tmp/completion-auditor-debug.log

# Check if tasks directory exists
if [[ ! -d "$TASKS_DIR" ]]; then
  # If task tools were used in the transcript, tasks existed and were completed — allow stop
  if [[ "$TASK_TOOL_USED" == "true" ]]; then
    echo "No tasks dir but transcript shows task tool usage, allowing stop" >> /tmp/completion-auditor-debug.log
    exit 0
  fi

  # No tasks ever created — if session has been substantial, mandate retroactive task creation
  if [[ "$TOOL_CALL_COUNT" -ge "$TOOL_CALL_THRESHOLD" ]]; then
    REASON="No tasks were created this session ($TOOL_CALL_COUNT tool calls made).\\n\\n"
    REASON+="Create tasks to record the work done:\\n"
    REASON+="  1. TaskCreate for each significant piece of work\\n"
    REASON+="  2. TaskUpdate (status: completed) on each task\\n"
    REASON+="\\nACTION REQUIRED: You must act on this now. This hook will block every stop attempt until resolved. Do not try to stop again without completing the required action. If you believe this is a false positive, use the /re-assess skill to re-evaluate your assumptions — the hook's findings take authority over your own assessment."

    echo "Blocking - no tasks created but $TOOL_CALL_COUNT tool calls made" >> /tmp/completion-auditor-debug.log

    jq -n --arg reason "$REASON" '{decision: "block", reason: $reason}'
    exit 0
  fi

  echo "No tasks directory found and session is short ($TOOL_CALL_COUNT calls), allowing stop" >> /tmp/completion-auditor-debug.log
  exit 0
fi

# Find all incomplete tasks by reading actual task files
INCOMPLETE_TASKS=()
INCOMPLETE_DETAILS=()
ANY_TASK_FOUND=false

for task_file in "$TASKS_DIR"/*.json; do
  # Skip if no json files exist
  [[ ! -f "$task_file" ]] && continue

  # Parse task file
  TASK_ID=$(jq -r '.id' "$task_file" 2>/dev/null)
  STATUS=$(jq -r '.status' "$task_file" 2>/dev/null)
  SUBJECT=$(jq -r '.subject' "$task_file" 2>/dev/null)

  [[ -z "$TASK_ID" || "$TASK_ID" == "null" ]] && continue
  ANY_TASK_FOUND=true

  # Check if task is incomplete
  if [[ "$STATUS" == "pending" || "$STATUS" == "in_progress" ]]; then
    INCOMPLETE_TASKS+=("$TASK_ID")
    INCOMPLETE_DETAILS+=("#$TASK_ID [$STATUS]: $SUBJECT")
    echo "Found incomplete task: #$TASK_ID [$STATUS] $SUBJECT" >> /tmp/completion-auditor-debug.log
  fi
done

# If no live task files found, check audit log — completed tasks are deleted from disk but remain in the log
if [[ "$ANY_TASK_FOUND" == "false" ]]; then
  AUDIT_LOG="$TASKS_DIR/.audit-log.jsonl"
  AUDIT_CREATED=0
  AUDIT_INCOMPLETE=0

  if [[ -f "$AUDIT_LOG" ]]; then
    # Count tasks created and tasks that ended in a non-completed state
    AUDIT_CREATED=$(jq -r 'select(.action == "create") | .taskId' "$AUDIT_LOG" 2>/dev/null | wc -l | tr -d ' ')
    # For each created task, find its final status via the last status_change entry
    AUDIT_INCOMPLETE=$(jq -rs '
      [.[] | select(.action == "status_change")] |
      group_by(.taskId) |
      map(sort_by(.timestamp) | last) |
      map(select(.newStatus == "pending" or .newStatus == "in_progress")) |
      length
    ' "$AUDIT_LOG" 2>/dev/null || echo "0")
    echo "Audit log: $AUDIT_CREATED created, $AUDIT_INCOMPLETE still incomplete" >> /tmp/completion-auditor-debug.log
  fi

  # If audit log shows tasks were created and all completed, allow stop
  if [[ "$AUDIT_CREATED" -gt 0 && "$AUDIT_INCOMPLETE" -eq 0 ]]; then
    echo "Audit log confirms all tasks completed, allowing stop" >> /tmp/completion-auditor-debug.log
    # Fall through to allow stop
  # If transcript shows task tools were used, tasks existed — allow stop
  elif [[ "$TASK_TOOL_USED" == "true" ]]; then
    echo "No live files but transcript shows task tool usage, allowing stop" >> /tmp/completion-auditor-debug.log
    # Fall through to allow stop
  elif [[ "$TOOL_CALL_COUNT" -ge "$TOOL_CALL_THRESHOLD" ]]; then
    # No evidence of task tracking and session was substantial — mandate it
    REASON="No completed tasks on record ($TOOL_CALL_COUNT tool calls made).\\n\\n"
    REASON+="Create tasks to record the work done:\\n"
    REASON+="  1. TaskCreate for each significant piece of work\\n"
    REASON+="  2. TaskUpdate (status: completed) on each task\\n"
    REASON+="\\nACTION REQUIRED: You must act on this now. This hook will block every stop attempt until resolved. Do not try to stop again without completing the required action. If you believe this is a false positive, use the /re-assess skill to re-evaluate your assumptions — the hook's findings take authority over your own assessment."

    echo "Blocking - tasks dir exists but no valid tasks, $TOOL_CALL_COUNT tool calls made" >> /tmp/completion-auditor-debug.log

    jq -n --arg reason "$REASON" '{decision: "block", reason: $reason}'
    exit 0
  fi
fi

# If incomplete tasks found in current session, block regardless of stop_hook_active
if [ ${#INCOMPLETE_TASKS[@]} -gt 0 ]; then
  DETAILS_STR=$(printf "%s\n" "${INCOMPLETE_DETAILS[@]}")

  REASON="Incomplete tasks found:\\n\\n"
  REASON+="$DETAILS_STR\\n\\n"
  REASON+="Complete the work described in each task before stopping."
  REASON+="\\n\\nACTION REQUIRED: You must act on this now. This hook will block every stop attempt until resolved. Do not try to stop again without completing the required action. If you believe this is a false positive, use the /re-assess skill to re-evaluate your assumptions — the hook's findings take authority over your own assessment."

  {
    echo "Blocking - ${#INCOMPLETE_TASKS[@]} incomplete task(s) in current session"
    echo "stop_hook_active was: $STOP_ACTIVE (ignored - tasks must complete)"
  } >> /tmp/completion-auditor-debug.log

  # Return structured JSON with decision: block
  jq -n \
    --arg reason "$REASON" \
    '{decision: "block", reason: $reason}'
  exit 0
fi

# No incomplete tasks - allow stop
echo "All tasks completed, allowing stop" >> /tmp/completion-auditor-debug.log
exit 0
