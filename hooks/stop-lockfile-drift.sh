#!/bin/bash
# Stop hook: Block stop if package.json was modified but lockfile was not

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

LOG=/tmp/stop-lockfile-drift-debug.log

# Only block once per session — don't repeatedly nag about the same drift
SENTINEL="/tmp/stop-lockfile-drift-blocked-${SESSION_ID}.flag"
if [[ -n "$SESSION_ID" && -f "$SENTINEL" ]]; then
  echo "Already blocked once this session, allowing stop" >> "$LOG"
  exit 0
fi

{
  echo "=== Lockfile Drift Stop Hook Debug ==="
  echo "CWD: $CWD"
} >> "$LOG"

cd "$CWD" || exit 0

if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "Not a git repo, allowing stop" >> "$LOG"
  exit 0
fi

# Find package.json files changed in recent commits (not node_modules)
CHANGED_PKG=$(git diff --name-only HEAD~10..HEAD 2>/dev/null | grep "package\.json$" | grep -v "node_modules" || true)

if [[ -z "$CHANGED_PKG" ]]; then
  echo "No package.json changes, allowing stop" >> "$LOG"
  exit 0
fi

{
  echo "Changed package.json files:"
  echo "$CHANGED_PKG"
} >> "$LOG"

DRIFT_FOUND=()

for PKG_FILE in $CHANGED_PKG; do
  PKG_DIR=$(dirname "$PKG_FILE")

  # Detect which lockfile should exist alongside this package.json
  LOCKFILE=""
  if [[ -f "$PKG_DIR/pnpm-lock.yaml" ]]; then
    LOCKFILE="$PKG_DIR/pnpm-lock.yaml"
    INSTALL_CMD="pnpm install"
  elif [[ -f "$PKG_DIR/yarn.lock" ]]; then
    LOCKFILE="$PKG_DIR/yarn.lock"
    INSTALL_CMD="yarn install"
  elif [[ -f "$PKG_DIR/package-lock.json" ]]; then
    LOCKFILE="$PKG_DIR/package-lock.json"
    INSTALL_CMD="npm install"
  fi

  if [[ -z "$LOCKFILE" ]]; then
    echo "No lockfile found alongside $PKG_FILE, skipping" >> "$LOG"
    continue
  fi

  # Check if the lockfile was also changed in the same range of commits
  # Strip leading "./" since git diff --name-only outputs paths without it
  LOCKFILE_NORMALIZED="${LOCKFILE#./}"
  LOCKFILE_CHANGED=$(git diff --name-only HEAD~10..HEAD 2>/dev/null | grep -F "$LOCKFILE_NORMALIZED" || true)

  if [[ -z "$LOCKFILE_CHANGED" ]]; then
    # In monorepos, the root lockfile may cover this sub-package
    # Check if root lockfile was updated instead
    ROOT_LOCKFILE_COVERS=false
    if [[ "$PKG_DIR" != "." ]]; then
      for ROOT_LF in pnpm-lock.yaml yarn.lock package-lock.json; do
        if [[ -f "$ROOT_LF" ]]; then
          ROOT_LF_CHANGED=$(git diff --name-only HEAD~10..HEAD 2>/dev/null | grep -F "$ROOT_LF" || true)
          if [[ -n "$ROOT_LF_CHANGED" ]]; then
            ROOT_LOCKFILE_COVERS=true
            echo "Root lockfile $ROOT_LF covers $PKG_FILE, no drift" >> "$LOG"
            break
          fi
        fi
      done
    fi

    if [[ "$ROOT_LOCKFILE_COVERS" == "true" ]]; then
      continue
    fi

    # Also check if package.json actually changed dependencies (not just scripts/version)
    DEPS_CHANGED=$(git diff HEAD~10..HEAD -- "$PKG_FILE" 2>/dev/null | grep "^+" | grep -E '"(dependencies|devDependencies|peerDependencies|optionalDependencies)"' || true)
    # Also catch added/removed dependency lines
    DEP_LINES=$(git diff HEAD~10..HEAD -- "$PKG_FILE" 2>/dev/null | grep "^[+-]" | grep -E '^\+\s+"[^"]+": "[^"]+"' | grep -v "^+++" || true)

    if [[ -n "$DEPS_CHANGED" || -n "$DEP_LINES" ]]; then
      DRIFT_FOUND+=("$PKG_FILE (lockfile: $LOCKFILE) — run: $INSTALL_CMD")
      echo "Drift detected: $PKG_FILE changed deps but $LOCKFILE unchanged" >> "$LOG"
    fi
  else
    echo "Lockfile $LOCKFILE was also updated, no drift for $PKG_FILE" >> "$LOG"
  fi
done

if [[ "${#DRIFT_FOUND[@]}" -gt 0 ]]; then
  REASON="Package dependency changes detected without lockfile updates.\n\n"
  REASON+="Drifted packages:\n"
  for d in "${DRIFT_FOUND[@]}"; do
    REASON+="  $d\n"
  done
  REASON+="\nRun the install command to regenerate the lockfile, then commit it before stopping."
  REASON+="\n\nACTION REQUIRED: You must act on this now. This hook will block every stop attempt until resolved. Do not try to stop again without completing the required action. If you believe this is a false positive, use the /re-assess skill to re-evaluate your assumptions — the hook's findings take authority over your own assessment."

  echo "Blocking - ${#DRIFT_FOUND[@]} lockfile drift(s) found" >> "$LOG"

  # Mark as blocked so we don't repeat on next stop attempt
  [[ -n "$SESSION_ID" ]] && touch "$SENTINEL"

  jq -n --arg reason "$REASON" '{decision: "block", reason: $reason}'
  exit 0
fi

echo "No lockfile drift, allowing stop" >> "$LOG"
exit 0
