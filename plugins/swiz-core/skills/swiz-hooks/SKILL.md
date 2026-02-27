---
description: Run `swiz hooks` from Claude Code
allowed-tools: Bash
argument-hint: "[arguments]"
---

Run the swiz `hooks` command.

Rules:
- If `$ARGUMENTS` is empty, run `swiz hooks`.
- If `$ARGUMENTS` is present, run `swiz hooks $ARGUMENTS`.
- Summarize key output and report any errors clearly.
