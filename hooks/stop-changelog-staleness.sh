#!/bin/bash
# Stop hook: Block stop if CHANGELOG.md hasn't been updated within 1 day of the last commit

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd')

LOG=/tmp/stop-changelog-staleness-debug.log

{
  echo "=== Changelog Staleness Stop Hook ==="
  echo "CWD: $CWD"
} >> "$LOG"

cd "$CWD" || exit 0

# Must be a git repo
if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "Not a git repo, allowing stop" >> "$LOG"
  exit 0
fi

# Find CHANGELOG.md — look in repo root first, then one level down
CHANGELOG_PATH=""
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [[ -f "$REPO_ROOT/CHANGELOG.md" ]]; then
  CHANGELOG_PATH="CHANGELOG.md"
else
  # Search for any CHANGELOG.md tracked by git
  CHANGELOG_PATH=$(git ls-files "$REPO_ROOT" | grep -i "^CHANGELOG\.md$" | head -1 || true)
fi

if [[ -z "$CHANGELOG_PATH" ]]; then
  echo "No CHANGELOG.md tracked by git, allowing stop" >> "$LOG"
  exit 0
fi

# Timestamp of the last commit to the repo (any file)
LAST_COMMIT_TIME=$(git log -1 --format="%ct" 2>/dev/null)
if [[ -z "$LAST_COMMIT_TIME" ]]; then
  echo "No commits found, allowing stop" >> "$LOG"
  exit 0
fi

# Timestamp of the last commit that touched CHANGELOG.md
CHANGELOG_COMMIT_TIME=$(git log -1 --format="%ct" -- "$CHANGELOG_PATH" 2>/dev/null)
if [[ -z "$CHANGELOG_COMMIT_TIME" ]]; then
  echo "CHANGELOG.md has never been committed, allowing stop" >> "$LOG"
  exit 0
fi

{
  echo "Last commit time:     $LAST_COMMIT_TIME ($(date -r "$LAST_COMMIT_TIME" 2>/dev/null || date -d @"$LAST_COMMIT_TIME" 2>/dev/null))"
  echo "Changelog last edit:  $CHANGELOG_COMMIT_TIME ($(date -r "$CHANGELOG_COMMIT_TIME" 2>/dev/null || date -d @"$CHANGELOG_COMMIT_TIME" 2>/dev/null))"
} >> "$LOG"

# Calculate gap in seconds (last commit is always >= changelog commit)
GAP=$(( LAST_COMMIT_TIME - CHANGELOG_COMMIT_TIME ))
ONE_DAY=86400

{
  echo "Gap: ${GAP}s (threshold: ${ONE_DAY}s)"
} >> "$LOG"

if (( GAP > ONE_DAY )); then
  DAYS=$(( GAP / 86400 ))
  HOURS=$(( (GAP % 86400) / 3600 ))

  REASON="CHANGELOG.md is stale — last updated ${DAYS}d ${HOURS}h before the most recent commit.\n\n"
  REASON+="The changelog must be kept current with every commit session.\n\n"
  REASON+="Run the /changelog skill to generate and update CHANGELOG.md, then commit the result.\n\n"
  REASON+="ACTION REQUIRED: You must act on this now. This hook will block every stop attempt until resolved. Do not try to stop again without completing the required action. If you believe this is a false positive, use the /re-assess skill to re-evaluate your assumptions — the hook's findings take authority over your own assessment."

  echo "Blocking — changelog is ${DAYS}d ${HOURS}h stale" >> "$LOG"

  # Create a task once per session so the agent has an explicit tracked item
  SESSION_ID=$(echo "$INPUT" | jq -r '.session_id')
  TASK_SENTINEL="/tmp/stop-changelog-staleness-task-created-${SESSION_ID}.flag"
  if [[ -n "$SESSION_ID" && "$SESSION_ID" != "null" && ! -f "$TASK_SENTINEL" ]]; then
    bun "$HOME/.claude/hooks/tasks-list.ts" --session "$SESSION_ID" --create \
      "Update CHANGELOG.md via /changelog skill" \
      "CHANGELOG.md is ${DAYS}d ${HOURS}h behind the latest commit. Run /changelog to regenerate and commit the updated changelog." 2>/dev/null || true
    touch "$TASK_SENTINEL"
  fi

  jq -n --arg reason "$REASON" '{decision: "block", reason: $reason}'
  exit 0
fi

echo "Changelog is current (gap ${GAP}s < ${ONE_DAY}s), allowing stop" >> "$LOG"
exit 0
