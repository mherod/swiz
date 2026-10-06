# Swiz for Claude Code and Codex

One package supplies shared workflow skills, the Swiz stdio MCP server, and
host-specific lifecycle hooks. Requires a local POSIX environment with Bun
and a linked Swiz CLI on the agent process's PATH. The plugin does not bundle
the CLI or download executables during startup.

## Prerequisites

In a separate checkout of `mherod/swiz`, run `bun install --frozen-lockfile`
and `bun link`. Restart the host if its PATH needs refreshing. Verify
`bun --version` and `swiz --help` in the host's terminal. Keep that checkout:
the linked CLI, its dependencies, and its hooks execute from there.

Use a CLI checkout containing this plugin release: older versions do not
recognize `SWIZ_PLUGIN=1` and can install duplicate global hooks at startup.
Do not run `bun link` inside the plugin cache.

## Claude Code

```text
/plugin marketplace add mherod/swiz
/plugin install swiz-core@swiz-marketplace
```

For development, add the repository's absolute path instead of `mherod/swiz`,
or load `plugins/swiz-core` through the host's local plugin development flow.
Restart the session. The compatibility command `/swiz-core:install` guides
setup; shared skills are namespaced under `swiz-core`.

## Codex

```sh
codex plugin marketplace add mherod/swiz
```

For local development, pass the repository's absolute path. Open `/plugins`
in Codex CLI or Plugins in the desktop app, select `swiz-marketplace`, and
install `swiz-core`. Start a new session, then use `/hooks` to review and trust
the plugin hook definitions. Changed definitions need renewed trust.

The package includes portable `plugin.json` and `mcp.json`, plus a
`.codex-plugin/plugin.json` compatibility manifest for clients using the older
format. Both select the same skills, MCP server, and Codex hook file. Current
Codex uses `features.hooks`; older clients may use `features.codex_hooks`.
Follow the running client's hook settings instead of enabling both blindly.

Local command hooks and the local stdio server require local execution.
Installing the package on the web does not provision the CLI. The Codex IDE
extension and cloud-orchestrated Work are not supported targets for these hooks.

## Migrate a standalone install

Do this before enabling the plugin hooks/MCP server, or while the plugin is
disabled. Select **only the host being migrated**:

```sh
# Claude; substitute --codex for Codex
swiz uninstall --claude --dry-run
swiz install --uninstall --mcp --claude --dry-run
swiz uninstall --claude
swiz install --uninstall --mcp --claude
```

These remove standalone user-level hook/MCP registrations with backups and
preserve unrelated entries. Check project-local hook and MCP configuration
separately: these commands do not remove registrations from every config layer.
Do not keep both standalone dispatch entries and plugin dispatch entries active.
Shell shims, daemons, status lines and scheduled cleanup are separate integrations.

The plugin's startup dispatch carries `SWIZ_PLUGIN=1`, so Swiz's startup
self-heal does not write global hook registrations. Do not run an ordinary
`swiz install` while this plugin owns the same host's hooks and MCP server.

## Verify and remove

In a new session, verify the host lists the plugin's skills, Swiz MCP task
tools, and enabled/trusted hooks. Exercise a normal hook event and inspect its
result. `swiz status` reports standalone settings; it is not proof that the
host loaded or trusted a plugin.

Disable/uninstall through the host's plugin manager and restart sessions.
This removes plugin-owned capabilities, not separately installed registrations,
the linked CLI, or Swiz task/settings data. To return to standalone mode,
disable the plugin first, then run `swiz install --claude` or `--codex`.

## Maintenance

Hook files contain one dispatcher per supported host event. Swiz retains its
internal matching and execution policy; the host does not receive hundreds of
independent hooks. Event coverage follows `src/agents.ts` and the active manifest;
Codex currently receives the five events implemented by Swiz's Codex adapter.

After changing event mappings, manifest entries, or dispatch timeouts, run:

```sh
bun run scripts/build-plugin-hooks.ts
bun run scripts/build-plugin-hooks.ts --check
bun test src/plugin-marketplace.test.ts src/plugin-package.test.ts --reporter=dots --parallel=2
```

Bump versions in both provider manifests, the portable manifest, and the Claude
marketplace entry together. Shared skills must have `name` and `description`
frontmatter and must not depend on Claude-specific shell interpolation.

This agent plugin is separate from Swiz's project hook extensions configured
through `.swiz/config.json` and `swiz-hooks.ts`/`swiz-hooks.json`. The
`swiz plugins` CLI currently manages Claude's installed-plugin registry only;
use Codex's plugin manager for Codex installations.

References: [Claude manifests](https://code.claude.com/docs/en/plugins-reference),
[Codex packaging](https://developers.openai.com/plugins/build/plugins), and
[Codex hook trust](https://learn.chatgpt.com/docs/hooks).
