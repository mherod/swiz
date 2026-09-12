(
  set -eu
  SKILLS_ROOT="${CLAUDE_SKILLS_ROOT:-$HOME/.claude/skills}"
  START_DIR="$(pwd)"
  TARGET_DIR="$START_DIR"
  while [ "$TARGET_DIR" != "/" ] && [ ! -f "$TARGET_DIR/CLAUDE.md" ]; do
    TARGET_DIR="$(dirname "$TARGET_DIR")"
  done
  if [ ! -f "$TARGET_DIR/CLAUDE.md" ]; then TARGET_DIR="$START_DIR"; fi
  TARGET_PATH="$TARGET_DIR/CLAUDE.md"
  trap 'result=$?; if [ "$result" -ne 0 ]; then printf "thresholds=unavailable path=%s; memory edits blocked\n" "$TARGET_PATH" >&2; fi' EXIT
  PROJECT_SETTINGS=$(swiz settings show --project --json --dir "$TARGET_DIR")
  GLOBAL_SETTINGS=$(swiz settings show --global --json)
  printf '%s' "$PROJECT_SETTINGS" | jq -se 'length == 1 and (.[0] | type == "object")' >/dev/null
  printf '%s' "$GLOBAL_SETTINGS" | jq -se 'length == 1 and (.[0] | type == "object")' >/dev/null
  set --
  if [ -n "${VERIFIED_WORD_GATE:-}" ]; then
    case "$VERIFIED_WORD_GATE" in *[!0-9]*|0) exit 1 ;; esac
    set -- --verified-gate-word-threshold "$VERIFIED_WORD_GATE"
  fi
  RESOLUTION=$(bun "$SKILLS_ROOT/compact-memory/scripts/analyze-claude-md.ts" --resolve-thresholds --dir "$TARGET_DIR" --project-settings-json "$PROJECT_SETTINGS" --global-settings-json "$GLOBAL_SETTINGS" "$@")
  printf '%s' "$RESOLUTION" | jq -se --argjson gate "${VERIFIED_WORD_GATE:-null}" '
    def positive_integer: type == "number" and . > 0 and floor == .;
    length == 1 and (.[0] |
    .word as $w |
    ($w | type == "object") and
    ($w | has("verifiedGate")) and
    ($w.source == "project" or $w.source == "global" or $w.source == "default") and
    ($w.resolved | positive_integer) and (.word.binding | positive_integer) and
    ($w.verifiedGate == $gate) and
    ($w.verifiedGate == null or ($w.verifiedGate | positive_integer)) and
    ($w.binding == (if $gate == null then $w.resolved else ([$w.resolved, $gate] | min) end)) and
    ($w.mismatch == ($gate != null and $gate != $w.resolved)))
  ' >/dev/null
  WORDS=0
  if [ -f "$TARGET_PATH" ]; then WORDS=$(wc -w < "$TARGET_PATH" | tr -d '[:space:]'); fi
  printf '%s' "$RESOLUTION" | jq --arg path "$TARGET_PATH" --argjson words "$WORDS" \
    '{path: $path, words: $words, word: .word}'
)
