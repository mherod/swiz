---
description: Run `swiz session` from Claude Code
allowed-tools: Bash
argument-hint: "[arguments]"
---

Run the swiz `session` command.

Rules:
- If `$ARGUMENTS` is empty, run `swiz session`.
- If `$ARGUMENTS` is present, run `swiz session $ARGUMENTS`.
- Summarize key output and report any errors clearly.
