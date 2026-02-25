#!/bin/bash
# Stop hook: Block stop if git repository has uncommitted changes

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id')

# Debug logging
{
  echo "=== Git Status Stop Hook Debug ==="
  echo "CWD: $CWD"
} >> /tmp/stop-git-status-debug.log

# Check if this is a git repository
cd "$CWD" || exit 0

if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "Not a git repository, allowing stop" >> /tmp/stop-git-status-debug.log
  exit 0
fi

# Check for uncommitted changes
GIT_STATUS=$(git status --porcelain 2>&1)
EXIT_CODE=$?

{
  echo "Git status exit code: $EXIT_CODE"
  echo "Git status output:"
  echo "$GIT_STATUS"
} >> /tmp/stop-git-status-debug.log

# If git status failed, allow stop (don't block on git errors)
if [[ "$EXIT_CODE" -ne 0 ]]; then
  echo "Git status failed, allowing stop" >> /tmp/stop-git-status-debug.log
  exit 0
fi

# If there are uncommitted changes, block stop
if [[ -n "$GIT_STATUS" ]]; then
  # Count files
  MODIFIED_COUNT=$(echo "$GIT_STATUS" | grep -c "^ M")
  ADDED_COUNT=$(echo "$GIT_STATUS" | grep -c "^A ")
  DELETED_COUNT=$(echo "$GIT_STATUS" | grep -c "^D ")
  UNTRACKED_COUNT=$(echo "$GIT_STATUS" | grep -c "^??")
  TOTAL_COUNT=$(echo "$GIT_STATUS" | wc -l | tr -d ' ')

  # Build status summary
  STATUS_SUMMARY=""
  [[ $MODIFIED_COUNT -gt 0 ]] && STATUS_SUMMARY+="$MODIFIED_COUNT modified, "
  [[ $ADDED_COUNT -gt 0 ]] && STATUS_SUMMARY+="$ADDED_COUNT added, "
  [[ $DELETED_COUNT -gt 0 ]] && STATUS_SUMMARY+="$DELETED_COUNT deleted, "
  [[ $UNTRACKED_COUNT -gt 0 ]] && STATUS_SUMMARY+="$UNTRACKED_COUNT untracked, "
  STATUS_SUMMARY=${STATUS_SUMMARY%, }  # Remove trailing comma

  REASON="Uncommitted changes detected in git repository.\n\n"
  REASON+="Status: $STATUS_SUMMARY ($TOTAL_COUNT file(s))\n\n"
  REASON+="Files with changes:\n"
  REASON+=$(echo "$GIT_STATUS" | head -20 | sed 's/^/  /')

  if [[ $(echo "$GIT_STATUS" | wc -l) -gt 20 ]]; then
    REASON+="\n  ... and $(($(echo "$GIT_STATUS" | wc -l) - 20)) more file(s)"
  fi

  REASON+="\n\nUse the /commit skill to review and commit your changes before stopping."
  REASON+="\n\nACTION REQUIRED: You must act on this now. This hook will block every stop attempt until resolved. Do not try to stop again without completing the required action. If you believe this is a false positive, use the /re-assess skill to re-evaluate your assumptions — the hook's findings take authority over your own assessment."

  echo "Blocking - $TOTAL_COUNT uncommitted file(s)" >> /tmp/stop-git-status-debug.log

  # Create a task in the session task list (once per session, using sentinel file)
  TASK_SENTINEL="/tmp/stop-git-status-task-created-${SESSION_ID}.flag"
  if [[ -n "$SESSION_ID" && "$SESSION_ID" != "null" && ! -f "$TASK_SENTINEL" ]]; then
    TASK_DESC="Git repository at $CWD has uncommitted changes ($STATUS_SUMMARY). Use the /commit skill to stage and commit your changes before stopping."
    bun "$HOME/.claude/hooks/tasks-list.ts" --session "$SESSION_ID" --create \
      "Commit uncommitted changes" "$TASK_DESC" 2>/dev/null || true
    touch "$TASK_SENTINEL"
    echo "Created task for uncommitted changes" >> /tmp/stop-git-status-debug.log
  fi

  # Return structured JSON with decision: block
  jq -n \
    --arg reason "$REASON" \
    '{decision: "block", reason: $reason}'
  exit 0
fi

echo "No uncommitted changes, allowing stop" >> /tmp/stop-git-status-debug.log
exit 0
