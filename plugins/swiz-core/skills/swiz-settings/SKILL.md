---
description: Run `swiz settings` from Claude Code
allowed-tools: Bash
argument-hint: "[arguments]"
---

Run the swiz `settings` command.

Rules:
- If `$ARGUMENTS` is empty, run `swiz settings`.
- If `$ARGUMENTS` is present, run `swiz settings $ARGUMENTS`.
- Summarize key output and report any errors clearly.
