# SkillQuery MCP tool

`swiz mcp` exposes `SkillQuery` alongside its task and reply tools. Reconnect an existing MCP client after upgrading to refresh its tool list.

The tool uses the same skill discovery and name precedence as `swiz skill`, scoped to the requesting MCP server's project directory even when the daemon handles the request. It returns readable text and structured data in `structuredContent.skillQuery`.

| Request | Result |
| --- | --- |
| `{}` | First 50 skill names, descriptions, sources and paths |
| `{"query":"commit"}` | Index filtered by name or description, case-insensitively |
| `{"limit":20,"offset":20}` | Next index page |
| `{"action":"lookup","name":"commit"}` | Exact-name metadata without skill content |
| `{"name":"commit"}` | Full skill content, including frontmatter |
| `{"action":"read","name":"commit","args":["message"],"noFrontMatter":true}` | Content with CLI argument substitution and frontmatter removed |

Index responses include `total`, `offset`, `limit` and `nextOffset` (`null` at the end). `limit` accepts 1–200. `query`, `offset` and `limit` apply to `list`; `args` and `noFrontMatter` apply to `read`.

Reading behaves like `swiz skill <name> --raw`: inline shell commands remain text and setup commands never execute. Positional arguments use the CLI's `$ARGUMENTS`, `$0`, `$1`, … substitution. Skill invocation, command expansion, conversion, syncing and transfer are outside this tool's read-only scope. Unknown names and invalid arguments return MCP tool errors.
