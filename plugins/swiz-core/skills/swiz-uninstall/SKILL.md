---
name: swiz-uninstall
description: Remove the Swiz plugin or standalone hook registrations from the requested Claude Code or Codex host.
---

Determine whether the user wants the plugin removed, standalone registrations
removed, or both. Follow explicit user scope.

- Remove the plugin through the host's plugin manager: `/plugin` in Claude
  Code or `/plugins` in Codex CLI (Plugins in the desktop app). Use the host's
  uninstall capability when available. Do not edit internal plugin caches.
- `swiz uninstall --claude` or `swiz uninstall --codex` removes standalone
  user-level hook registrations only. Preview with `--dry-run` when useful.
- To remove a separately installed MCP server, use
  `swiz install --uninstall --mcp --claude` or the `--codex` equivalent.
- Never run an unscoped uninstall unless the user asked to remove all hosts.
- Restart active sessions and verify removal. Plugin removal does not delete
  project tasks, Swiz settings, or a separately installed CLI.
