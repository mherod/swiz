# Removing a Claude plugin

There are two paths depending on whether you have access to swiz on the host:

## 1. One-shot removal with swiz (recommended)

```sh
swiz plugins uninstall <name>@<marketplace>
# or, when the name is unambiguous:
swiz plugins uninstall <name>
```

This:

1. Deletes the cached install directory under `~/.claude/plugins/cache/<marketplace>/<name>/<version>/` (the directory `${CLAUDE_PLUGIN_ROOT}` resolves to when the plugin's hooks run).
2. Deletes the plugin's data directory under `~/.claude/plugins/data/<name>-<marketplace>/`.
3. Removes the entry from `~/.claude/plugins/installed_plugins.json`.
4. Removes the entry from the `enabledPlugins` map in `~/.claude/settings.json`, if present.

A `.bak` is written next to each modified JSON file before the rewrite.

Discover what's installed first:

```sh
swiz plugins list
swiz plugins info <name>
```

## 2. Manual filesystem removal (forensic / no-swiz)

If you can't run swiz, the same three filesystem locations have to change by hand. All paths are anchored at `$HOME`.

1. **Disable in user settings** — open `~/.claude/settings.json` and delete the plugin's key from the `enabledPlugins` map:
   ```json
   "enabledPlugins": {
     "<name>@<marketplace>": true
   }
   ```
2. **Remove from the installed-plugin registry** — open `~/.claude/plugins/installed_plugins.json` and delete the `"<name>@<marketplace>"` key from the top-level `plugins` map.
3. **Delete the cached install** — `trash ~/.claude/plugins/cache/<marketplace>/<name>/<version-or-sha>/` (or `rm -rf` if you don't have `trash`).

The marketplace clone under `~/.claude/plugins/marketplaces/<marketplace>/plugins/<name>/` is the source for re-install. Leave it alone unless you also want to drop the marketplace itself.

After all three steps, a recursive grep for the plugin name across those files should return no hits.

## Running sessions

**Plugin changes only apply to new Claude Code sessions.** A session that was active when the plugin was removed continues to load its hooks, skills, and agents until that session is restarted. If a misbehaving hook is the reason you're uninstalling, restart the running session immediately after the removal.

## Identifying which plugin owns a hook

When a plugin's hook blocks a tool call, the block message typically only quotes `${CLAUDE_PLUGIN_ROOT}/hooks/<hook>.<ext>` without the owning plugin slug. To find the plugin from the hook filename:

```sh
find ~/.claude/plugins/cache -path '*/hooks/<hook>.<ext>'
```

The path component immediately under `cache/<marketplace>/` is the plugin name. Then run `swiz plugins info <name>@<marketplace>` or `cat ~/.claude/plugins/cache/<marketplace>/<name>/<version>/.claude-plugin.json` for the full metadata before deciding whether to uninstall.
