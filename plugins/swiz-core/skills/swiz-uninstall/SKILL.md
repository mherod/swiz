---
description: Run `swiz uninstall` from Claude Code
allowed-tools: Bash
argument-hint: "[arguments]"
---

Run the swiz `uninstall` command.

Rules:
- If `$ARGUMENTS` is empty, run `swiz uninstall`.
- If `$ARGUMENTS` is present, run `swiz uninstall $ARGUMENTS`.
- Summarize key output and report any errors clearly.
