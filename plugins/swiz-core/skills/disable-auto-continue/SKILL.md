---
description: Disable swiz auto-continue globally or for a session
allowed-tools: Bash
argument-hint: "[--session [id] --dir <path>]"
---

Disable auto-continue by running the swiz settings command.

Rules:
- If `$ARGUMENTS` is empty, run `swiz settings disable auto-continue`.
- If `$ARGUMENTS` is present, run `swiz settings disable auto-continue $ARGUMENTS`.
- Summarize the resulting state.
