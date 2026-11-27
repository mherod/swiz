---
name: swiz-plugin-doctor
description: Diagnose a Swiz plugin that has missing skills, unavailable MCP task tools, or hooks that fail, run twice, or need trust in Claude Code or Codex.
---

Check each affected capability in the requested host and project. Start with
read-only checks and use the smallest repair that addresses what you find.

- **Plugin and skills.** Check that `swiz-core@swiz-marketplace` is enabled
  in the intended scope in Claude Code's `/plugin` or Codex's `/plugins` or
  desktop Plugins panel. Check the marketplace source and use a fresh
  session. If the loaded package is stale, use
  [swiz-plugin-update](../swiz-plugin-update/SKILL.md).
- **CLI and MCP.** Check `command -v swiz`, `bun --version`, and `swiz --help`
  in the host's execution environment. A desktop host may have a different
  PATH from an interactive shell. Check whether the host loaded the bundled
  Swiz MCP server and lists `TaskList`. When the host can invoke the tool,
  use `TaskList` as a read-only check of the connection. For an inventory of
  saved registrations or to check other servers, use
  [swiz-manage-mcp](../swiz-manage-mcp/SKILL.md).
- **Hooks.** In Codex, check `/hooks` or desktop Settings > Hooks for the
  bundled definitions and their trust state. Have the user review changed
  definitions. Trigger a harmless tool call in the target session and look
  for the corresponding dispatch in the host's hook output or Swiz's recent
  dispatch evidence. For repeated runs, check for another Swiz registration
  in user and project configuration and use the migration steps in
  [swiz-install](../swiz-install/SKILL.md).

Use `swiz doctor --verbose` for supplementary CLI diagnostics. Standalone
registration warnings can be expected with a plugin-owned setup. Keep
`--fix` and `--aggressive` out of plugin troubleshooting because they can
write standalone registrations. Report discovery, MCP connection, and hook
execution based on the evidence available for each.
