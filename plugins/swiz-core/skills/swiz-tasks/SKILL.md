---
description: Run `swiz tasks` from Claude Code
allowed-tools: Bash
argument-hint: "[arguments]"
---

Run the swiz `tasks` command.

Rules:
- If `$ARGUMENTS` is empty, run `swiz tasks`.
- If `$ARGUMENTS` is present, run `swiz tasks $ARGUMENTS`.
- Summarize key output and report any errors clearly.
