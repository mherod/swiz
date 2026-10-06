---
name: swiz-tasks
description: Run `swiz tasks` in Claude Code or Codex
argument-hint: "[arguments]"
---

Use the current host's available shell tool. Arguments are the options requested by the user; substitute them for `<arguments>` in examples, never pass the placeholder literally. Respect explicit user instructions over this workflow. If `swiz` is missing, explain the Bun and linked CLI prerequisites in the plugin README.

Use native task tools or the Swiz MCP task tools for routine task management.
Run the `swiz tasks` command for diagnostics or when the user explicitly requests the CLI.

Rules:
- If no arguments were requested, run `swiz tasks`.
- If arguments were requested, run `swiz tasks <arguments>`.
- Summarize key output and report any errors clearly.
