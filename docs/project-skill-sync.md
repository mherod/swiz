# Sync user skills into a project

`swiz skill --sync-project` refreshes a project's selected skills from a user
collection. It writes only to the project. Existing user-to-user sync commands
keep their current behaviour.

```sh
# Preview updates to the Codex skills already selected by a project.
swiz skill --sync-project --from codex --project ~/Development/plugg-platform --dry-run

# Apply those updates.
swiz skill --sync-project --from codex --project ~/Development/plugg-platform

# Import one user skill, converting Claude tool names to Codex equivalents.
swiz skill --sync-project --from claude --to codex apply-a11y

# Explicitly import the entire shared user collection.
swiz skill --sync-project --from agents --to codex --all
```

`--from` is required. `--to` defaults to the source agent. `--project` defaults
to the current Git worktree root, including when invoked from a subdirectory.
Outside Git, pass an existing project directory explicitly.

Targets are `<project>/.<agent>/skills`, including `.codex/skills`,
`.claude/skills`, and `.agents/skills`. Antigravity uses `.gemini/skills`.
The shared `agents` source reads `~/.agents/skills` first and then the legacy
`~/.agents` fallback; project overrides are never used as user sources.

With no skill name or `--all`, only names already installed in the target
project are selected. Project-only skills are retained and reported. An empty
target imports nothing until a name or `--all` is provided.

The existing sync resolver compares file content, tool-name conversion and Git
history. It updates stale copies, keeps newer project edits and target-only
files, and merges edits where possible. Timestamps alone do not prove which
copy is newer. Unresolved conflicts are skipped unless `--overwrite` is given;
that option replaces the entire conflicting skill, including target-only files.
Use `--dry-run` to inspect the decisions first.

Skills include their supporting files and binary assets. Project sync rejects
symlinked target roots and symlinked skill trees rather than writing through a
link into another collection. It does not delete project skills when a user
skill disappears, install a watcher, or write changes back to user storage.
