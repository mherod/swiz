# Task store namespaces

Within each provider's task root, native sessions keep `<session-id>/` and project
stores use `.projects/<project-key>/`. `TaskStoreKey` distinguishes their addresses;
the namespace is never part of a task ID prefix. Existing IDs and audit references
are preserved.

Readers support legacy flat project directories without moving files. The first
project write atomically renames the whole directory when `.session-meta.json.cwd`
matches its project key. New metadata records the store kind explicitly. Native
session directories stay in place for agent interoperability.

To inspect or migrate legacy directories in bulk:

```sh
bun scripts/migrate-task-stores.ts --provider claude
bun scripts/migrate-task-stores.ts --provider claude --apply
```

Other supported providers are `codex`, `cursor`, and `gemini`. The default is a
dry run. Exit code 2 means some directories were held for review. Missing or
contradictory ownership metadata is never guessed during bulk migration. These
directories remain readable through their explicit project address. Conflicting
old and new directories cause an error; neither is overwritten or automatically
merged. Reconcile ownership and retain a backup before repairing such records.

Migration uses a short-lived directory lock. An interrupted process can leave
`.projects/.migration-<key>.lock`; verify that no migration is running before
removing that empty lock. Subsequent attempts are safe to retry.

`getSessions()` enumerates native sessions only. Project-aware consumers use the
canonical queue, retaining each legacy task's owning store for mutation. Pruning
accepts only one project store, never the combined queue. To compare MCP, CLI and
hook projections without pruning, run:

```sh
bun scripts/debug-task-store-scope.ts --provider claude
```
