---
description: Run `swiz cleanup` from Claude Code
allowed-tools: Bash
argument-hint: "[arguments]"
---

Run the swiz `cleanup` command.

Rules:
- If `$ARGUMENTS` is empty, run `swiz cleanup`.
- If `$ARGUMENTS` is present, run `swiz cleanup $ARGUMENTS`.
- Summarize key output and report any errors clearly.
