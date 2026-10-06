---
name: swiz-shim
description: Run `swiz shim` in Claude Code or Codex
argument-hint: "[arguments]"
---

Use the current host's available shell tool. Arguments are the options requested by the user; substitute them for `<arguments>` in examples, never pass the placeholder literally. Respect explicit user instructions over this workflow. If `swiz` is missing, explain the Bun and linked CLI prerequisites in the plugin README.

Run the swiz `shim` command.

Rules:
- If no arguments were requested, run `swiz shim`.
- If arguments were requested, run `swiz shim <arguments>`.
- Summarize key output and report any errors clearly.
