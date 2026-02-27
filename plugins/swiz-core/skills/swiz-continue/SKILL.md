---
description: Run `swiz continue` from Claude Code
allowed-tools: Bash
argument-hint: "[arguments]"
---

Run the swiz `continue` command.

Rules:
- If `$ARGUMENTS` is empty, run `swiz continue`.
- If `$ARGUMENTS` is present, run `swiz continue $ARGUMENTS`.
- Summarize key output and report any errors clearly.
