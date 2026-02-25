#!/bin/bash
# Stop hook: Run lint-staged if configured in project

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd')
PACKAGE_JSON="$CWD/package.json"

# Check if package.json exists
if [[ ! -f "$PACKAGE_JSON" ]]; then
  exit 0
fi

# Check if lint-staged is configured
HAS_LINT_STAGED_SCRIPT=$(jq -e '.scripts["lint-staged"]' "$PACKAGE_JSON" > /dev/null 2>&1; echo $?)
HAS_LINT_STAGED_DEP=$(jq -e '.devDependencies["lint-staged"] // .dependencies["lint-staged"]' "$PACKAGE_JSON" > /dev/null 2>&1; echo $?)

if [[ "$HAS_LINT_STAGED_SCRIPT" -ne 0 ]] && [[ "$HAS_LINT_STAGED_DEP" -ne 0 ]]; then
  exit 0
fi

# Determine package manager
if [[ -f "$CWD/pnpm-lock.yaml" ]]; then
  PKG_MANAGER="pnpm"
elif [[ -f "$CWD/yarn.lock" ]]; then
  PKG_MANAGER="yarn"
else
  PKG_MANAGER="npm"
fi

# Run lint-staged
cd "$CWD" || exit 0

if [[ "$HAS_LINT_STAGED_SCRIPT" -eq 0 ]]; then
  OUTPUT=$($PKG_MANAGER run lint-staged 2>&1)
  EXIT_CODE=$?
else
  OUTPUT=$(npx --yes lint-staged 2>&1)
  EXIT_CODE=$?
fi

# If lint-staged failed, block stop
if [[ "$EXIT_CODE" -ne 0 ]]; then
  # Check if the error is just "no staged files" - this is not a failure
  if echo "$OUTPUT" | grep -qiE "(could not find any staged files|no staged files)"; then
    exit 0
  fi

  REASON="The linter is the authority. Lint-staged checks failed—do not ignore them.\n\n"
  REASON+="Linting failures must be fixed. You cannot postpone, negotiate with, or work around them.\n\n"
  REASON+="Failures:\n$OUTPUT\n\n"
  REASON+="Fix every linting issue, then try stopping again.\n\n"
  REASON+="ACTION REQUIRED: You must act on this now. This hook will block every stop attempt until resolved. Do not try to stop again without completing the required action. If you believe this is a false positive, use the /re-assess skill to re-evaluate your assumptions — the hook's findings take authority over your own assessment."

  jq -n \
    --arg reason "$REASON" \
    '{decision: "block", reason: $reason}'
  exit 0
fi

exit 0
