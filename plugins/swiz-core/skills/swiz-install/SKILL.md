---
name: swiz-install
description: Install Swiz or set it up in Claude Code or Codex for the first time, including migration from standalone hook and MCP registrations.
---

Use the requested host and installation method. For plugin setup in the
current host, use `--claude` for Claude Code or `--codex` for Codex when a
Swiz command needs a host flag.

1. In the local environment that launches the host, check `bun --version`,
   `command -v swiz`, and `swiz --help`. If the CLI needs provisioning, use a
   checkout of `mherod/swiz` that contains this plugin release. Run
   `bun install --frozen-lockfile` and then `bun link` from that checkout. Keep
   the checkout in place and restart the host if its PATH needs refreshing.
   The plugin cache only contains host integrations.
2. Before enabling the plugin, inspect existing standalone hooks and MCP on
   the target host. If migrating, keep the plugin disabled and preview
   `swiz uninstall --<host> --dry-run` and
   `swiz install --uninstall --mcp --<host> --dry-run`, substituting `claude`
   or `codex` for `<host>`. Apply the scoped removals when migration is part
   of the request. Check for duplicates in project-level configuration too.
3. In Claude Code, add `mherod/swiz` with `/plugin marketplace add mherod/swiz`
   and install `swiz-core@swiz-marketplace` through `/plugin`. In Codex, add
   the marketplace with `codex plugin marketplace add mherod/swiz`, then
   install `swiz-core` in `/plugins` or the desktop Plugins panel. Reuse the
   configured marketplace if it already points to the requested source. For
   local development, use the absolute path to the Swiz repository as the
   marketplace source.
4. Start a fresh session. In Codex, have the user review and trust the bundled
   hooks through `/hooks` or desktop Settings > Hooks. Confirm the host lists
   a bundled skill and the Swiz MCP task tools. Trigger a normal hook event
   and check its result. If any capability is missing, use
   [swiz-plugin-doctor](../swiz-plugin-doctor/SKILL.md).

Use `swiz install` for a requested standalone setup. Disable the plugin in
that host first, then preview and apply `swiz install --claude` or
`swiz install --codex` with the requested options. The plugin supplies its
own hook and MCP registrations. See the [plugin guide](../../README.md).
