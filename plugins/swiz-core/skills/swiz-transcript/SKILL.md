---
description: Run `swiz transcript` from Claude Code
allowed-tools: Bash
argument-hint: "[arguments]"
---

Run the swiz `transcript` command.

Rules:
- If `$ARGUMENTS` is empty, run `swiz transcript`.
- If `$ARGUMENTS` is present, run `swiz transcript $ARGUMENTS`.
- Summarize key output and report any errors clearly.
