---
description: Run `swiz install` from Claude Code
allowed-tools: Bash
argument-hint: "[arguments]"
---

Run the swiz `install` command.

Rules:
- If `$ARGUMENTS` is empty, run `swiz install`.
- If `$ARGUMENTS` is present, run `swiz install $ARGUMENTS`.
- Summarize key output and report any errors clearly.
