#!/bin/bash
# Stop hook: Block stop if large files (>500KB) were committed without LFS

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd')

LOG=/tmp/stop-large-files-debug.log
SIZE_LIMIT_KB=500

{
  echo "=== Large Files Stop Hook Debug ==="
  echo "CWD: $CWD"
  echo "Size limit: ${SIZE_LIMIT_KB}KB"
} >> "$LOG"

cd "$CWD" || exit 0

if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "Not a git repo, allowing stop" >> "$LOG"
  exit 0
fi

# Get objects introduced in the last 10 commits
LARGE_FILES=()

# List all blobs added in the last 10 commits with their sizes
while IFS= read -r line; do
  BLOB_HASH=$(echo "$line" | awk '{print $3}')
  FILE_PATH=$(echo "$line" | awk '{print $4}')

  # Skip deleted files (blob hash 0000000)
  [[ "$BLOB_HASH" == "0000000000000000000000000000000000000000" ]] && continue

  # Get blob size in bytes
  BLOB_SIZE=$(git cat-file -s "$BLOB_HASH" 2>/dev/null || echo 0)
  BLOB_SIZE_KB=$((BLOB_SIZE / 1024))

  if [[ "$BLOB_SIZE_KB" -ge "$SIZE_LIMIT_KB" ]]; then
    # Check if this file is tracked by LFS
    LFS_TRACKED=false
    if [[ -f ".gitattributes" ]]; then
      FILE_EXT="${FILE_PATH##*.}"
      if grep -qE "(filter=lfs|$(echo "$FILE_PATH" | sed 's/[.[\*^$]/\\&/g'))" .gitattributes 2>/dev/null; then
        LFS_TRACKED=true
      fi
    fi

    if [[ "$LFS_TRACKED" == "false" ]]; then
      LARGE_FILES+=("${BLOB_SIZE_KB}KB — $FILE_PATH")
      echo "Large file: $FILE_PATH (${BLOB_SIZE_KB}KB)" >> "$LOG"
    else
      echo "LFS tracked (ok): $FILE_PATH (${BLOB_SIZE_KB}KB)" >> "$LOG"
    fi
  fi
done < <(git log --diff-filter=A --name-only --format="" HEAD~10..HEAD 2>/dev/null | grep -v "^$" | while read -r f; do
  HASH=$(git log -1 --format="%H" -- "$f" 2>/dev/null)
  [[ -z "$HASH" ]] && continue
  BLOB=$(git ls-tree "$HASH" -- "$f" 2>/dev/null | awk '{print $3, $4}')
  [[ -z "$BLOB" ]] && continue
  echo "$HASH $BLOB"
done)

{
  echo "Large files without LFS: ${#LARGE_FILES[@]}"
} >> "$LOG"

if [[ "${#LARGE_FILES[@]}" -gt 0 ]]; then
  REASON="Large files (>${SIZE_LIMIT_KB}KB) committed without Git LFS tracking.\n\n"
  REASON+="Files:\n"
  for f in "${LARGE_FILES[@]}"; do
    REASON+="  $f\n"
  done
  REASON+="\nConsider adding these to Git LFS or removing them from the repository. Large committed files bloat git history permanently."
  REASON+="\n\nACTION REQUIRED: You must act on this now. This hook will block every stop attempt until resolved. Do not try to stop again without completing the required action. If you believe this is a false positive, use the /re-assess skill to re-evaluate your assumptions — the hook's findings take authority over your own assessment."

  echo "Blocking - ${#LARGE_FILES[@]} large file(s) found" >> "$LOG"

  jq -n --arg reason "$REASON" '{decision: "block", reason: $reason}'
  exit 0
fi

echo "No oversized files, allowing stop" >> "$LOG"
exit 0
