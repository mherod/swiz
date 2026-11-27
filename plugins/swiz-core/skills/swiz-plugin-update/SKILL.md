---
name: swiz-plugin-update
description: Update the installed Swiz plugin or refresh a local Swiz marketplace in Claude Code or Codex, then verify that the host loaded the update.
---

Identify the active `swiz-core@swiz-marketplace` installation and its source
before updating. Keep the same host, installation scope, and any pinned ref
unless the user asks to change them.

- **Claude Code.** For a Git marketplace, refresh its listing with
  `/plugin marketplace update swiz-marketplace`. Select `swiz-core` on the
  Installed tab in `/plugin` and choose **Update now** for the existing
  installation. Start a fresh session or use `/reload-plugins` when
  supported. For a local marketplace, refresh the source checkout and reload.
- **Codex.** Use `codex plugin marketplace list` to confirm the source. For
  a configured Git marketplace, run
  `codex plugin marketplace upgrade swiz-marketplace`. For a local
  marketplace, update the checkout that the marketplace points to. Restart
  Codex and check the installed plugin. If an enabled installation still has
  stale files, use the plugin manager's refresh flow or, on clients that
  support it, `codex plugin add swiz-core@swiz-marketplace` to refresh it.

The linked Swiz CLI is a separate checkout. If the release requires newer
CLI code, update that checkout to a compatible revision and run
`bun install --frozen-lockfile` there. Relink with `bun link` from that
checkout only if the host resolves Swiz from the wrong location or the link
is missing.

In a fresh session, confirm the installed package version when available
and check a skill, the Swiz MCP tools, and a hook event. In Codex, have the
user review any hooks marked for renewed trust. If the host still loads the
old package or a capability fails, use
[swiz-plugin-doctor](../swiz-plugin-doctor/SKILL.md).
