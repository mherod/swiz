# Task Governance: Hook Requirements Map

Verified against source on 2026-06-11. Every value below was confirmed in code; file:line
references point at the authoritative definition. Update this doc when those files change.

## Task lifecycle

Successful swiz MCP `TaskCreate`, `TaskUpdate`, and `TaskList` responses include a
`Task governance:` footer after the queue. It reminds callers to plan real work with
one action per subject, keep status and blockers current, record completion evidence
in `description`, and manage tasks in the parent session. These are advisory hints,
including for agents without task hooks; they do not add enforcement gates. Empty
queues and the final active task only suggest follow-on tasks when work remains.

State machine: `pending` → `in_progress` → `completed`, or `deleted` from either open state.

- **Evidenced one-step completion only**: `pending` → `completed` succeeds only when
  `taskAutoTransition` is on and the update carries evidence in `description`. It steps through
  `in_progress` without taking an in_progress slot. Otherwise tasks pass through `in_progress`
  first (`pendingCompletionRefusal`, `src/tasks/task-evidence.ts`, shared by the MCP/CLI hop and
  the native hook).
- **In-progress cap**: at most **4** tasks may be `in_progress` per project
  (`MAX_IN_PROGRESS_TASKS_PER_PROJECT`, `src/tasks/task-wip-limit.ts`). Edit/Write/Bash are
  blocked only above the cap (`exceedsInProgressCap`, `hooks/pretooluse-task-governance.ts`).
- **Pending overflow**: more than **20** pending tasks blocks every tool except TaskList
  (`PENDING_TASK_OVERFLOW_LIMIT`, `checkPendingOverflowGate`, `hooks/pretooluse-task-governance.ts`).
  The denial reports the measured count, the limit, and whose tasks were counted. A TaskList sync
  alone does not clear it.
- Tasks are never auto-completed or auto-deleted; every transition is an explicit
  `TaskUpdate`.

## PreToolUse gates

All consolidated in `hooks/pretooluse-task-governance.ts` (thin wrappers re-export sections):

| Hook | Enforces |
|---|---|
| `pretooluse-require-tasks.ts` | Blocks Edit/Write/Bash without a valid task plan. **Strict**: ≥2 incomplete, ≥1 pending, ≥1 in_progress. **Relaxed**: ≥1 incomplete (`pretooluse-task-governance.ts:129-130`). Edit/Write payloads of ≥10 lines (`isLargeContentPayload`, `:299`) pass through with post-tool advisory instead of a hard block, so expensive generated content isn't lost. |
| `pretooluse-task-subject-validation.ts` | One-verb subjects: rejects compound subjects (coordinators like "and"/"then") unless the pending buffer is healthy; rejects deferral framing ("future work", "carryover"); rejects compliance-gaming meta-subjects about the task tooling; rejects `~`/`$HOME` path references (`src/tasks/task-subject-validation.ts:137`). |
| `pretooluse-taskupdate-schema.ts` | Restricts `TaskUpdate` input to allowed fields. |
| `pretooluse-enforce-taskupdate.ts` | Completion rate limit: max **2 completions per 5-second window** (`MAX_COMPLETIONS_IN_WINDOW = 2`, `WINDOW_MS = 5_000`, `pretooluse-task-governance.ts:1022-1023`), bypassed when the planning buffer is healthy. Blocks `pending` → `completed` unless the update is evidenced and `taskAutoTransition` is on. Enforces the in-progress cap of 4. Blocks deprecated `swiz tasks` CLI in favour of native task tools. |
| `pretooluse-no-task-delegation.ts` | Blocks delegating task management to subagents (subagent TaskCreate lands in a different session and deadlocks the parent). |
| `pretooluse-no-phantom-task-completion.ts` | Blocks completing a task with zero substantive tool calls since it went `in_progress`. |
| `pretooluse-block-tasks-dir-{read,edit,glob,bash}.ts` | Block direct reads/edits/globs/shell access to `~/.claude/tasks/` — task state must flow through the task tools. |

