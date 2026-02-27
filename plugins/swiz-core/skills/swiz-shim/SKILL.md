---
description: Run `swiz shim` from Claude Code
allowed-tools: Bash
argument-hint: "[arguments]"
---

Run the swiz `shim` command.

Rules:
- If `$ARGUMENTS` is empty, run `swiz shim`.
- If `$ARGUMENTS` is present, run `swiz shim $ARGUMENTS`.
- Summarize key output and report any errors clearly.
