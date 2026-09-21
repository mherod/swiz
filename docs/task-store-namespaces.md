# Flat task storage

Within each provider's task root, both native sessions and project stores use
`<logical-name>/`: the session ID or project key. `TaskStoreKey` retains the
address's purpose, but its kind does not create a separate directory. A project
key and an identical session ID are aliases for the same records, metadata, and
audit history. Writing the same task ID through either address updates that one
record; there is no isolation between those aliases. Queue readers count it once.

Different logical names and provider roots remain separate. Mutations retain the
selected owning address and caller root; project queues include only attributed
stores plus the explicitly supplied current session when it has no owner yet.
`storeKind` and `cwd` metadata support discovery and attribution, not isolation
between identical names. Existing task IDs and audit references are preserved.

The reserved `.projects/` directory is a compatibility source for the former
split layout. Reads do not migrate files: they prefer the flat directory and
fall back to `.projects/<project-key>/` when it is absent. The first project write
folds the namespaced store into its flat home. If only the namespaced store
exists, it is renamed. If both exist, nonconflicting records move to the flat
store, audit logs are joined destination-first, and duplicate derived metadata
is discarded. Normal task writes rebuild the metadata index.

To preview or apply the fold-back in bulk:

```sh
bun scripts/migrate-task-stores.ts --provider claude
bun scripts/migrate-task-stores.ts --provider claude --apply
```

Other supported providers are `codex`, `cursor`, and `gemini`. The default is a
dry run, which lists migration candidates without moving them. Exit code 2 means
some directories were held for review. A genuine filename collision preserves
both copies and reports their paths instead of choosing a task by timestamp.
Nonconflicting files may already have moved; the operation is retryable rather
than an all-or-nothing transaction. While both directories remain, normal reads
prefer the flat copy. Reconcile the reported records with a backup before retrying.
An apply run clears the shared metadata/audit collision that previously blocked
otherwise disjoint stores. Flat stores are never bulk-migration candidates.

Migration uses a short-lived directory lock. An interrupted process can leave
`.projects/.migration-<key>.lock`; verify that no migration is running before
removing that empty lock. Subsequent attempts are safe to retry.

`getSessions()` enumerates stores classified as native sessions. Project-aware
consumers use the canonical queue, retaining each task's owning store for mutation. Pruning
accepts only one project store, never the combined queue. To compare MCP, CLI and
hook projections without pruning, run:

```sh
bun scripts/debug-task-store-scope.ts --provider claude
```
