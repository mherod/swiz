#!/bin/bash
# Stop hook: Block stop if GitHub CI checks are pending or failing

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd')

LOG=/tmp/stop-github-ci-debug.log

{
  echo "=== GitHub CI Stop Hook Debug ==="
  echo "CWD: $CWD"
} >> "$LOG"

cd "$CWD" || exit 0

# Must be a git repository
if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "Not a git repository, allowing stop" >> "$LOG"
  exit 0
fi

# Must have gh CLI
if ! command -v gh &> /dev/null; then
  echo "gh CLI not available, allowing stop" >> "$LOG"
  exit 0
fi

# Must have a GitHub remote
if ! git remote get-url origin 2>/dev/null | grep -q "github.com"; then
  echo "Not a GitHub repository, allowing stop" >> "$LOG"
  exit 0
fi

# Get current branch
CURRENT_BRANCH=$(git branch --show-current 2>/dev/null)
if [[ -z "$CURRENT_BRANCH" ]]; then
  echo "Detached HEAD, allowing stop" >> "$LOG"
  exit 0
fi

{
  echo "Branch: $CURRENT_BRANCH"
} >> "$LOG"

# Fetch the most recent run for this branch
RUN_DATA=$(gh run list \
  --branch "$CURRENT_BRANCH" \
  --limit 5 \
  --json databaseId,status,conclusion,displayTitle,workflowName,createdAt,event \
  2>/dev/null)

if [[ $? -ne 0 || -z "$RUN_DATA" || "$RUN_DATA" == "[]" ]]; then
  echo "No CI runs found for branch $CURRENT_BRANCH, allowing stop" >> "$LOG"
  exit 0
fi

{
  echo "Run data:"
  echo "$RUN_DATA" | jq '.'
} >> "$LOG"

# Exclude runs triggered by event "dynamic" — GitHub-internal automated runs
# (Dependabot, CodeQL setup, etc.) that are not triggered by project code changes.
# Also exclude "workflow_run" events — these are downstream reactions to PR CI completions
# (e.g. Claude Code Review triggering after a PR's CI finishes). On the main branch, GitHub
# reports these with headBranch=main even though they are reviewing a PR branch, which
# causes false positives. Only "push" and "pull_request" events represent direct CI on this branch.
RELEVANT_RUNS=$(echo "$RUN_DATA" | jq '[.[] | select(.event != "dynamic" and .event != "workflow_run")]')

# Check for in-progress or queued runs
ACTIVE_COUNT=$(echo "$RELEVANT_RUNS" | jq '[.[] | select(.status == "in_progress" or .status == "queued")] | length')
ACTIVE_NAMES=$(echo "$RELEVANT_RUNS" | jq -r '[.[] | select(.status == "in_progress" or .status == "queued") | "\(.workflowName) (\(.status))"] | join(", ")')

# Check for failing runs (only the most recent run per workflow matters)
# Group by workflowName, take the most recent of each, then filter for failures
FAILING_COUNT=$(echo "$RELEVANT_RUNS" | jq '[group_by(.workflowName)[] | sort_by(.createdAt) | last] | [.[] | select(.status == "completed" and (.conclusion == "failure" or .conclusion == "timed_out" or .conclusion == "action_required"))] | length')
FAILING_NAMES=$(echo "$RELEVANT_RUNS" | jq -r '[group_by(.workflowName)[] | sort_by(.createdAt) | last] | [.[] | select(.status == "completed" and (.conclusion == "failure" or .conclusion == "timed_out" or .conclusion == "action_required")) | "\(.workflowName) (\(.conclusion))"] | join(", ")')
FAILING_IDS=$(echo "$RELEVANT_RUNS" | jq -r '[group_by(.workflowName)[] | sort_by(.createdAt) | last] | [.[] | select(.status == "completed" and (.conclusion == "failure" or .conclusion == "timed_out" or .conclusion == "action_required")) | .databaseId | tostring] | .[]')

{
  echo "Active runs: $ACTIVE_COUNT ($ACTIVE_NAMES)"
  echo "Failing runs: $FAILING_COUNT ($FAILING_NAMES)"
} >> "$LOG"

if [[ "$FAILING_COUNT" -gt 0 ]]; then
  REASON="GitHub CI is failing on branch '$CURRENT_BRANCH'.\n\n"
  REASON+="Failing checks ($FAILING_COUNT): $FAILING_NAMES\n\n"
  REASON+="To view failure logs:\n"
  while IFS= read -r run_id; do
    REASON+="  gh run view $run_id --log-failed\n"
  done <<< "$FAILING_IDS"
  REASON+="\nUse the /ci-status skill to analyze failures and fix them before stopping."
  REASON+="\n\nACTION REQUIRED: You must act on this now. This hook will block every stop attempt until resolved. Do not try to stop again without completing the required action. If you believe this is a false positive, use the /re-assess skill to re-evaluate your assumptions — the hook's findings take authority over your own assessment."

  echo "Blocking - $FAILING_COUNT failing CI run(s)" >> "$LOG"

  jq -n --arg reason "$REASON" '{decision: "block", reason: $reason}'
  exit 0
fi

if [[ "$ACTIVE_COUNT" -gt 0 ]]; then
  REASON="GitHub CI is still running on branch '$CURRENT_BRANCH'.\n\n"
  REASON+="Active checks ($ACTIVE_COUNT): $ACTIVE_NAMES\n\n"
  REASON+="Wait for CI to complete, then check results with the /ci-status skill."
  REASON+="\n\nACTION REQUIRED: You must act on this now. This hook will block every stop attempt until resolved. Do not try to stop again without completing the required action. If you believe this is a false positive, use the /re-assess skill to re-evaluate your assumptions — the hook's findings take authority over your own assessment."

  echo "Blocking - $ACTIVE_COUNT active CI run(s)" >> "$LOG"

  jq -n --arg reason "$REASON" '{decision: "block", reason: $reason}'
  exit 0
fi

echo "CI is passing or neutral, allowing stop" >> "$LOG"
exit 0
