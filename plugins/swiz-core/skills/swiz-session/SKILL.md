---
name: swiz-session
description: Run `swiz session` in Claude Code or Codex
argument-hint: "[arguments]"
---

Use the current host's available shell tool. Arguments are the options requested by the user; substitute them for `<arguments>` in examples, never pass the placeholder literally. Respect explicit user instructions over this workflow. If `swiz` is missing, explain the Bun and linked CLI prerequisites in the plugin README.

Run the swiz `session` command to discover recently modified session transcripts.

> **Note on Session Identity & FileOwnership**: `swiz session` discovers sessions heuristically by finding the most recently modified transcript file on disk for the project. In multi-agent environments with concurrent sessions, it will return the newest transcript regardless of which agent process invokes it. For coordination tools like `FileOwnership`, do not rely on `swiz session`; pass your runtime's actual `session_id` provided by your agent environment/hooks.

Rules:
- If no arguments were requested, run `swiz session`.
- If arguments were requested, run `swiz session <arguments>`.
- Summarize key output and report any errors clearly.
