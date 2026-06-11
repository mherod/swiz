# Task Governance: Hook Requirements Map

Verified against source on 2026-06-11. Every value below was confirmed in code; file:line
references point at the authoritative definition. Update this doc when those files change.

## Task lifecycle

State machine: `pending` → `in_progress` → `completed`, or `deleted` from either open state.

- **No shortcut completion**: `pending` → `completed` is blocked; tasks must pass through
  `in_progress` first (`hooks/pretooluse-task-governance.ts`, completion governance section).
- **In-progress cap**: at most **4** tasks may be `in_progress` concurrently
  (`IN_PROGRESS_CAP`, `hooks/pretooluse-task-governance.ts:277`).
- **Pending overflow**: more than **20** pending tasks triggers a cleanup requirement
  (`PENDING_TASK_OVERFLOW_LIMIT`, `hooks/pretooluse-task-governance.ts:704`).
- Tasks are never auto-completed or auto-deleted; every transition is an explicit
  `TaskUpdate`.

## PreToolUse gates

All consolidated in `hooks/pretooluse-task-governance.ts` (thin wrappers re-export sections):

| Hook | Enforces |
|---|---|
| `pretooluse-require-tasks.ts` | Blocks Edit/Write/Bash without a valid task plan. **Strict**: ≥2 incomplete, ≥1 pending, ≥1 in_progress. **Relaxed**: ≥1 incomplete (`pretooluse-task-governance.ts:129-130`). Edit/Write payloads of ≥10 lines (`isLargeContentPayload`, `:299`) pass through with post-tool advisory instead of a hard block, so expensive generated content isn't lost. |
| `pretooluse-task-subject-validation.ts` | One-verb subjects: rejects compound subjects (coordinators like "and"/"then") unless the pending buffer is healthy; rejects deferral framing ("future work", "carryover"); rejects compliance-gaming meta-subjects about the task tooling; rejects `~`/`$HOME` path references (`src/tasks/task-subject-validation.ts:137`). |
| `pretooluse-taskupdate-schema.ts` | Restricts `TaskUpdate`/`update_plan` input to allowed fields. |
| `pretooluse-enforce-taskupdate.ts` | Completion rate limit: max **2 completions per 5-second window** (`MAX_COMPLETIONS_IN_WINDOW = 2`, `WINDOW_MS = 5_000`, `pretooluse-task-governance.ts:1022-1023`), bypassed when the planning buffer is healthy. Blocks `pending` → `completed`. Enforces the in-progress cap of 4. Blocks deprecated `swiz tasks` CLI in favour of native task tools. |
| `pretooluse-no-task-delegation.ts` | Blocks delegating task management to subagents (subagent TaskCreate lands in a different session and deadlocks the parent). |
| `pretooluse-no-phantom-task-completion.ts` | Blocks completing a task with zero substantive tool calls since it went `in_progress`. |
| `pretooluse-block-tasks-dir-{read,edit,glob,bash}.ts` | Block direct reads/edits/globs/shell access to `~/.claude/tasks/` — task state must flow through the task tools. |

Governance is skipped when `AgentDef.tasksEnabled === false` (e.g. Codex), outside git repos,
or when no `CLAUDE.md` exists in the tree (`isTaskEnforcementProject`,
`pretooluse-task-governance.ts:305`). A grace window after a user message
(`isWithinUserMessageGrace`) relaxes messaging.

## Staleness thresholds

`src/tasks/task-governance-constants.ts` — counts are non-task tool calls since the last
task-tool interaction:

| Constant | Value | Effect |
|---|---|---|
| `TASK_CREATION_ADVISORY_THRESHOLD` | 10 | Advise creating tasks |
| `TASK_STALENESS_ADVISORY_THRESHOLD` | 20 | Advise the queue may be stale |
| `TASK_STALENESS_ENFORCEMENT_THRESHOLD` | 60 | **Hard block** tool use until tasks refreshed |
| `CANONICAL_TASKLIST_SYNC_MAX_AGE_MS` | 20 min | `TaskList` refresh required beyond this age |

Cache tuning (same file): `INCREMENTAL_FILE_LIMIT = 10`, `DEFAULT_STALE_CEILING_MS = 5s`,
`DEFAULT_MAX_STALE_MS = 60s`, `MAX_CACHED_SESSIONS = 50`,
`COMPLETED_TASK_PRUNE_AGE_MS = 15 min`.

## PostToolUse hooks

- `posttooluse-task-sync.ts` — syncs disk task state into daemon caches
  (`taskListSyncHook` / `taskAuditSyncHook`; see also `posttooluse-task-list-sync.ts`,
  `posttooluse-task-audit-sync.ts`).
- `posttooluse-task-count-context.ts` — injects planning stats into context; reads in-memory
  event state first (`src/tasks/task-event-state.ts`), falls back to disk + mutation overlay.
- `posttooluse-task-advisor.ts` — next-step guidance from outstanding items.
- `posttooluse-git-task-autocomplete.ts` — matches commit headers to open tasks.
- `posttooluse-task-subject-validation.ts`, `posttooluse-task-output.ts` — subject/output
  follow-ups.

