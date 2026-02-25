#!/bin/bash
# Stop hook: Block stop if current branch has CHANGES_REQUESTED reviews

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd')

# Debug logging
{
  echo "=== PR Changes Requested Stop Hook Debug ==="
  echo "CWD: $CWD"
} >> /tmp/stop-pr-changes-requested-debug.log

# Check if this is a git repository
cd "$CWD" || exit 0

if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "Not a git repository, allowing stop" >> /tmp/stop-pr-changes-requested-debug.log
  exit 0
fi

# Check if gh CLI is available
if ! command -v gh &> /dev/null; then
  echo "gh CLI not available, allowing stop" >> /tmp/stop-pr-changes-requested-debug.log
  exit 0
fi

# Get current branch
CURRENT_BRANCH=$(git branch --show-current 2>/dev/null)

# Skip if no current branch (detached HEAD)
if [[ -z "$CURRENT_BRANCH" ]]; then
  echo "Detached HEAD or no current branch, allowing stop" >> /tmp/stop-pr-changes-requested-debug.log
  exit 0
fi

{
  echo "Current branch: $CURRENT_BRANCH"
} >> /tmp/stop-pr-changes-requested-debug.log

# Skip if on main/master branch
if [[ "$CURRENT_BRANCH" == "main" || "$CURRENT_BRANCH" == "master" ]]; then
  echo "On main/master branch, skipping PR check" >> /tmp/stop-pr-changes-requested-debug.log
  exit 0
fi

# Check if there's a GitHub remote
if ! git remote get-url origin 2>/dev/null | grep -q "github.com"; then
  echo "Not a GitHub repository, allowing stop" >> /tmp/stop-pr-changes-requested-debug.log
  exit 0
fi

# Find PR for current branch
PR_DATA=$(gh pr list --head "$CURRENT_BRANCH" --state open --json number,title 2>/dev/null)
if [[ $? -ne 0 || -z "$PR_DATA" ]]; then
  echo "Failed to query PRs or no PR data, allowing stop" >> /tmp/stop-pr-changes-requested-debug.log
  exit 0
fi

PR_NUMBER=$(echo "$PR_DATA" | jq -r '.[0].number // empty' 2>/dev/null)
if [[ -z "$PR_NUMBER" ]]; then
  echo "No open PR for branch $CURRENT_BRANCH, allowing stop" >> /tmp/stop-pr-changes-requested-debug.log
  exit 0
fi

{
  echo "Found PR #$PR_NUMBER for branch $CURRENT_BRANCH"
} >> /tmp/stop-pr-changes-requested-debug.log

# Get repository name
REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null)
if [[ -z "$REPO" ]]; then
  echo "Failed to get repository name, allowing stop" >> /tmp/stop-pr-changes-requested-debug.log
  exit 0
fi

# Get PR reviews
REVIEWS=$(gh api "repos/$REPO/pulls/$PR_NUMBER/reviews" 2>/dev/null)
if [[ $? -ne 0 ]]; then
  echo "Failed to fetch PR reviews, allowing stop" >> /tmp/stop-pr-changes-requested-debug.log
  exit 0
fi

# Check for CHANGES_REQUESTED reviews
CHANGES_REQUESTED=$(echo "$REVIEWS" | jq -r '[.[] | select(.state == "CHANGES_REQUESTED")] | length' 2>/dev/null)
if [[ -z "$CHANGES_REQUESTED" || "$CHANGES_REQUESTED" == "null" ]]; then
  CHANGES_REQUESTED=0
fi

{
  echo "CHANGES_REQUESTED reviews: $CHANGES_REQUESTED"
} >> /tmp/stop-pr-changes-requested-debug.log

if [[ "$CHANGES_REQUESTED" -gt 0 ]]; then
  # Get details of requested changes
  REVIEWERS=$(echo "$REVIEWS" | jq -r '[.[] | select(.state == "CHANGES_REQUESTED") | .user.login] | unique | join(", ")')
  REVIEW_DETAILS=$(echo "$REVIEWS" | jq -r '.[] | select(.state == "CHANGES_REQUESTED") | "- @\(.user.login): \(.body // "No comment provided")"' | head -5)

  REASON="PR #$PR_NUMBER has changes requested from reviewers.\n\n"
  REASON+="Reviewers: $REVIEWERS\n\n"
  REASON+="Requested changes:\n$REVIEW_DETAILS\n\n"
  REASON+="Use the /pr-comments-address skill to address all feedback before stopping."
  REASON+="\n\nACTION REQUIRED: You must act on this now. This hook will block every stop attempt until resolved. Do not try to stop again without completing the required action. If you believe this is a false positive, use the /re-assess skill to re-evaluate your assumptions — the hook's findings take authority over your own assessment."

  echo "Blocking - $CHANGES_REQUESTED CHANGES_REQUESTED review(s) on PR #$PR_NUMBER" >> /tmp/stop-pr-changes-requested-debug.log

  # Return structured JSON with decision: block
  jq -n \
    --arg reason "$REASON" \
    '{decision: "block", reason: $reason}'
  exit 0
fi

echo "No CHANGES_REQUESTED reviews, allowing stop" >> /tmp/stop-pr-changes-requested-debug.log
exit 0
