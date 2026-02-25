#!/bin/bash
# Stop hook: Block stop if current branch has conflicts with origin/main
# Checks both GitHub PR merge state (authoritative) and local merge-tree (fallback)

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd')

LOG=/tmp/stop-branch-conflicts-debug.log

{
  echo "=== Branch Conflicts Stop Hook Debug ==="
  echo "CWD: $CWD"
} >> "$LOG"

cd "$CWD" || exit 0

# Must be a git repository
if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "Not a git repository, allowing stop" >> "$LOG"
  exit 0
fi

# Get current branch
CURRENT_BRANCH=$(git branch --show-current 2>/dev/null)

# Skip if detached HEAD
if [[ -z "$CURRENT_BRANCH" ]]; then
  echo "Detached HEAD, allowing stop" >> "$LOG"
  exit 0
fi

# Skip if on main or master — this check is for feature branches only
if [[ "$CURRENT_BRANCH" == "main" || "$CURRENT_BRANCH" == "master" ]]; then
  echo "On $CURRENT_BRANCH, skipping conflict check" >> "$LOG"
  exit 0
fi

# --- GitHub PR merge state check (authoritative, catches stale local refs) ---
if command -v gh > /dev/null 2>&1; then
  PR_JSON=$(gh pr view "$CURRENT_BRANCH" --json mergeable,mergeStateStatus,state,number,url 2>/dev/null || true)

  if [[ -n "$PR_JSON" ]]; then
    PR_STATE=$(echo "$PR_JSON" | jq -r '.state')
    PR_MERGEABLE=$(echo "$PR_JSON" | jq -r '.mergeable')
    PR_MERGE_STATUS=$(echo "$PR_JSON" | jq -r '.mergeStateStatus')
    PR_NUMBER=$(echo "$PR_JSON" | jq -r '.number')
    PR_URL=$(echo "$PR_JSON" | jq -r '.url')

    {
      echo "GitHub PR #$PR_NUMBER: state=$PR_STATE mergeable=$PR_MERGEABLE mergeStateStatus=$PR_MERGE_STATUS"
    } >> "$LOG"

    # Only check open PRs
    if [[ "$PR_STATE" == "OPEN" && "$PR_MERGEABLE" == "CONFLICTING" ]]; then
      REASON="PR #$PR_NUMBER for branch '$CURRENT_BRANCH' has merge conflicts (GitHub: mergeable=CONFLICTING, mergeStateStatus=$PR_MERGE_STATUS).\\n\\n"
      REASON+="$PR_URL\\n\\n"
      REASON+="Use the /rebase-onto-main skill to rebase and resolve conflicts before stopping."
      REASON+="\\n\\nACTION REQUIRED: You must act on this now. This hook will block every stop attempt until resolved. Do not try to stop again without completing the required action. If you believe this is a false positive, use the /re-assess skill to re-evaluate your assumptions — the hook's findings take authority over your own assessment."

      echo "Blocking - GitHub reports PR #$PR_NUMBER as CONFLICTING" >> "$LOG"

      jq -n --arg reason "$REASON" '{decision: "block", reason: $reason}'
      exit 0
    fi

    # If GitHub says it's clean, trust it — skip local merge-tree
    if [[ "$PR_STATE" == "OPEN" && "$PR_MERGEABLE" == "MERGEABLE" ]]; then
      echo "GitHub says PR #$PR_NUMBER is MERGEABLE, allowing stop" >> "$LOG"
      exit 0
    fi
  else
    echo "No PR found for branch '$CURRENT_BRANCH', falling back to local check" >> "$LOG"
  fi
else
  echo "gh CLI not available, falling back to local check" >> "$LOG"
fi

# --- Local merge-tree check (fallback for branches without PRs) ---

# Check if origin/main ref exists locally
if ! git rev-parse origin/main > /dev/null 2>&1; then
  echo "origin/main not available locally, allowing stop" >> "$LOG"
  exit 0
fi

# Check if origin/main has commits not yet in our branch
BEHIND=$(git rev-list --count "HEAD..origin/main" 2>/dev/null)

{
  echo "Branch: $CURRENT_BRANCH"
  echo "Commits behind origin/main: $BEHIND"
} >> "$LOG"

if [[ -z "$BEHIND" || "$BEHIND" -eq 0 ]]; then
  echo "Branch is up to date with origin/main, no conflicts possible" >> "$LOG"
  exit 0
fi

# Use merge-tree to detect conflicts without touching the working tree
MERGE_BASE=$(git merge-base HEAD origin/main 2>/dev/null)
if [[ -z "$MERGE_BASE" ]]; then
  echo "Could not determine merge base, allowing stop" >> "$LOG"
  exit 0
fi

MERGE_TREE_OUTPUT=$(git merge-tree "$MERGE_BASE" HEAD origin/main 2>/dev/null)
CONFLICT_COUNT=$(echo "$MERGE_TREE_OUTPUT" | grep -c "^<<<<<<" || true)

{
  echo "Merge base: $MERGE_BASE"
  echo "Conflict markers found: $CONFLICT_COUNT"
} >> "$LOG"

if [[ "$CONFLICT_COUNT" -gt 0 ]]; then
  REASON="Branch '$CURRENT_BRANCH' has conflicts with origin/main.\\n\\n"
  REASON+="$CONFLICT_COUNT conflict(s) detected — $BEHIND commit(s) on origin/main not yet in this branch.\\n\\n"
  REASON+="Use the /rebase-onto-main skill to rebase and resolve conflicts before stopping."
  REASON+="\\n\\nACTION REQUIRED: You must act on this now. This hook will block every stop attempt until resolved. Do not try to stop again without completing the required action. If you believe this is a false positive, use the /re-assess skill to re-evaluate your assumptions — the hook's findings take authority over your own assessment."

  echo "Blocking - $CONFLICT_COUNT conflict(s) with origin/main" >> "$LOG"

  jq -n --arg reason "$REASON" '{decision: "block", reason: $reason}'
  exit 0
fi

echo "No conflicts with origin/main ($BEHIND commit(s) behind but no conflicts), allowing stop" >> "$LOG"
exit 0
