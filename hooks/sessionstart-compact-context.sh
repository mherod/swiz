#!/bin/bash
# SessionStart hook (compact matcher): Re-inject core conventions after context compaction.
# Agents lose their system context when conversation history is compressed.

INPUT=$(cat)
MATCHER=$(echo "$INPUT" | jq -r '.matcher // empty' 2>/dev/null)

# Only fire on compact/resume events, not fresh sessions
if [[ "$MATCHER" != "compact" && "$MATCHER" != "resume" ]]; then
  exit 0
fi

printf '{"systemMessage":"Post-compaction context: Use rg instead of grep. Use the Edit/StrReplace tool, never sed/awk. Do not co-author commits or PRs. Never disable code checks or quality gates. Run git diff after reaching success. Check task list before starting new work.","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Post-compaction context: Use rg instead of grep. Use the Edit/StrReplace tool, never sed/awk. Do not co-author commits or PRs. Never disable code checks or quality gates. Run git diff after reaching success. Check task list before starting new work."}}'
