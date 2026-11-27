# MCP configuration management

For coordinating file reservations between sessions through the Swiz MCP server,
see [FileOwnership](mcp-file-ownership.md).

`swiz manage mcp` supports Claude Code, Claude Desktop, Cursor, Windsurf, Gemini,
Junie, AI, Antigravity CLI and Codex. Antigravity accepts `--antigravity`
or `--agy`; Codex uses `--codex`; Windsurf uses `--windsurf`.

```sh
swiz manage mcp list
swiz manage mcp list --agy
swiz manage mcp list --project
swiz manage mcp validate --agy
swiz manage mcp add example --command /absolute/path/to/server --arg --stdio --agy --dry-run
swiz manage mcp add example --url https://example.invalid/mcp --codex --project --dry-run
swiz manage mcp remove example --agy --dry-run
```

| Agent | Flag | User-level MCP file | Project MCP file |
| --- | --- | --- | --- |
| Antigravity CLI | `--agy` | `~/.gemini/config/mcp_config.json` | `.agents/mcp_config.json` |
| Codex | `--codex` | `~/.codex/config.toml` | `.codex/config.toml` |
| Claude Code | `--claude` | `~/.claude.json` | `.mcp.json` |
| Claude Desktop | `--claude-desktop` | `~/Library/Application Support/Claude/claude_desktop_config.json` | User-level only |
| Cursor | `--cursor` | `~/.cursor/mcp.json` | `.cursor/mcp.json` |
| Gemini CLI | `--gemini` | `~/.gemini/settings.json` | `.vscode/mcp.json` |
| Junie | `--junie` | `~/.junie/mcp/mcp.json` | `.junie/mcp/mcp.json` |
| AI | `--ai` | `~/.ai/mcp/mcp.json` | `.ai/mcp/mcp.json` |
| Windsurf | `--windsurf` | `~/.codeium/windsurf/mcp_config.json` | `.codeium/windsurf/mcp_config.json` |

Antigravity MCP files are separate from its hooks configuration. JSON targets
use `mcpServers`. Codex uses TOML `mcp_servers`. Project paths are relative to
the command's working directory.

Use target flags for additions and removals. Without them, these commands
target all supported files in the selected scope. `add` replaces a definition
with the same name. Use `--dry-run` to preview the files before applying.

`list` includes saved disabled entries, and `validate` checks configuration
shape and bare commands on PATH. Check configured executable paths, HTTP
connections, and authentication separately. The host's effective server list
also accounts for sources such as plugins, managed settings, and alternate
profiles. `list` can print full URLs and `show` can print arguments and
environment values, so keep raw output local.

## Installing and Uninstalling Swiz MCP Server

Swiz provides dedicated actions to install or remove the Swiz MCP server without altering hooks or shell shims:

- `swiz manage mcp install [--targets...] [--project] [--dry-run]` registers the Swiz MCP server in agent MCP configurations.
- `swiz manage mcp uninstall [--targets...] [--project] [--dry-run]` removes the Swiz MCP server from agent MCP configurations.
- `swiz install --mcp` (or `--mcp-only`) installs only the MCP server across detected agents, leaving hooks and LaunchAgents untouched.
- `swiz install --uninstall --mcp` removes only the MCP server without stripping other settings.

For a host that loads the bundled Swiz MCP server, manage that registration
in the host's plugin manager. See the [plugin guide](../plugins/swiz-core/README.md).

## Synchronizing agents

```sh
swiz manage mcp sync --dry-run
swiz manage mcp sync
swiz manage mcp sync --agy --codex --claude --cursor
swiz manage mcp sync --project --dry-run
swiz manage mcp merge --from agy --codex
swiz manage mcp merge --from codex --agy --project --dry-run
```

Without target flags, sync includes agents detected by the shared installed-agent
detector and agents with an MCP file in the selected scope. Explicit flags select
the participants, including targets whose files do not exist yet. Sync takes the
union of enabled definitions and keeps disabled entries local. Equivalent
definitions converge without rewriting files. Conflicting same-name definitions
fail before any write. Use directed `merge --from <agent>` to choose the
definition for a name. Multiple merge sources follow the CLI's registry order,
with later sources winning.

Sync and merges involving Codex or Antigravity accept portable stdio `command`,
`args`, and string-valued `env` definitions, with optional `type: "stdio"`.
They also accept simple HTTP endpoint definitions with optional string `headers`.
Swiz translates `url` to Antigravity's `serverUrl` and back. Configure
host-specific OAuth and unsupported fields in the owning host. With
`sync --skip-non-portable`, an incompatible name keeps its existing definition
in every target. Portable values, including environment values and headers,
are copied to the target files. Preview and conflict messages show counts or
names without printing those values.

All source/target configs and proposed serializations are checked before writing.
Malformed configurations abort. Changed files receive a `.bak` backup, and a
detected concurrent edit aborts that write. A later filesystem failure can leave
earlier targets updated. Reread the selected targets before retrying after a
failure. `--dry-run` writes neither configs nor backups.

Codex edits preserve unrelated TOML settings and check the complete parsed result
before writing. MCP table formatting/comments may normalize; the original file is
in the backup. Syntax that cannot be safely rewritten is rejected. Installation
only registers the `swiz` stdio server and never implicitly syncs other entries.

Formats: [Antigravity MCP documentation](https://www.antigravity.google/docs/mcp)
and [Codex MCP documentation](https://developers.openai.com/codex/mcp).
