---
description: Run `swiz status` from Claude Code
allowed-tools: Bash
argument-hint: "[arguments]"
---

Run the swiz `status` command.

Rules:
- If `$ARGUMENTS` is empty, run `swiz status`.
- If `$ARGUMENTS` is present, run `swiz status $ARGUMENTS`.
- Summarize key output and report any errors clearly.
