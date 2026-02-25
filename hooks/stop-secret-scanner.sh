#!/bin/bash
# Stop hook: Block stop if secrets/credentials detected in recent commits

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd')

LOG=/tmp/stop-secret-scanner-debug.log

{
  echo "=== Secret Scanner Stop Hook Debug ==="
  echo "CWD: $CWD"
} >> "$LOG"

cd "$CWD" || exit 0

if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "Not a git repo, allowing stop" >> "$LOG"
  exit 0
fi

# Scan the last 10 commits worth of diff
DIFF=$(git diff HEAD~10..HEAD 2>/dev/null || git diff HEAD 2>/dev/null)

if [[ -z "$DIFF" ]]; then
  echo "No diff to scan, allowing stop" >> "$LOG"
  exit 0
fi

# Patterns that suggest secrets (added lines only — lines starting with +)
FINDINGS=()

# Private key headers
while IFS= read -r line; do
  FINDINGS+=("$line")
done < <(echo "$DIFF" | grep -n "^+" | grep -iE "(-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY)" | head -5)

# High-entropy tokens: AWS, GitHub, Slack, Stripe, etc.
while IFS= read -r line; do
  FINDINGS+=("$line")
done < <(echo "$DIFF" | grep -n "^+" | grep -iE "(AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{36}|ghs_[a-zA-Z0-9]{36}|xox[baprs]-[0-9A-Za-z]{10,}|sk-[a-zA-Z0-9]{32,}|sk_live_[a-zA-Z0-9]{24,}|rk_live_[a-zA-Z0-9]{24,})" | head -5)

# Generic patterns: assignments that look like secrets
while IFS= read -r line; do
  FINDINGS+=("$line")
done < <(echo "$DIFF" | grep -n "^+" | grep -iE '(api_?key|api_?secret|auth_?token|access_?token|secret_?key|private_?key|password|passwd|client_?secret)\s*[:=]\s*["\x27][^"\x27]{8,}["\x27]' | grep -iv "example\|placeholder\|your[_-]\|<.*>\|xxxx\|test\|fake\|dummy\|replace\|env\." | head -5)

{
  echo "Findings count: ${#FINDINGS[@]}"
  for f in "${FINDINGS[@]}"; do
    echo "  $f"
  done
} >> "$LOG"

if [[ "${#FINDINGS[@]}" -gt 0 ]]; then
  REASON="Potential secrets detected in recent commits.\n\n"
  REASON+="Suspicious lines:\n"
  for f in "${FINDINGS[@]}"; do
    REASON+="  $f\n"
  done
  REASON+="\nReview and remove secrets before stopping. If these are false positives, ensure values come from environment variables, not hardcoded strings."
  REASON+="\n\nACTION REQUIRED: You must act on this now. This hook will block every stop attempt until resolved. Do not try to stop again without completing the required action. If you believe this is a false positive, use the /re-assess skill to re-evaluate your assumptions — the hook's findings take authority over your own assessment."

  echo "Blocking - ${#FINDINGS[@]} potential secret(s) found" >> "$LOG"

  jq -n --arg reason "$REASON" '{decision: "block", reason: $reason}'
  exit 0
fi

echo "No secrets detected, allowing stop" >> "$LOG"
exit 0
