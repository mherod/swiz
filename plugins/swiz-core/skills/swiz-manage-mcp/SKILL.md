---
name: swiz-manage-mcp
description: Review, add, remove, validate, copy, or sync saved MCP server registrations across agent harnesses with the Swiz CLI.
---

Use `swiz manage mcp` for saved MCP registrations. The host's MCP or plugin
manager handles servers supplied by plugins, managed policy, or other config
layers. `swiz mcp` starts the Swiz server itself.

## Review registrations

- Run `swiz manage mcp list` for supported user-level files. Pass a host flag
  such as `--codex`, `--claude`, `--cursor`, or `--agy` to narrow it. Run
  `swiz manage mcp list --project` from the intended project's root to check
  that layer. Claude Desktop has a user-level file only.
- Use `swiz manage mcp validate` with the same host and scope flags to check
  configuration shape and bare command names on PATH. For stdio, check any
  configured executable or script path in the host's launch environment.
  For HTTP, check the host's connection and authentication status.
- Compare saved entries with the host's effective server list, such as
  `codex mcp list --json`, and with tools available in the current session.
  Check enablement and ownership before calling a repeated name a duplicate.
  Confirm live operation with a harmless tool call when available. For Swiz,
  use `TaskList`.
- Share names and redacted status. `list` may print full URLs, and `show`
  may print arguments and environment values.

## Change a saved registration

Use explicit host flags for the requested targets. Omit `--project` for
user-level edits. Preview with `--dry-run`, check the target files, then
repeat without it when the user has requested the change.

```sh
swiz manage mcp add example --command /absolute/path/to/server --arg --stdio --codex --dry-run
swiz manage mcp add example --url https://example.invalid/mcp --claude --project --dry-run
swiz manage mcp remove example --codex --dry-run
```

`add` replaces an existing definition with the same name. Use the host's
authentication flow for OAuth or host-specific credentials. Each write to an
existing file saves its previous contents in `.bak`; preserve the original
backup when making several edits that need one rollback point.

`swiz manage mcp install` and `uninstall` add or remove the standalone `swiz`
registration only. For a plugin-owned server, use the host's plugin manager.
For standalone-to-plugin migration, follow [swiz-install](../swiz-install/SKILL.md).

## Copy or sync registrations

- Use `merge --from` to copy a chosen host's definitions into a target,
  including updates to matching names. Use `sync` to share the union of
  enabled definitions across selected hosts. Sync keeps disabled entries
  local and stops on conflicting definitions for a name.
- Portable definitions include stdio commands with arguments and string
  environment values, plus simple HTTP endpoints and string headers. Check
  that launchers exist on every target and that credentials are intended for
  the destination before applying. Configure host-specific OAuth or other
  unsupported options in their owning host. With `sync --skip-non-portable`,
  a skipped name keeps its existing definition in every target.

```sh
swiz manage mcp merge --from cursor --codex --dry-run
swiz manage mcp sync --codex --cursor --skip-non-portable --dry-run
```

After a change, run scoped `list` and `validate` again and check the effective
server list in a fresh host session. If a multi-host write fails, reread each
target before retrying because earlier files may already have changed.
