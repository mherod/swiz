---
name: swiz-install
description: Set up Swiz in Claude Code or Codex, verify prerequisites, or migrate from standalone swiz install registrations.
---

Use this workflow when the user asks to set up Swiz. Explicit user instructions take precedence.

1. Use the host's shell tool to check `bun --version` and `swiz --help`.
   If either is missing, use the plugin README's prerequisites. Do not run
   `bun link` in the cached plugin: it contains integrations, not the CLI.
2. Identify the active host from the conversation/runtime: Claude Code uses
   `--claude`; Codex uses `--codex`. Do not infer the host from the newest
   transcript or configure all agents by default.
3. Plugin installation already supplies MCP tools and lifecycle hooks. Do not
   run `swiz install` on top of it. Inspect `swiz status --no-health` and the
   host's MCP/hook browser. On Codex, review and trust the plugin hooks in `/hooks`.
4. If migrating existing standalone registrations, preview
   `swiz uninstall --<host> --dry-run` and
   `swiz install --uninstall --mcp --<host> --dry-run`. When migration is within
   the user's request, remove those registrations with the same commands
   without `--dry-run`. Preserve unrelated hooks and other hosts. Inspect
   project-local registrations too; the installer manages user-level files.
5. Start a new host session. Verify the plugin's skills, the Swiz MCP task
   tools, and a hook event. Report configuration and runtime verification separately.

If the user explicitly wants standalone installation instead, disable the
plugin first and run `swiz install --claude` or `swiz install --codex` as
appropriate. Preserve user-requested flags; use `--dry-run` to preview.
