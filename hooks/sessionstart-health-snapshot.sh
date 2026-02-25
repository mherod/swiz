#!/bin/bash
# SessionStart hook: Inject project health snapshot as additionalContext

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')

[[ -z "$CWD" ]] && exit 0
cd "$CWD" || exit 0

# Must be a git repo with a GitHub remote
if ! git rev-parse --git-dir > /dev/null 2>&1; then exit 0; fi
if ! git remote get-url origin 2>/dev/null | grep -q "github.com"; then exit 0; fi

CONTEXT=""

# Git status summary
UNCOMMITTED=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
BRANCH=$(git branch --show-current 2>/dev/null)
AHEAD=$(git rev-list --count "@{upstream}..HEAD" 2>/dev/null || echo "?")

CONTEXT+="Git: branch=$BRANCH, uncommitted=$UNCOMMITTED, unpushed=$AHEAD. "

# Open PRs (fast, limit output)
if command -v gh &> /dev/null; then
  OPEN_PRS=$(gh pr list --state open --limit 5 --json number,title,reviewDecision 2>/dev/null)
  PR_COUNT=$(echo "$OPEN_PRS" | jq 'length' 2>/dev/null || echo 0)

  if [[ "$PR_COUNT" -gt 0 ]]; then
    CHANGES_REQ=$(echo "$OPEN_PRS" | jq '[.[] | select(.reviewDecision == "CHANGES_REQUESTED")] | length' 2>/dev/null || echo 0)
    CONTEXT+="PRs: $PR_COUNT open"
    [[ "$CHANGES_REQ" -gt 0 ]] && CONTEXT+=", $CHANGES_REQ need changes"
    CONTEXT+=". "
  fi

  # Latest CI on current branch
  if [[ -n "$BRANCH" ]]; then
    LATEST_RUN=$(gh run list --branch "$BRANCH" --limit 1 --json status,conclusion,workflowName 2>/dev/null)
    RUN_STATUS=$(echo "$LATEST_RUN" | jq -r '.[0].status // ""' 2>/dev/null)
    RUN_CONCLUSION=$(echo "$LATEST_RUN" | jq -r '.[0].conclusion // ""' 2>/dev/null)
    RUN_WORKFLOW=$(echo "$LATEST_RUN" | jq -r '.[0].workflowName // ""' 2>/dev/null)

    if [[ -n "$RUN_STATUS" ]]; then
      if [[ "$RUN_STATUS" == "completed" ]]; then
        CONTEXT+="CI ($RUN_WORKFLOW): $RUN_CONCLUSION. "
      else
        CONTEXT+="CI ($RUN_WORKFLOW): $RUN_STATUS. "
      fi
    fi
  fi
fi

[[ -z "$CONTEXT" ]] && exit 0

printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}' \
  "$(echo "$CONTEXT" | sed 's/"/\\"/g')"

exit 0
