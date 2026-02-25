#!/bin/bash
# Stop hook: Block stop if current branch has unpushed commits

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id')

# Debug logging
{
  echo "=== Git Push Stop Hook Debug ==="
  echo "CWD: $CWD"
} >> /tmp/stop-git-push-debug.log

# Check if this is a git repository
cd "$CWD" || exit 0

if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "Not a git repository, allowing stop" >> /tmp/stop-git-push-debug.log
  exit 0
fi

# Get current branch
CURRENT_BRANCH=$(git branch --show-current 2>/dev/null)

# Skip if detached HEAD
if [[ -z "$CURRENT_BRANCH" ]]; then
  echo "Detached HEAD, allowing stop" >> /tmp/stop-git-push-debug.log
  exit 0
fi

# Check if there's a remote configured
if ! git remote get-url origin > /dev/null 2>&1; then
  echo "No remote 'origin' configured, allowing stop" >> /tmp/stop-git-push-debug.log
  exit 0
fi

# Check if the branch has an upstream tracking branch
UPSTREAM=$(git rev-parse --abbrev-ref "@{upstream}" 2>/dev/null)
if [[ -z "$UPSTREAM" ]]; then
  echo "No upstream tracking branch for $CURRENT_BRANCH, allowing stop" >> /tmp/stop-git-push-debug.log
  exit 0
fi

# Count commits ahead of and behind remote
AHEAD=$(git rev-list --count "@{upstream}..HEAD" 2>/dev/null)
AHEAD_EXIT=$?
BEHIND=$(git rev-list --count "HEAD..@{upstream}" 2>/dev/null)
BEHIND_EXIT=$?

{
  echo "Branch: $CURRENT_BRANCH"
  echo "Upstream: $UPSTREAM"
  echo "Commits ahead: $AHEAD (exit: $AHEAD_EXIT)"
  echo "Commits behind: $BEHIND (exit: $BEHIND_EXIT)"
} >> /tmp/stop-git-push-debug.log

# If rev-list failed, allow stop (don't block on git errors)
if [[ "$AHEAD_EXIT" -ne 0 || "$BEHIND_EXIT" -ne 0 ]]; then
  echo "Failed to count commits, allowing stop" >> /tmp/stop-git-push-debug.log
  exit 0
fi

# Block if branch is behind remote — must pull before pushing
if [[ "$BEHIND" -gt 0 ]]; then
  if [[ "$AHEAD" -gt 0 ]]; then
    REASON="Branch '$CURRENT_BRANCH' has diverged from '$UPSTREAM'.\n\n"
    REASON+="  $AHEAD local commit(s) not yet pushed\n"
    REASON+="  $BEHIND remote commit(s) not yet pulled\n\n"
  else
    REASON="Branch '$CURRENT_BRANCH' is $BEHIND commit(s) behind '$UPSTREAM'.\n\n"
  fi
  REASON+="Run: git pull --rebase --autostash\n\n"
  REASON+="If conflicts arise during the rebase, use the /resolve-conflicts skill to resolve them, then push with /push.\n"
  REASON+="\n\nACTION REQUIRED: You must act on this now. This hook will block every stop attempt until resolved. Do not try to stop again without completing the required action. If you believe this is a false positive, use the /re-assess skill to re-evaluate your assumptions — the hook's findings take authority over your own assessment."

  echo "Blocking - $BEHIND commit(s) behind $UPSTREAM" >> /tmp/stop-git-push-debug.log

  # Create a task (once per session)
  TASK_SENTINEL="/tmp/stop-git-push-behind-task-created-${SESSION_ID}.flag"
  if [[ -n "$SESSION_ID" && "$SESSION_ID" != "null" && ! -f "$TASK_SENTINEL" ]]; then
    TASK_DESC="Branch '$CURRENT_BRANCH' is $BEHIND commit(s) behind '$UPSTREAM'. Run: git pull --rebase --autostash. If conflicts arise, use /resolve-conflicts. Then push with /push."
    bun "$HOME/.claude/hooks/tasks-list.ts" --session "$SESSION_ID" --create \
      "Pull remote changes before pushing" "$TASK_DESC" 2>/dev/null || true
    touch "$TASK_SENTINEL"
    echo "Created task for behind commits" >> /tmp/stop-git-push-debug.log
  fi

  jq -n \
    --arg reason "$REASON" \
    '{decision: "block", reason: $reason}'
  exit 0
fi

# Block if branch has unpushed commits
if [[ "$AHEAD" -gt 0 ]]; then
  REASON="Unpushed commits detected on branch '$CURRENT_BRANCH'.\n\n"
  REASON+="$AHEAD commit(s) ahead of '$UPSTREAM'.\n\n"
  REASON+="Use the /push skill to push your changes before stopping."
  REASON+="\n\nACTION REQUIRED: You must act on this now. This hook will block every stop attempt until resolved. Do not try to stop again without completing the required action. If you believe this is a false positive, use the /re-assess skill to re-evaluate your assumptions — the hook's findings take authority over your own assessment."

  echo "Blocking - $AHEAD unpushed commit(s) on $CURRENT_BRANCH" >> /tmp/stop-git-push-debug.log

  # Create a task (once per session)
  TASK_SENTINEL="/tmp/stop-git-push-task-created-${SESSION_ID}.flag"
  if [[ -n "$SESSION_ID" && "$SESSION_ID" != "null" && ! -f "$TASK_SENTINEL" ]]; then
    TASK_DESC="Branch '$CURRENT_BRANCH' has $AHEAD unpushed commit(s) ahead of '$UPSTREAM'. Use the /push skill to push your changes to the remote before stopping."
    bun "$HOME/.claude/hooks/tasks-list.ts" --session "$SESSION_ID" --create \
      "Push branch to remote" "$TASK_DESC" 2>/dev/null || true
    touch "$TASK_SENTINEL"
    echo "Created task for unpushed commits" >> /tmp/stop-git-push-debug.log
  fi

  jq -n \
    --arg reason "$REASON" \
    '{decision: "block", reason: $reason}'
  exit 0
fi

echo "Branch is up to date with remote, allowing stop" >> /tmp/stop-git-push-debug.log
exit 0
