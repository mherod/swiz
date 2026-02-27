---
description: Run `swiz dispatch` from Claude Code
allowed-tools: Bash
argument-hint: "[arguments]"
---

Run the swiz `dispatch` command.

Rules:
- If `$ARGUMENTS` is empty, run `swiz dispatch`.
- If `$ARGUMENTS` is present, run `swiz dispatch $ARGUMENTS`.
- Summarize key output and report any errors clearly.
