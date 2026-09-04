# MCP configuration management

`swiz manage mcp` supports Claude Code, Claude Desktop, Cursor, Gemini,
Junie, AI, Antigravity CLI and Codex. Antigravity accepts `--antigravity`
or `--agy`; Codex uses `--codex`.

```sh
swiz manage mcp list --agy
swiz manage mcp add example --command bun --arg x --arg example-mcp --agy
swiz manage mcp show example --antigravity
swiz manage mcp validate --agy
swiz manage mcp remove example --agy
swiz manage mcp add example --command bun --agy --project
swiz install --antigravity --dry-run
swiz install --antigravity
```

| Agent | Global MCP file | Project MCP file |
| --- | --- | --- |
| Antigravity CLI | `~/.gemini/config/mcp_config.json` | `.agents/mcp_config.json` |
| Codex | `~/.codex/config.toml` | `.codex/config.toml` |

Antigravity MCP files are separate from its hooks configuration. JSON targets
use `mcpServers`; Codex uses TOML `mcp_servers`. Project paths are relative to
the command's working directory. Claude Desktop has no project target.

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
union without deleting servers. Equivalent definitions converge without rewriting
files. Conflicting same-name definitions fail before any write; use directed
`merge --from <agent>` to select a winner. Multiple merge sources retain the CLI's
registry order, with later sources winning; select one source for unambiguous resolution.

Sync and transfers involving Codex or Antigravity support portable stdio `command`, `args` and
string-valued `env` definitions, accepting optional `type: "stdio"`. HTTP/OAuth,
agent-specific settings and unsupported fields cause a preflight error rather
than being silently discarded or copied with different semantics. Configure those
servers separately. Environment values are copied when explicitly syncing; preview
and conflict messages show counts and names without printing those values.

All source/target configs and proposed serializations are checked before writing.
Malformed configurations abort. Changed files receive a `.bak` backup, and a
detected concurrent edit aborts that write. A later filesystem failure can leave
earlier targets updated; the operation is not a multi-file transaction. Retry
after resolving the failure. `--dry-run` writes neither configs nor backups.

Codex edits preserve unrelated TOML settings and check the complete parsed result
before writing. MCP table formatting/comments may normalize; the original file is
in the backup. Syntax that cannot be safely rewritten is rejected. Installation
only registers the `swiz` stdio server and never implicitly syncs other entries.

Formats: [Antigravity MCP documentation](https://www.antigravity.google/docs/mcp)
and [Codex MCP documentation](https://developers.openai.com/codex/mcp).