Governance is skipped when `AgentDef.tasksEnabled === false` (e.g. Codex), outside git repos,
or when no `CLAUDE.md` exists in the tree (`isTaskEnforcementProject`,
`pretooluse-task-governance.ts:305`). For 3 minutes after a user message
(`isWithinUserMessageGrace`, `USER_MESSAGE_GRACE_MS`), the workflow gates stand down entirely;
task-file integrity checks still apply. A retry in that window can pass without the measured
condition changing.

## Staleness thresholds

`src/tasks/task-governance-constants.ts` — counts are non-task tool calls since the last
task-tool interaction:

| Constant | Value | Effect |
|---|---|---|
| `TASK_STALENESS_ENFORCEMENT_THRESHOLD` | 60 | **Hard block** tool use until tasks refreshed |
| `CANONICAL_TASKLIST_SYNC_MAX_AGE_MS` | 20 min | `TaskList` refresh required beyond this age |

Cache tuning (same file): `INCREMENTAL_FILE_LIMIT = 10`, `DEFAULT_STALE_CEILING_MS = 5s`,
`DEFAULT_MAX_STALE_MS = 60s`, `MAX_CACHED_SESSIONS = 50`,
`COMPLETED_TASK_PRUNE_AGE_MS = 15 min`.

## Weighted divergence advisories

