#!/bin/bash
# Stop hook: Block stop if open PR has empty or placeholder description

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd')

LOG=/tmp/stop-pr-description-debug.log

{
  echo "=== PR Description Stop Hook Debug ==="
  echo "CWD: $CWD"
} >> "$LOG"

cd "$CWD" || exit 0

if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "Not a git repo, allowing stop" >> "$LOG"
  exit 0
fi

if ! command -v gh &> /dev/null; then
  echo "gh CLI not available, allowing stop" >> "$LOG"
  exit 0
fi

if ! git remote get-url origin 2>/dev/null | grep -q "github.com"; then
  echo "Not a GitHub repo, allowing stop" >> "$LOG"
  exit 0
fi

CURRENT_BRANCH=$(git branch --show-current 2>/dev/null)
if [[ -z "$CURRENT_BRANCH" || "$CURRENT_BRANCH" == "main" || "$CURRENT_BRANCH" == "master" ]]; then
  echo "On $CURRENT_BRANCH or detached HEAD, skipping PR description check" >> "$LOG"
  exit 0
fi

# Find open PR for this branch
PR_DATA=$(gh pr list --head "$CURRENT_BRANCH" --state open --json number,title,body 2>/dev/null)
PR_NUMBER=$(echo "$PR_DATA" | jq -r '.[0].number // empty')

if [[ -z "$PR_NUMBER" ]]; then
  echo "No open PR for $CURRENT_BRANCH, allowing stop" >> "$LOG"
  exit 0
fi

PR_TITLE=$(echo "$PR_DATA" | jq -r '.[0].title // ""')
PR_BODY=$(echo "$PR_DATA" | jq -r '.[0].body // ""')

{
  echo "PR #$PR_NUMBER: $PR_TITLE"
  echo "Body length: ${#PR_BODY}"
  echo "Body preview: ${PR_BODY:0:100}"
} >> "$LOG"

# Check if body is empty or whitespace only
BODY_STRIPPED=$(echo "$PR_BODY" | tr -d '[:space:]')
if [[ -z "$BODY_STRIPPED" ]]; then
  REASON="PR #$PR_NUMBER ('$PR_TITLE') has an empty description.\n\n"
  REASON+="Use the /refine-pr skill to populate the PR description before stopping."
  REASON+="\n\nACTION REQUIRED: You must act on this now. This hook will block every stop attempt until resolved. Do not try to stop again without completing the required action. If you believe this is a false positive, use the /re-assess skill to re-evaluate your assumptions — the hook's findings take authority over your own assessment."

  echo "Blocking - PR body is empty" >> "$LOG"
  jq -n --arg reason "$REASON" '{decision: "block", reason: $reason}'
  exit 0
fi

# Check for ## Summary immediately followed by a placeholder on the next non-blank line.
# NOTE: BSD grep -F does not support multiline patterns correctly — it splits on newlines
# and treats each line as a separate OR pattern, causing false positives on any PR that
# contains "## Summary" (even with real content). Use grep -A1 instead.
if echo "$PR_BODY" | grep -A1 "^## Summary" | grep -qi "^<"; then
  REASON="PR #$PR_NUMBER ('$PR_TITLE') still contains template placeholder text.\n\n"
  REASON+="Replace the '<...>' placeholder under '## Summary' with actual content before stopping."
  REASON+="\n\nACTION REQUIRED: You must act on this now. This hook will block every stop attempt until resolved. Do not try to stop again without completing the required action. If you believe this is a false positive, use the /re-assess skill to re-evaluate your assumptions — the hook's findings take authority over your own assessment."

  echo "Blocking - PR body has unfilled placeholder after ## Summary" >> "$LOG"
  jq -n --arg reason "$REASON" '{decision: "block", reason: $reason}'
  exit 0
fi

# Check for other single-line placeholder patterns
PLACEHOLDER_PATTERNS=(
  "Describe your changes"
  "What does this PR do"
  "<!-- "
  "Add a description"
  "\[Add description\]"
  "Your description here"
)

for pattern in "${PLACEHOLDER_PATTERNS[@]}"; do
  if echo "$PR_BODY" | grep -qiF "$pattern" 2>/dev/null; then
    REASON="PR #$PR_NUMBER ('$PR_TITLE') still contains template placeholder text.\n\n"
    REASON+="Use the /refine-pr skill to populate the PR description before stopping."
    REASON+="\n\nACTION REQUIRED: You must act on this now. This hook will block every stop attempt until resolved. Do not try to stop again without completing the required action. If you believe this is a false positive, use the /re-assess skill to re-evaluate your assumptions — the hook's findings take authority over your own assessment."

    echo "Blocking - PR body contains placeholder: $pattern" >> "$LOG"
    jq -n --arg reason "$REASON" '{decision: "block", reason: $reason}'
    exit 0
  fi
done

# Enforce minimum meaningful length (less than 20 chars is too thin)
if [[ "${#BODY_STRIPPED}" -lt 20 ]]; then
  REASON="PR #$PR_NUMBER ('$PR_TITLE') description is too short (${#BODY_STRIPPED} chars).\n\n"
  REASON+="Use the /refine-pr skill to populate the PR description before stopping."
  REASON+="\n\nACTION REQUIRED: You must act on this now. This hook will block every stop attempt until resolved. Do not try to stop again without completing the required action. If you believe this is a false positive, use the /re-assess skill to re-evaluate your assumptions — the hook's findings take authority over your own assessment."

  echo "Blocking - PR body too short: ${#BODY_STRIPPED} chars" >> "$LOG"
  jq -n --arg reason "$REASON" '{decision: "block", reason: $reason}'
  exit 0
fi

echo "PR #$PR_NUMBER description looks good, allowing stop" >> "$LOG"
exit 0