## Stop gates

- `stop-incomplete-tasks.ts` (+ `stop-incomplete-tasks/evaluate.ts`) — blocks stop while any
  task is `pending`/`in_progress`; requires a recent `TaskList` before stop when task tools
  were used. Exempts agents without task tools (gemini).
- `stop-completion-auditor.ts` (+ `stop-completion-auditor/`) —
  - **Task creation gate**: sessions with ≥ **10** tool calls must have created tasks
    (`TOOL_CALL_THRESHOLD = 10`, `task-creation-validator.ts:13`).
  - **CI evidence gate**: after a `git push`, a completed task must record CI evidence
    matching `CI_EVIDENCE_RE = /\bci\b.*(?:green|pass|success)|conclusion.*success/i`
    (`ci-evidence-validator.ts:20`). Evidence lives in `t.description` for native
    `TaskUpdate` (not `completionEvidence`); when no tasks exist, transcript bash commands
    matching `CI_CMD_RE = /gh run (?:view|watch)|swiz ci.?wait/` count as fallback evidence.

## Storage facts that bite

- Native `TaskCreate`/`TaskUpdate` **delete** the `.json` file on completion; a clean session
  dir holds only `.highwatermark` + `.lock`. `allTasks.length === 0` does NOT mean "no tasks
  were created" — stop hooks must not assume it does.
- Stop hooks must use `readSessionTasksFresh()`, never the `TaskStateCache`.
- Task roots come from `createDefaultTaskStore()` / `getTaskRoots()`; daemon dispatch must
  apply `_env` first or the wrong provider root is used.

## Integrity hardening (2026-06-11)

Closes the in-session bypasses where a non-native writer could mutate task state
without passing the native-tool gates.

- **Auto-transition is regulated, not silent** (`completeTaskWithAutoTransition`,
  `task-service.ts`). The `pending → completed` shortcut requires the `autoTransition`
  setting AND meaningful completion evidence (`hasMeaningfulCompletionEvidence`), and still
  steps through `in_progress` so both transitions hit the audit log. A task already in
  `in_progress` completes normally. The swiz MCP `TaskUpdate` forwards its `description` as
  evidence (native parity). This is the service-layer analogue of
  `pretooluse-no-phantom-task-completion`.
- **Last-task-standing is consistently enforced.** `validateLastTaskStanding` blocks any
  completion that would leave zero incomplete tasks. The CLI's cross-session exemption
  (`skipLastTaskGuard = !!explicit --session`, Fixes #420) now applies uniformly across
  `runCompleteTask` (first `updateStatus` attempt, not just the auto-transition fallback)
  and `runStatusTask`. Task-enabled agents cannot reach these CLI paths
  (`enforceNativeTaskTools`), and the native/MCP path never sets `skipLastTaskGuard`, so the
  agent invariant is never relaxed.
- **Path guards canonicalize single-path tools.** `isProtectedTaskStoragePathResolved`
  (`hooks/sandbox-path-utils.ts`) expands `~`/`$HOME` and resolves `realpath` before
  matching, so a symlink whose parent points into the tasks dir, or a `${HOME}/...` form, is
  caught for Edit/Write/Read/Glob/LS. The Bash guard stays textual (a command string is not
  a single resolvable path).
- **CLI routing covers every launcher.** `SWIZ_TASKS_CLI_RE` (`task-cli-governance.ts`) now
  matches path-qualified `swiz` and JS-runtime entrypoints (`bun [run] index.ts tasks`,
  `node /abs/index.ts tasks`), not just `swiz tasks` at a whitespace boundary. The runtime
  guard `enforceNativeTaskTools` already blocked by parsed subcommand; this adds the matching
  PreToolUse layer.
- **Guards fail closed.** On schema parse failure the four `block-tasks-dir-*` hooks re-check
  the raw payload for a protected marker and deny if present, instead of allowing.

## Residual risks (not closeable by a textual in-session guard)

- **Wrapper-script / interpreter writes**: `bun script.ts`, `bun -e`, `node -e`, or `python`
  that writes to the tasks dir. The Bash command string carries no protected path, so the
  textual guard cannot see it. Defense is the runtime `enforceNativeTaskTools` for the CLI
  path only; arbitrary file writes from a script remain possible.
- **Inline shell-variable indirection**: `D=$HOME/.claude; cat $D/tasks/...`. Only `~`/`$HOME`
  are expanded; a var assigned earlier in the same command cannot be resolved statically.
- **External processes and other sessions**: any process outside this agent's hooked tool
  loop (another session, cron, an MCP server, a background job) can read/write/delete the
  JSON files freely. Hooks gate tool calls, not the filesystem. File-level defenses
  (restrictive perms, signed records) would be required — and a signed-record scheme cannot
  cover files the native harness writes, since swiz does not own that writer.
- **`autoTransition` setting is overloaded**: the same key gates both project-state lifecycle
  transitions and the task-status `pending → completed` shortcut. Enabling it for the former
  also enables the latter (now evidence-gated). Splitting the key is a follow-up.
