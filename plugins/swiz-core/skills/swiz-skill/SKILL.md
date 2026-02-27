---
description: Run `swiz skill` from Claude Code
allowed-tools: Bash
argument-hint: "[arguments]"
---

Run the swiz `skill` command.

Rules:
- If `$ARGUMENTS` is empty, run `swiz skill`.
- If `$ARGUMENTS` is present, run `swiz skill $ARGUMENTS`.
- Summarize key output and report any errors clearly.
