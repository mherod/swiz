---
description: Install swiz hooks into detected agent settings
allowed-tools: Bash
argument-hint: "[install flags]"
---

Run the swiz installer now.

Rules:
- If `$ARGUMENTS` is empty, run `swiz install`.
- If `$ARGUMENTS` is present, run `swiz install $ARGUMENTS`.
- Report the command output summary clearly.
- If `swiz` is not available on PATH, tell the user to run `bun link` in the swiz repository first.