The owner accepted advisory **15** and steering **30** on 2026-09-17 in
[#844](https://github.com/mherod/swiz/issues/844), after reviewing normalized
telemetry. The sample had only 31 complete completed runs across 85 recent sessions;
its limitations and distribution are recorded with the decision. This activation
does not change the existing hard gates above.

`posttooluse-task-advisor.ts` consumes the canonical divergence reducer: task reads,
file reads, searches and exempt shell reads weigh 0; local mutations weigh 1; outward
git/gh mutations weigh 2. Only confirmed task creation or changed task updates reset
the counter. TaskList and unchanged or failed updates cannot reset it. Pending or
unknown mutation outcomes make evidence incomplete until confirmed movement restores
a known baseline. Confirmed unchanged/failed outcomes resolve pending attempts without
discarding a previously complete baseline.

The hook uses the daemon snapshot, falling back to its persisted normalized ledger
when unavailable. Recovery reuses the reducer and effective thresholds. Legacy records
without confirmed outcomes, missing history and malformed snapshots remain silent.
Advice includes the weighted sum and last confirmed movement, and never denies a tool
call. Read-only investigation and an honestly drained queue do not create divergence.
Count-context messages report counts without treating a small queue as drift.

Thresholds resolve independently from project, user and default settings:

```sh
swiz settings set divergence-advisory 15 --project
swiz settings set divergence-steer 30 --project
swiz settings disable-hook posttooluse-task-advisor.ts --project
swiz settings enable-hook posttooluse-task-advisor.ts --project
```

Disabling the hook removes both its advice and steering. Disabling `auto-steer`
retains advisory context but skips scheduled nudges; normal transport eligibility
still applies. Neither control disables existing hard task gates.

### Evidence and provider support

Recognizing a provider's task-tool name does not prove that its mutation succeeded.
The outcome adapter accepts `structuredContent.taskMutation.changed` from successful
Swiz MCP responses. `true` proves movement; `false` preserves the counter. Explicit
`isError: true` or `success: false` responses are failures, even if a change flag is
also present. Other response shapes are unknown; rendered success text and attempted
input fields are not movement evidence. The advisory hook only runs for agents with
task tools enabled.

A new session has an incomplete baseline until a confirmed mutation. A pending
mutation temporarily suppresses advice; a confirmed no-op or failure restores the
previous completeness without resetting the sum. An unknown outcome leaves the
baseline incomplete until later confirmed movement. Consequently, silence can mean
insufficient evidence, a disabled hook, or a value below threshold; it
does not certify that the agent is on plan.

The existing `/status-line/snapshot` response exposes `snapshot.divergence`, including
`weightedSum`, last movement, `complete`, `provenance` (`live` or `recovered`), and the
effective thresholds with their individual source tiers. Recovery reads the existing
captured-call ledger rather than inferring success from a generic transcript. New
divergence evidence contains normalized outcomes, weights and bounded checkpoints,
without adding raw commands, task text or tool responses. The running aggregate
survives eviction from the recent-call window.

### Rollout and acceptance coverage

[#865](https://github.com/mherod/swiz/issues/865#issuecomment-5574263444) shipped
telemetry in `b3710af7` on 2026-09-07. The owner recorded the distribution review in
[#844](https://github.com/mherod/swiz/issues/844) before
[#866](https://github.com/mherod/swiz/issues/866#issuecomment-5718681058) activated
advice in `d3bc1198` on 2026-09-17. These remain separate rollout stages; retaining
the 60-call hard staleness gate was an explicit decision.

| Contract | Verification |
|---|---|
| Shared 0/1/2 weights, outward writes before shell exemptions, real movement resets | [`divergence.test.ts`](../src/commands/daemon/divergence.test.ts) classification and movement suites; [`dispatch-routes.test.ts`](../src/commands/daemon/dispatch-routes.test.ts) confirmed task outcomes |
| Drained queues and 40 read-only calls stay silent; mutations advise at 15 and steer at 30 | [`posttooluse-task-advisor.test.ts`](../hooks/posttooluse-task-advisor.test.ts) incidence and threshold cases |
| Task reads and no-op updates preserve divergence; incomplete evidence stays silent | Advisor cases plus dispatch pending/unknown-outcome cases |
| Layered settings, recovery parity, capped-history resilience and session separation | [`divergence-settings.test.ts`](../src/commands/daemon/divergence-settings.test.ts) and reducer recovery cases |
| Factual task counts and existing hard gates remain intact | [`task-governance-rephrasing.test.ts`](../src/tasks/task-governance-rephrasing.test.ts), [`posttooluse-task-count-context.test.ts`](../hooks/posttooluse-task-count-context.test.ts) and [`pretooluse-task-governance-compliance.test.ts`](../hooks/pretooluse-task-governance-compliance.test.ts) |
| Hook disable path and auto-steer opt-out | Advisor disable/steering cases |

## PostToolUse hooks

- `posttooluse-task-sync.ts` — syncs disk task state into daemon caches
  (`taskListSyncHook` / `taskAuditSyncHook`; see also `posttooluse-task-list-sync.ts`,
  `posttooluse-task-audit-sync.ts`).
- `posttooluse-task-count-context.ts` — injects factual counts into context; reads in-memory
  event state first (`src/tasks/task-event-state.ts`), falls back to disk + mutation overlay.
- `posttooluse-task-advisor.ts` — complete-evidence weighted divergence advice and steering.
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
  - **Integrity gate (#688)**: a `completed` task file present on disk but absent from the
    session trail (`.audit-log.jsonl`) blocks stop as a suspected out-of-band write
    (`task-integrity-validator.ts`, `detectOrphanedCompletedTasks`). Mirrors the
    `swiz tasks repair` orphan check. Gated on a non-empty trail so native/legacy sessions
    that never recorded one are never flagged (AC3); only fires once no task is incomplete.

## Storage facts that bite

### Project ownership and WIP (#931)

TaskList, service WIP checks and native governance use the same attributed queue
reader. It includes the project store and session stores whose metadata identifies
that project. Unknown historical stores and stores attributed elsewhere do not count.
An explicitly supplied native session without ownership metadata is the only wider
scope: its blockers say `explicit current session, outside MCP project scope`.
Ownership is refreshed from disk; a stale `openCount: 0` cannot hide live tasks.

Bare native task IDs are local to a store. Two sessions' `#1` tasks remain distinct;
collisions appear as `session:<session-id>#1` or `project:<project-key>#1`. Pass that
full reference as the MCP TaskUpdate `taskId` to choose an owner. An ambiguous bare
ID is rejected. Existing prefixed mirrors still use the most recently written copy.
Automatic subject merging preserves queues with colliding IDs until owners resolve
them explicitly. Native event overlays cannot change another session's task.

The cap remains four. Service status changes, combined field/start updates and stub
creation hold a project lock through the capacity check and write. A rejected start
leaves its fields unchanged; completion, cancellation and same-status updates can
still proceed. Native hooks inspect the same project count, while their externally
performed writes remain subject to the external-writer limitations below. Diagnostics
identify each owning store and direct recovery to its task tool or owner; they never
ask callers to cancel invisible foreign work.

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
- **Last-task-standing is advisory, not enforced** (Fixes #834). Completing the final open task
  is permitted; `taskQueueHint` reports the empty queue in the board the task tools return. It
  used to throw, which combined with `pretooluse-require-tasks` (an open task is needed before
  Bash/Edit/Write) to form a ratchet: no legal transition ended with an empty queue, so the only
  way to close the last task was to invent a successor. Agents did exactly that — one session
  logged 8 such rejections and resolved every one by creating a task it did not need — so the
  rule manufactured the fabricated state it was meant to prevent. The invariant that matters is
  about session end, and the stop gates own it (clean git state, unpushed-commits handoff).
  `skipLastTaskGuard` remains on the CLI options for compatibility but no longer gates anything.
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
- **Reader-side integrity check (#688).** The stop completion auditor cross-references
  `completed` task files against the session trail (`task-integrity-validator.ts`). A
  completed file with no trail entry — the orphan condition `swiz tasks repair` already
  detects — is treated as a suspected out-of-band write and blocks stop instead of being
  trusted as done. This is the one defense that covers script, symlink, and external-process
  writes at once, because it inspects the result rather than the command. It is gated on an
  active trail so it never false-flags native files (see residual risks below).

## Residual risks (not closeable by a textual in-session guard)

**Decision (#687): the Bash guard stays a textual substring match.** A shell command string
is not a single resolvable path, and enumerating every evasion (script bodies, inline-assigned
vars, pre-existing symlinks) is an arms race. Detection of out-of-band writes is delegated to
reader-side integrity checking (#688), not to in-guard matching. The Bash-only vectors below
are accepted guard-side residual, pinned by allow-but-noted cases in
`hooks/pretooluse-block-tasks-dir-read.test.ts`.

- **Wrapper-script / interpreter writes**: `bun script.ts`, `bun -e`, `node -e`, or `python`
  that writes to the tasks dir. The Bash command string carries no protected path, so the
  textual guard cannot see it. Defense is the runtime `enforceNativeTaskTools` for the CLI
  path only; arbitrary file writes from a script remain possible.
- **Inline shell-variable indirection**: `D=$HOME/.claude; cat $D/tasks/...`. Only `~`/`$HOME`
  are expanded; a var assigned earlier in the same command cannot be resolved statically.
- **Symlink write-through (Bash)**: `echo … > /tmp/link/1.json` where `/tmp/link` was symlinked
  to the tasks dir out of band. The command names only the link path; the canonicalizing
  resolver (`isProtectedTaskStoragePathResolved`) that closes this for Edit/Write/Read/Glob/LS
  is not run for Bash command strings.
- **External processes and other sessions**: any process outside this agent's hooked tool
  loop (another session, cron, an MCP server, a background job) can read/write/delete the
  JSON files freely. Hooks gate tool calls, not the filesystem. **Decision (#688): adopt
  reader-side trail reconciliation, not file signing.** A signed-record scheme cannot cover
  files the native harness writes, since swiz does not own that writer. Instead the stop
  auditor's integrity check (above) catches the highest-value vector — a fabricated
  `completed` file that would otherwise satisfy the auditor — by flagging completed files
  absent from the trail. Accepted residual: (a) a session with **no** trail baseline cannot
  be checked at all (AC3 conservatism), (b) deleting a `pending` file is only caught when it
  was the session's last live task (the audit-log fallback reconstructs incomplete state when
  `allTasks` is empty), not when other files remain, and (c) out-of-band writes to
  non-`completed` states are not flagged. Full filesystem-level prevention (restrictive perms)
  remains out of scope.
- **`autoTransition` setting is overloaded**: the same key gates both project-state lifecycle
  transitions and the task-status `pending → completed` shortcut. Enabling it for the former
  also enables the latter (now evidence-gated). Splitting the key is tracked in #689.
