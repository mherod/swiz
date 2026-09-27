---
description: Run `swiz session` from Claude Code
allowed-tools: Bash
argument-hint: "[arguments]"
---

Run the swiz `session` command to discover recently modified session transcripts.

> **Note on Session Identity & FileOwnership**: `swiz session` discovers sessions heuristically by finding the most recently modified transcript file on disk for the project. In multi-agent environments with concurrent sessions, it will return the newest transcript regardless of which agent process invokes it. For coordination tools like `FileOwnership`, do not rely on `swiz session`; pass your runtime's actual `session_id` provided by your agent environment/hooks.

Rules:
- If `$ARGUMENTS` is empty, run `swiz session`.
- If `$ARGUMENTS` is present, run `swiz session $ARGUMENTS`.
- Summarize key output and report any errors clearly.
