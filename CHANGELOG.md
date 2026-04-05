# Changelog

## 2026-04-05

### Refactoring

- **Phase 2.2.2.1: stop-pr-description extraction** — Extracted
  into canonical 6-module architecture (types, context,
  format-validator, completeness-validator, action-plan,
  evaluate, wrapper). Reduced from 142 to 26 lines in wrapper.
  Added 12 comprehensive tests covering all validators and
  output formatting.
- **Phase 2.2.2.2: stop-pr-changes-requested extraction** —
  Extracted into canonical 6-module architecture (types,
  context, review-validators, review-data-fetcher,
  action-plan, evaluate, wrapper). Reduced from 262 to 23 lines
  in wrapper. Added 10 comprehensive tests covering review
  state detection and blocking message formatting.

### Phase 3.0 Planning

- **Hook extraction roadmap established** — Identified 32+
  remaining non-modular hooks as Phase 3.0 candidates.
  Planned 4-phase pipeline: verification, execution (5-6
  extractions per batch), Phase 4.0 consolidation. Canonical
  6-module pattern proven across 4 hooks.

## 2026-04-04

### New Features

- **Task repair command** — Added `swiz tasks repair`
  to reconstruct task files from the audit trail, fixing
  missing or status-inconsistent tasks. Supports `--dry-run`
  to preview changes without modifying files, and `--json`
  for structured output with typed repair actions.
- **Automatic task recovery** — When a task file is corrupt
  or partially written, task reads now automatically
  reconstruct from the audit log instead of silently
  dropping the task.
- **In-memory task state** — Task counts now update
  instantly after TaskCreate/TaskUpdate without waiting
  for disk writes, eliminating stale count displays
  (closes [#506](https://github.com/mherod/swiz/issues/506)).
- **Completion rate limiter** — Task completions are now
  throttled to prevent rapid-fire batch completions from
  bypassing governance checks (max 2 per 5-second window).
- **Audit log verification module** — Added `readAuditLog`,
  `getLastAuditEntry`, `verifyAuditEntry`, and
  `appendAuditEntry` APIs for structured audit log access.

### Bug Fixes

- **Task loss during push events** — A single corrupt or
  partially-written task file no longer causes all tasks in
  the session to disappear. Each file is now read
  independently with per-file error isolation.
- **Session cleanup race condition** — Fixed concurrent test
  failures caused by global event state cleanup interfering
  with other sessions. Cleanup is now scoped per-session.
- **Last-task completion gate** — Completing the final task
  is now permitted when the git working tree is clean,
  removing unnecessary friction at session end.
- **Hook self-heal** — Session start now verifies dispatch
  entries are present in settings even when the manifest
  hash hasn't changed, catching cases where settings were
  overwritten externally.
- **Hook self-repair** — Broken PreToolUse hooks no longer
  block edits to their own source file, preventing
  unrecoverable deadlocks.

### Improvements

- **Faster task lookups** — The require-tasks hook now uses
  cached reads via the daemon's TaskStateCache when
  available, reducing disk I/O on every tool call.
- **Session fs.watch coverage** — Active sessions
  automatically get filesystem watch coverage for native
  task writes when dispatched through the daemon.
- **Task count guidance** — After task operations, context
  now suggests creating two pending tasks: a verification
  step and a broader next-step task.

## 2026-04-03

### Performance Analysis: `stop-personal-repo-issues`

Audited `hooks/stop-personal-repo-issues` and surrounding utilities for performance
inefficiencies. Filed 7 issues:

- **perf(git): cache `getRepoSlug` per-cwd** — `git remote get-url origin` spawned 4 times
  per hook invocation for the same cwd; module-level cache eliminates 3 redundant subprocesses
  ([#499](https://github.com/mherod/swiz/issues/499), priority-high).
- **perf(stop): parallelize independent awaits in evaluate** — `readProjectState` and settings
  import have no dependency on PR/issue fetches but are awaited sequentially
  ([#500](https://github.com/mherod/swiz/issues/500)).
- **perf(stop-auditor): parallelize sibling session CI evidence scan** — `findCiEvidenceInSiblings`
  and `findCiEvidenceInAllSessions` loop sequentially over sessions with `readSessionTasks`
  ([#501](https://github.com/mherod/swiz/issues/501)).
- **perf(git): cache `getDefaultBranch`** — up to 5 sequential git subprocesses per call with
  no caching ([#502](https://github.com/mherod/swiz/issues/502)).
- **fix(stop): add `--limit` to `gh issue list` fallback** — CLI fallback path has no explicit
  bound ([#503](https://github.com/mherod/swiz/issues/503)).
- **refactor(stop): extract shared `feedbackPrCount`** — identical function defined in both
  `context.ts` and `action-plan.ts`
  ([#504](https://github.com/mherod/swiz/issues/504)).
- **fix(cooldown): remove dead `|| false` conditions** — redundant `|| false` in `isInCooldown`
  and `updateCooldown` ([#505](https://github.com/mherod/swiz/issues/505)).

## 2026-04-02

### Fixes

- **Daemon transcript monitor cooldown** — The worker-thread `TranscriptMonitor` stub for
  `CooldownRegistry.checkAndMark` always returned `false`, so hook cooldown never blocked
  daemon-triggered `postToolUse` / `notification` dispatches. Worker IPC now correlates
  `requestId` + `hookId` and awaits `cooldownCheckResponse` from the parent; the monitor
  awaits `checkAndMark` (sync or async). Added `transcript-monitor.test.ts` coverage
  (closes [#467](https://github.com/mherod/swiz/issues/467), commit `3d1b925`).

## 2026-03-29

### Improvements

- **Three-layer task dedup** — `subjectsOverlap` in `src/subject-fingerprint.ts` now
  uses phrase synonyms, stemmed+synonymized canonical word overlap, and semantic domain
  classification with workflow pipeline detection. Catches duplicates like
  "Run Collaboration Guard" / "Execute Task Preflight" and "Verify working tree is clean" /
  "Stage all uncommitted changes" that previously slipped through.
- Extracted `canonicalWords`, `wordOverlapRatio`, `domainOverlap`, and `hasSharedActionVerb`
  helpers to reduce `subjectsOverlap` cyclomatic complexity from 20 to under 10.

## 2026-03-28

### New Features

- **In-process task creation** — `createTaskInProcess()` in `src/tasks/task-service.ts`
  provides a core task creation utility with no console side-effects, usable from hooks
  and services without subprocess overhead. `createSessionTask()` in hook-utils now calls
  it directly instead of shelling out to `swiz tasks create`.
- **Shell string stripping** — `stripQuotedShellStrings()` in `hooks/utils/shell-patterns.ts`
  for safe command token matching after removing quoted content.

### Refactors

- Extracted issue-store replay logic into `src/issue-store-replay.ts` (net -426 lines).
- Reduced `createSessionTask` cyclomatic complexity from 14 to under 10 by extracting
  `writeSentinel`, `buildTaskCreateArgs`, and `createTaskViaSubprocess` helpers.
- `PromptAgentOptions` now extends `PromptOptions` for signal/timeout instead of duplicating fields.
- Simplified hook test files by reducing boilerplate across 6 test suites.

### Fixes

- Removed task recovery hooks that spawned ghost tasks.
- Staleness check now skips when an `in_progress` task exists.

## 2026-03-27

### New Features

- **Multi-layer Codex hooks discovery** — Codex CLI now discovers hooks from both
  global (`~/.codex/hooks.json`) and per-project (`<cwd>/.codex/hooks.json`) layers,
  matching the behavior of Claude Code, Cursor, and Gemini. `swiz hooks`, `swiz status`,
  and `swiz doctor` now aggregate and report all active hook layers (#405).

### Fixes

- Fixed daemon session API drift by adding a compat shim that remaps legacy field names
  (`selectedProject`, `selectedSession`, `limits`) to current API contract names
  (`selectedProjectCwd`, `selectedSessionId`, `limitProjects`). Old clients continue to
  work without requiring updates (#404).

## 2026-03-25

### Fixes

- Fixed `stop-quality-checks` hook running unconditionally — it now
  exits early unless `_effectiveSettings.qualityChecksGate` is
  explicitly `true`, making the hook opt-in by default.
- Fixed JSON extraction in hook output parser — replaced
  `lastIndexOf("{")` with reverse-line scanning so hooks that emit
  non-JSON lines after their JSON object are parsed correctly,
  eliminating `invalid-json` dispatch failures (closes #374).
- Fixed opaque malformed-input failures in `stop-auto-continue` —
  schema parse errors now log structured details; added hint for
  "Requested entity was not found" model errors.
- Fixed web mascot not updating when `src` prop changes — `<img>` is
  now force-remounted via `key` prop on source change.

### Refactors

- Extracted `isQualityChecksEnabled` helper from `stop-quality-checks`
  `main()`, reducing cyclomatic complexity from 11 to 10. Helper is
  exported and covered by unit tests.

## 2026-03-24

### New Features

- **Session-start self-heal pause** — full uninstall (`swiz uninstall`)
  now pauses the session-start self-heal hook so manifest drift does
  not silently re-add hooks after removal (#353).
- **CI completion notifications** — the daemon now notifies when
  watched CI runs complete (#334).
- **Dispatch timing logs** — structured phase-level timing is now
  logged per dispatch for diagnosing latency.
- **Quality checks gate** — new `qualityChecksGate` setting controls
  whether lint and typecheck run on session stop. Configurable at
  both global and project scope.
- **Project-scoped auto-continue** — `autoContinue` can now be
  overridden per-project, not just globally (#345).
- **Terminal and shell detection** — improved detection of terminal
  emulator and shell environment for hook behaviour.
- **Dismissive session-deferral detection** — the offensive language
  hook now catches "requires its own dedicated session" and similar
  premature-completion patterns.
- **Manifest `requiredSettings` filtering** — hooks can declare
  required settings; the dispatcher skips them at zero cost when
  those settings are disabled (#348).
- **"Stop hook" reframing detection** — the offensive-language hook
  now blocks agents that reframe user feedback as coming from a
  mechanical stop hook rather than authoritative instruction.
- **Auto-steer deferred for chat apps** — auto-steer is now skipped
  when the active application is a chat interface, avoiding phantom
  keystrokes in non-terminal windows.

### Fixes

- Fixed `swiz settings` CLI and web panel showing toggles in
  different orders — both now follow the registry canonical
  order (#352, #353).
- Fixed `swiz settings` label padding inconsistency — labels now
  align dynamically to the longest entry (#352).
- Fixed `swiz dispatch` subprocess hanging indefinitely after
  writing its result — open SQLite handles kept the event loop
  alive in CLI mode.
- Fixed `hasGitPushForceFlag` treating `--force` after `--` as a
  flag instead of a refspec — the end-of-flags sentinel is now
  handled correctly.
- Fixed session `autoContinue` unconditionally overriding project
  settings — now optional with nullish coalescing (#350).
- Fixed dollar-sign interpolation in `computeProjectedContent`
  inflating projected content when replacement strings contain
  shell examples (#354).
- Fixed stop-memory-size hook re-triggering repeatedly — added
  1-hour cooldown and 5-minute CLAUDE.md recency skip.
- Fixed reflection filler suggestion re-triggering after reflection
  was already completed — now checks CLAUDE.md mtime.
- Fixed `personalRepoIssuesGate` missing from CLI settings
  display (#346).
- Fixed worker pool deadlock and error recovery in daemon dispatch.
- Fixed `Bun.Transpiler` eagerly initialising at module load —
  deferred to first use so model-related tests don't fail when the
  transpiler is unavailable.
- Extended pre-push test timeout from 60 s to 600 s to prevent
  false-positive CI failures on slower machines.

## 2026-03-21

### New Features

- **Anthropomorphic fatigue detection** — the offensive language hook now
  catches 7 new patterns where agents claim time pressure, fatigue, or
  "fresh session" needs to justify stopping work. Covers fake duration
  claims, "not going to rush" reframing, "dedicated attention" stalling,
  sunk-cost commit counting, and fabricated time-cost claims.

### Changed

- **Offensive language hook now runs first** — moved `stop-offensive-language`
  to position 1 in the stop hook chain, ahead of `stop-completion-auditor`
  and all other stop hooks. Lazy language patterns are now caught before
  task completion or git status checks can fire.

### Fixes

- Fixed file permission mode on `posttooluse-task-audit-sync.ts` (644 → 755).

## 2026-03-20

### New Features

- **Idle project eviction** — the daemon now automatically frees
  memory for projects with no activity for one hour. Caches, file
  watchers, and sync timers are torn down and transparently
  re-registered on the next dispatch.
- **Backlog-deferral detection** — the offensive language hook now
  catches agents dismissing open issues as "backlog for future
  work", preventing premature session completion.

### Bug Fixes

- Settings changes now take effect in the daemon immediately
  instead of waiting for the cache TTL to expire. (#330)
- Projects can now configure `largeFileAllowPatterns` in
  `.swiz/config.json` to exempt known large files (e.g. test
  fixtures) from the large-file stop hook. (#329)
- Hook dispatches now receive the correct project working
  directory via `SWIZ_PROJECT_CWD`, fixing package-manager
  detection in multi-project daemon setups. (#328)

## 2026-03-17

### New Features

- **Skill-aware hook routing** — hooks now detect installed skills and
  route agents to the appropriate skill when problems are detected. (#324)
  - `stop-branch-conflicts.ts` → routes to `/pr-salvage` when branch
    is 50+ commits behind main
  - `posttooluse-pr-create-refine.ts` — new PostToolUse hook suggests
    `/refine-pr` after `gh pr create` with thin description
  - `stop-gdpr-data-models.ts` — new Stop hook suggests `/gdpr-analysis`
    when uncommitted changes touch user-data model files
- **Task auto-transition** — `pending` tasks automatically transition
  to `in_progress` when completed via `swiz tasks complete`.
- **Hook dispatch logs view** in the web dashboard.
- **Agent SDK integration** for `swiz continue` — uses in-process SDK
  instead of spawning CLI, with auto-approval, streaming, and message
  stream logging.
- **Progress spinner** for `swiz continue`.
- **Lefthook config validator** script.
- **OpenRouter AI provider** support.
- **Nested step hierarchies** in action plans.
- Structured tool rendering with category icons in dashboard.
- Dock navigation with project selector in dashboard.
- Motion tab indicator and view transitions in dashboard.
- NumberTicker animated stats and AnimatedBeam data-flow component.
- Parse task notifications and bash/interruption tags in transcript view.

### Bug Fixes

- Error handling in skill-routing hooks (safeParse, merge-tree guard).
- Allow edits to any markdown file without task gate.
- Forward stop hook block output to stdout in dispatch engine.
- Guard settings panel against stale defaults.
- Trigger issue sync on `git pull` and `git fetch`.
- Detect `gh api` REST PATCH closes for daemon sync.

### Improvements

- Flattened DOM hierarchy across dashboard views (session-nav,
  settings-panel, SessionMessages, transcript).
- Pre-prepared SQLite statements and batch deletes in issue store.
- Extracted view tabs, sub-components, and comprehensive design system
  with tokens.
- Added Agent SDK in-process usage rule to CLAUDE.md.

## 2026-03-15

### New Features

- Added animated number tickers to header stats and dashboard
  performance metrics — counters now spring-animate when
  values change.
- Added animated beam component for illustrating data flows
  between UI elements, powered by motion/react.
- Added sliding tab indicator with spring physics to the
  dashboard view toggle.
- Added staggered entrance animations to header stat chips.
- Added crossfade view transitions when switching between
  dashboard tabs.
- Added Issues, Tasks, and Transcript as dedicated full-page
  views in the dashboard navigation.

### Improvements

- Established a comprehensive design token system with
  standardised spacing scale, colour palette, shadow depths,
  and border radius variables.
- Aligned task and issue card styling to share consistent
  spacing, font sizes, border radius, and colour tokens.
- Reduced visual density across dashboard panels with
  tighter, more consistent spacing.

## 2026-03-14

### New Features

- Added REST API fallback for issue, PR, release, label,
  milestone, repo, workflow, secret, variable, and environment
  list commands — data fetches now degrade gracefully when
  GraphQL is rate-limited. (#294)
- Added session search and filter input to the dashboard.
- Added `--since`, `--until`, and `--hours` flags to
  `swiz transcript` for time-window filtering. (#288)
- Added `swiz issue cache-bust` subcommand to actively
  invalidate the issue store cache.
- Added native task-tool hints when listing incomplete tasks
  from a prior session — shows the correct tool name for the
  current agent (e.g. TodoWrite for Cursor). (#290)
- Added configurable dirty-worktree threshold setting to
  control when the commit gate fires.
- Added Tailwind CSS support to the daemon web UI.

### Bug Fixes

- Fixed REST fallback returning empty results for workflow
  runs due to mismatched response shape normalisation.
- Fixed status line showing empty data on API failure —
  now serves stale cached data with a 1-hour TTL instead.
- Fixed `ci_green:` evidence requiring a traceable commit SHA
  or run ID to prevent unverifiable CI claims.
- Fixed task evidence validation rejecting valid prefixes
  (`conclusion:`, `run:`, `no_ci:`). (#300)
- Fixed pre-existing dismissal hook missing cross-session
  patterns by scanning the full transcript. (#293)
- Fixed false task-gate exemptions when quoted argument
  values contained diagnostic keywords.
- Fixed concurrent auto-save conflicts in the settings panel
  by queuing retries instead of overlapping requests.
- Fixed push-wait cooldown reads returning zero due to
  synchronous file API race condition.

### Improvements

- Improved daemon performance by coalescing concurrent
  fetches and snapshot recomputations per project.
- Improved status line fetch reporting with discriminated
  error/stale/ok status indicators. Dashboard now surfaces
  fetch errors with red indicators.
- Improved hook deadlock recovery by exempting `ps`, `lsof`,
  `trash`, and `wc` from the task gate. (#297)
- Improved git index lock hook with more aggressive retry
  and graceful handling of missing `lsof`.

## 2026-03-13

### New Features

- Added live agent process tracking to the dashboard — sessions now
  show "Active now" based on verified running processes rather than
  message recency alone. (#274)
- Added global settings configuration to the dashboard, allowing
  management of Ambition mode, auto-continue, PR merge mode, and
  memory thresholds directly from the web UI.
- Added project settings page with collaboration mode, PR merge
  mode, and strict main-branch controls.
- Added project status dashboard with Vercel configuration at
  swiz.dev.
- Added GitHub CI status display to the status line, showing
  per-workflow run summaries with caching.
- Added session process controls and inline delete confirmation
  to the dashboard.
- Added task timing metadata with elapsed duration tracking.

### Bug Fixes

- Fixed stop-hook cooldown being too long (5 minutes instead of
  30 seconds), causing the hook to appear non-functional. (#277)
- Fixed daemon LaunchAgent restart behaviour — now auto-restarts
  on crashes without requiring manual intervention.
- Fixed dashboard rendering performance by memoising expensive
  computations and reducing redundant array operations. (#279)
- Fixed zero-value metrics being shown in dashboard stats.
- Fixed repeated transcript messages not being grouped correctly.

### Improvements

- Refactored `src/commands/tasks.ts` — extracted `EvidenceValidator`
  and `TaskService` into `src/tasks/` modules, reducing the command
  file from 1029 to 330 lines of pure CLI parsing. (#282)
- Improved `swiz tasks` and `swiz status` latency by using the
  session metadata index for O(1) lookups instead of scanning
  transcript files. (#276)
- Improved issue mutation replay performance by parallelising
  pending mutations with per-issue ordering. (#280)
- Improved daemon cache efficiency by bounding caches with LRU
  eviction and exposing cache hit/miss metrics.
- Improved framework and provider detection speed by converting
  blocking file I/O to async operations.
- Added swiz-buzz brand logo to the dashboard header.

## 2026-03-11

### New Features

- Added a live daemon dashboard with project activity, session timelines,
  dispatch counts, and per-session tool usage insights.
- Added CI watch integration in push workflows, including daemon-backed
  notifications when runs complete.
- Added daemon status and metrics visibility for quicker runtime checks of
  hook dispatch behaviour.

### Bug Fixes

- Fixed daemon web module loading by serving browser modules with the correct
  MIME type and handling favicon requests without noisy 404s.
- Fixed dashboard UX issues including panel layout stability, reduced flicker,
  and prioritised display of active sessions.

### Improvements

- Improved dashboard responsiveness by moving web asset routing into Bun's
  route table for more direct request handling.
- Improved stop-flow guidance by surfacing clearer human-required actions when
  maintenance or release steps are still pending.
- Consolidated LaunchAgent management into `src/launch-agents.ts` so daemon
  install/uninstall, prPoll installation, and cleanup daemon stop/restart all
  share one implementation for plist path resolution and `launchctl` actions.

## 2026-03-09

### Bug Fixes

- Fixed stop-flow behaviour when transcript analysis is unavailable: swiz now
  prints a ready-to-run continuation prompt instead of leaving the session
  blocked without actionable guidance. (#57)
- Fixed commit workflow behaviour in collaborative repositories by preventing
  direct commits to the default branch and guiding users to the safer path.
  (#226)
- Fixed state transition behaviour after commits on branches without valid
  upstream tracking, reducing incorrect review-state carryover. (#224)

### Improvements

- Improved task lifecycle reliability by applying strict shared session ID
  validation across task hooks before reading or writing task files.

### New Features

- Added `posttooluse-task-notify.ts`: async PostToolUse hook that delivers native
  macOS notifications for task lifecycle events — a `+` bell on `TaskCreate` and
  a status glyph (`▶`/`✓`/`✗`) on status-changing `TaskUpdate` calls. Resolves
  the task subject via `getSessionTaskPath()` for update events. Registered in
  the manifest with matcher `TaskUpdate|TaskCreate` and `async: true`.
- Added PR poll LaunchAgent (`swiz install --pr-poll`): polls GitHub notifications
  every 5 minutes for new PR activity (reviews, comments, mentions) and delivers
  a native macOS notification per item via `swiz-notify`.
  - `src/pr-notify.ts`: fetches `gh api /notifications` filtered to
    `subject.type === "PullRequest"` since `lastPolledAt`; persists state to
    `~/.swiz/pr-poll-state.json`.
  - `hooks/prpoll-notify.ts`: resolves the `swiz-notify` binary, maps notification
    reasons (`review_requested` → "Review requested", `comment` → "New comment",
    etc.) and delivers one notification per item.
  - `src/commands/install.ts` `installPrPoll()`: writes
    `~/Library/LaunchAgents/com.swiz.prpoll.plist` with `StartInterval: 300`
    and loads it with `launchctl load`.
- Added `HookGroup.scheduled?: boolean` to `src/manifest.ts`: marks events
  dispatched by external schedulers (LaunchAgent). `swiz install` skips scheduled
  groups when writing agent configs; `validateDispatchRoutes` skips them in the
  agent `eventMap` completeness check. `DISPATCH_ROUTES` in
  `src/dispatch/index.ts` includes `prPoll: "blocking"` so
  `swiz dispatch prPoll` routes correctly.
- README: 80 → 81 hooks, 10 → 11 event types; added `### PrPoll (1)` section
  documenting the scheduled dispatch model and `swiz install --pr-poll` usage.

### Fixes

- Committed file-mode change on `hooks/prpoll-notify.ts` (100644 → 100755)
  applied by the Biome formatter during the pre-push linting pass.

## 2026-03-08

### Fixes

- Reverted `subagentError` canonical event (`DISPATCH_ROUTES`, agent `eventMap`
  entries, manifest, CHANGELOG). `SubagentError` is not a real Claude Code hook
  event — the official list includes `SubagentStart` and `SubagentStop` but not
  `SubagentError`. The incorrect addition caused `~/.claude/settings.json` to
  emit an "Invalid key in record" validation error that silently skipped all hook
  configuration. Fixed the trailing comma in `settings.json` that prevented
  `swiz install` from parsing the file.

## 2026-03-07

### New Features

- `emitContext` in `hook-utils.ts` now automatically appends the current
  project state and allowed transitions (`State: <state> → [<next>, ...]`)
  to every PostToolUse `additionalContext`. The state line is injected only
  for PostToolUse events; SessionStart hooks manage their own state context
  to avoid breaking size budgets.
- `sessionstart-health-snapshot.ts` now injects the current project state
  and allowed transitions into the session context at startup, giving the
  agent immediate awareness of the current work phase.
- All 10 PostToolUse hooks now use the shared `emitContext` helper for
  their `additionalContext` output instead of inline `console.log(JSON.stringify(…))`.
  This consolidates state injection into a single code path.
- Added `sessionSwizSettingsSchema`, `projectSettingsSchema`, and
  `swizSettingsSchema` Zod schemas to `src/settings.ts` with explicit
  min/max constraints on all numeric fields (e.g. `narratorSpeed: min(0)/max(600)`,
  `memoryLineThreshold: int().min(1)`, `prAgeGateMinutes: int().min(0)`).
  `stateHistoryEntrySchema.timestamp` now enforces `.min(1)`.
- Added `--state <state>` as a required flag for `swiz tasks create`,
  `swiz tasks complete`, and `swiz tasks status` subcommands, ensuring
  every task operation records the current project work phase.

## 2026-03-06

### New Features

- Expanded `swiz dispatch` event coverage to include `notification`,
  `subagentStart`, `subagentStop`, and `sessionEnd` canonical events.
  Dispatch routing table, agent `eventMap` entries, and test fixtures
  updated in sync. (#137 test fixtures fixed in e4057fc.)

  Example: inject context on subagent start via `.swiz/config.json`:
  ```json
  {
    "hooks": [
      {
        "event": "subagentStart",
        "hooks": [{ "file": "hooks/my-subagent-init.ts" }]
      },
      {
        "event": "sessionEnd",
        "hooks": [{ "file": "hooks/my-session-cleanup.ts", "async": true }]
      }
    ]
  }
  ```
  Invoke manually: `swiz dispatch subagentStart < payload.json`
- Added slow-hook performance logging to `swiz dispatch`: when a hook
  takes longer than a configurable threshold, a warning is emitted with
  the hook name and elapsed time for easier diagnosis of sluggish hooks.
- Extended `swiz doctor` with an installed-config-scripts check that
  walks all configured agent settings files and verifies every script
  path referenced in hook command strings exists on disk and has execute
  permission. Uses a recursive command extractor (`collectCommandStrings`)
  that handles arbitrary JSON nesting depth and recognises `command`,
  `scripts`, `run`, and `args` keys. Quoted paths (double- and
  single-quoted) and `~/`/`$HOME/` expansions are handled correctly.
- Added source attribution to `swiz doctor` installed-config-scripts
  errors: each missing or non-executable path is labelled `(manifest)`
  or `(config)` so users can locate the definition without guessing.
- Implemented `swiz doctor --fix` repair mode for orphaned hook scripts
  (renames to `.disabled-by-swiz-{timestamp}`) and for missing
  config-referenced scripts (creates a minimal `#!/usr/bin/env bun`
  stub with `chmod 0o755`). The runner pre-computes the orphaned list
  and passes it to both the check and the fix to avoid redundant scans.
- Added `swiz doctor` manifest handler path validation check: verifies
  that every `file` field in the manifest resolves to an existing path
  under `hooks/`, catching regressions when hook files are renamed or
  deleted without updating the manifest.
- Added cross-agent skill conversion to `swiz skill` with tool
  remapping: translates agent-specific tool names (e.g. `Shell` ↔
  `Bash`) when converting skills between Claude Code and Cursor formats.
- Added cap of 4 in-progress tasks to `pretooluse-require-tasks` hook,
  preventing task-list bloat that could mask completed work.

### Refactors

- Replaced the two-level hardcoded hook-command walker in `swiz doctor`
  with a fully recursive `collectCommandStrings` function. The new
  implementation handles JSON values at any nesting depth and is shared
  between the existence/permission check and the dispatch-event extractor.
- Extracted `collectInstalledConfigScriptPaths` as a shared helper used
  by both `checkInstalledConfigScripts` and `collectExecutableScriptPaths`,
  eliminating duplicated config-walking logic.
- Refactored `checkOrphanedHookScripts` into `findOrphanedHookScripts`
  (returns raw `string[]`) + `buildOrphanedResult` (formats `CheckResult`),
  following the existing skill-conflicts `find/build/fix` pattern.
- Derived the doctor test fixture for dispatch entries dynamically from
  `manifest` and the Claude agent `eventMap` instead of a hardcoded JSON
  blob, so adding new events to the manifest automatically updates the
  expected fixture. (#137)

### Bug Fixes

- Fixed orphaned hook script detection to exclude library files (e.g.
  `hook-utils.ts`) that lack a `#!/usr/bin/env bun` shebang on their
  first line. Previously, any `.ts` file in `hooks/` not referenced by
  the manifest was flagged; now only entry-point scripts are considered.
- Fixed bun shebang detection to split on newlines and check the first
  line explicitly, rather than checking a fixed-byte prefix that could
  span the boundary between the shebang and the first import line.
- Fixed `checkInstalledConfigScripts` validation scope: the check now
  uses `collectExecutableScriptPaths` (manifest scripts + config scripts)
  instead of only config scripts, so manifest-referenced scripts are also
  covered by the existence and permission checks.
- Fixed orphaned script detection to exclude scripts referenced by agent
  config files (in addition to manifest-referenced scripts), preventing
  valid dispatcher scripts from being incorrectly flagged as orphaned.

- Added `--include-debug` flag to `swiz transcript`. When enabled,
  the command reads `~/.claude/debug/<sessionId>.txt` and interleaves
  debug log events inline with conversation turns, ordered by ISO
  timestamp. Debug lines render with a `│ HH:MM` prefix. The flag is
  a no-op when no debug file exists for the resolved session. (#121)

### Bug Fixes

- Hardened `parseDebugEvents` in the transcript command through eight
  successive fixes: NaN-timestamp events are preserved rather than
  dropped; leading continuation lines (no ISO prefix) are attached to
  a synthetic event so no input text is lost; a two-pass merge
  algorithm places malformed events at their original file position
  relative to sorted valid events; a three-key sort comparator
  (`_idx` → `iso` → `_seq`) guarantees a total order across all
  malformed records; a pre-sort normalisation pass guards against
  non-string `iso` and non-finite `_idx`/`_seq` values.
- Added a result-validation layer to `posttooluse-task-output` that
  prevents fabricated test-count claims. The hook now checks for
  Bun's completion marker (`Ran N test(s) across M file(s).`) before
  reporting an exact failure count; absent the marker (truncated
  output), the message uses "unknown number of" instead. Handles
  singular/plural variants (`1 test`, `1 file`) and strips ANSI
  escape sequences before matching so bold/dim-coloured summary lines
  are recognised correctly.
- Fixed `renderDebugLine` in `swiz transcript --include-debug` to strip
  ANSI escape sequences from debug log content before word-wrapping.
  Real Claude debug files embed colour codes inside log entries
  (e.g. `ESC[33mpendingESC[0m`); without stripping, `wordWrap`
  over-counted visual width (byte count vs. display columns), causing
  lines to wrap earlier than necessary and embedded resets to
  prematurely cancel the enclosing `DIM` style.

## 2026-03-05

### New Features

- Enhanced `swiz dispatch` command with improved hook tracing and event
  replay capabilities, making it easier to diagnose and debug hook
  behaviour across different event types.
- Expanded `swiz doctor` command diagnostics with deeper validation
  checks for agent configuration and hook installation status.
- Added collaboration policy module to refine branch scope gating
  validation, improving accuracy of push permission checks on feature
  branches and personal repositories.

### Bug Fixes

- Fixed session context compaction to enforce strict size budgets,
  preventing overly long task lists from inflating session context
  during continuation. Truncates task subjects and enforces hard
  context-size caps to keep resumed sessions responsive. (#118)

## 2026-03-04

### New Features

- Added per-stack hook filtering. Hooks in the manifest can now
  declare a `stacks` field (e.g. `["bun", "node"]`) so they only
  run in matching projects. Projects with no indicator files run
  all hooks unchanged — fully backwards compatible. (#67)
- Added framework-based hook conditions. Hook definitions can use
  `condition: "framework:nextjs"` (or any supported framework) to
  skip the hook in projects that don't use that framework. (#66)
- Added `swiz settings disable-hook` / `enable-hook` subcommands
  so individual hooks can be opted out without editing config
  files directly. Disabled hooks are shown with a `(disabled)`
  marker in `swiz settings show`. (#63)
- `swiz settings show` now displays detected project stacks (e.g.
  `bun`, `go`) alongside other project-level settings, making it
  easy to verify which stack-filtered hooks will run. (#67)

### Known Issues

- The narrator hook fires even when speak is disabled at the
  session level via `swiz settings --session disable speak`. The
  hook reads global settings before consuming stdin, so it never
  sees the session-level override. Fix tracked in
  [#78](https://github.com/mherod/swiz/issues/78).

## 2026-03-03

### Bug Fixes

- Fixed the main-branch scope gate failing in detached-HEAD state
  (common during CI checkouts) by extracting the target branch from
  the push command rather than relying on `--show-current`.
- Fixed the scope gate producing incorrect diffs in shallow clones
  by unshallowing the repository before resolving the diff range.
- Added a local-history fallback when `git fetch --unshallow` fails
  (e.g. no network or unavailable origin), so the scope gate no
  longer blocks pushes in offline shallow clones.

### Improvements

- The scope gate now tries three progressively weaker strategies to
  resolve the diff range: remote ref, merge-base, and single-commit
  fallback. Previously only the remote ref was attempted, causing
  false blocks on rebased or diverged branches.

## 2026-03-02

### New Features

- Added `swiz ci-wait <SHA>` command for timeout-based CI polling.
  Replaces manual `gh run watch`/`gh run view` loops with a single
  command that polls until completion or timeout.
- Added `swiz issue` command with `close`, `comment`, and `resolve`
  subcommands. Validates issue state before acting (e.g. prevents
  closing an already-closed issue).
- Added a main-branch scope gate that validates push size, file
  count, and contributor scope before allowing pushes directly to
  `main`. Prevents accidentally pushing large multi-contributor
  work without a pull request.
- Added a sandboxed-edits hook that restricts file writes to the
  current repository, preventing accidental edits to files outside
  the project directory.
- Added a commit-checks gate that enforces branch verification
  before `git commit`, complementing the existing push-checks gate.
- Added automatic task recovery after context compaction — if tasks
  are lost due to conversation compression, they are transparently
  recreated from the session task directory.
- Added a hook that normalises invalid `bun test --reporter` values
  to `dots` (the only supported reporter), preventing silent test
  failures from typos like `--reporter=dot`.

### Bug Fixes

- Fixed `createSessionTask` in `hook-utils.ts` writing its sentinel file
  even when the underlying `tasks-list.ts` subprocess failed. A non-zero
  exit no longer leaves an orphaned sentinel, so a failed task-creation
  attempt is retried on the next stop rather than silently skipped.
  **Upgrade impact:** sessions where task creation previously failed
  silently (disk-full, missing binary, corrupt task dir) will now retry
  on the next stop attempt instead of permanently losing the task prompt.
  ([#15](https://github.com/mherod/swiz/issues/15))
- Fixed `stop-auto-continue` path encoding so project directories with
  dots in their names (e.g. `/Users/jane.doe/project`) are found
  correctly. The encoding now replaces both `/` and `.` with `-`,
  matching Claude Code's own project-directory scheme.
  **Upgrade impact:** users whose home directory or project path contains
  a dot (common with dotted usernames or paths like `~/work/v2.0`) were
  silently receiving no task context in auto-continue suggestions; this
  is now resolved.
  ([#16](https://github.com/mherod/swiz/issues/16))
- Fixed `swiz dispatch` routing `subagentStart` and `subagentStop` events
  through `runBlocking` instead of `runContext`. Context output emitted by
  hooks on those events is now forwarded to the agent instead of being
  discarded.
  **Upgrade impact:** any hooks registered for `subagentStart` or
  `subagentStop` that use `emitContext()` were previously no-ops; they
  now inject their context as intended.
  ([#17](https://github.com/mherod/swiz/issues/17))
- Fixed a potential deadlock in `agent.ts` where large stderr output could
  fill the OS pipe buffer and stall the subprocess before it exited. Both
  stdout and stderr are now drained concurrently via `Promise.all`.
  **Upgrade impact:** `swiz continue` and other commands using the agent
  backend could hang indefinitely when the underlying CLI wrote more than
  ~64 KB to stderr (e.g. verbose error traces); they now complete
  normally.
  ([#18](https://github.com/mherod/swiz/issues/18))
- Fixed debug-statement detection producing false positives on ESLint
  `no-debugger` rule configuration lines.
- Fixed task and memory enforcement hooks deadlocking outside git
  repositories — they now skip enforcement gracefully when no
  project context is available.

## 2026-03-01

### New Features

- Added a hook that blocks `git push` unless the required branch and
  open-PR checks have already been run in the current session. Before
  any push, `git branch --show-current` and
  `gh pr list --state open --head <branch>` must have been executed.
  This prevents accidentally pushing large work directly to a shared
  branch or creating duplicate pull requests, by enforcing the
  verification steps as a mandatory gate rather than an optional
  reminder. (#13)
- Added a hook that blocks `git push` when the conversation transcript
  contains an explicit "do not push" instruction from the user,
  with an override when the user subsequently approves the push.
- `swiz transcript` now includes tool outputs alongside tool calls,
  giving a more complete picture of what happened in a session.
- Added a configurable push-gate setting (`swiz settings`) that can
  be enabled or disabled per project.

## 2026-02-28

### New Features

- Added a hook that blocks `@ts-ignore` and `@ts-nocheck` comments
  in TypeScript files. The TypeScript compiler's type errors must be
  fixed rather than silenced. If suppression is genuinely unavoidable
  (e.g. broken third-party types), `@ts-expect-error` is permitted
  as a last resort — but only when accompanied by a description
  explaining why. Bare `@ts-expect-error` with no reason is also
  rejected.
- Added heuristic approval/rejection scoring for PR review sentiment,
  allowing hooks to detect whether a review is broadly positive or
  negative without relying solely on GitHub's formal review state.
- `swiz status` now detects the current agent environment
  automatically — Claude Code, Cursor, Codex, and Gemini CLI are
  all identified via environment variables or parent-process
  inspection.
- Issue-priority stop hook now ranks issues by label heuristics
  (e.g. `bug` > `enhancement` > `question`) and supports a broader
  set of real-world label conventions.
- Auto-continue suggestions now include a session critique that
  highlights blind spots and missed opportunities, encouraging more
  thorough autonomous work.

### Bug Fixes

- Fixed CI-status stop hook incorrectly blocking on `main`/`master`
  branches where no PR-based CI run exists.
- Fixed `as any` cast detection producing false positives on casts
  inside string literals and comments.

## 2026-02-27

### New Features

- Added per-option help text to all CLI commands — running
  `swiz <command> --help` now describes each flag individually.
- `swiz cleanup` now decodes project paths in its output, shows
  kept session sizes, supports hour/day units for `--older-than`,
  and marks stale projects (where the original path no longer
  exists) as eligible for cleanup.
- Added a hook that automatically completes Commit and Push tasks
  after the corresponding git operations succeed, and creates a
  CI-watch task after `git push` to track the pipeline.
- Stop hook now includes issue titles (not just numbers) in its
  message, and prioritises PRs with `CHANGES_REQUESTED` status
  over open issues.
- Issue-checking stop hook now works for organisation repos,
  filtering to self-authored or self-assigned issues.
- Added session-level settings overrides via `swiz settings`.
- Added a plugin catalogue (`swiz marketplace`) for discovering
  and managing swiz plugins.
- Added command wrapper skills for common plugin operations.
- Read-only git commands (`git log`, `git status`, `git diff`,
  etc.) and `ls`/`grep` are now exempt from the task-creation
  requirement, so quick inspections no longer force a task to be
  created first.
- `swiz install` now shows a spinner with status messages during
  hook installation.

### Bug Fixes

- Fixed ESLint config-strength hook to recognise the modern flat config
  format (`eslint.config.js`). Projects using ESLint 9's flat config now
  have their rule-strength correctly enforced.
- Fixed Ruby debug-statement detection producing false positives on
  identifiers that contain "byebug" as a substring (e.g. helper method
  names). Only bare `byebug` and `binding.pry` calls are now flagged.
- Fixed Prettier hook running even when Prettier was not installed in
  the project. (#6)
- Fixed dispatch not enforcing per-hook timeouts from the manifest.
  (#5)

### Improvements

- Auto-continue suggestions now reference whichever skills are actually
  installed (e.g. `/changelog`, `/update-memory`) rather than showing
  generic advice, making autonomous next-step hints more actionable.
- Auto-continue analysis now incorporates changelog staleness awareness,
  prompting agents to update `CHANGELOG.md` when it has fallen behind.
- Session learnings are now written to persistent memory as part of the
  auto-continue workflow, so useful patterns are retained across sessions.
- Memory-updater directive patterns are now broader, catching more
  variations of update-memory instructions. (#7)

## 2026-02-26

### New Features

- Added cross-agent compatibility — `swiz install` now generates
  configuration for Claude Code, Cursor, Gemini CLI, and Codex,
  with automatic tool-name and event-name translation per agent.
- Added `swiz dispatch` command for runtime hook fan-out, allowing
  hooks to be invoked programmatically outside of agent events.
- Added `swiz transcript` command to view chat history with
  `--head`/`--tail` turn-count options and `--auto-reply` for
  AI-suggested user continuations.
- Added `swiz continue` command to resume sessions with an
  AI-generated next step, using the available agent backend.
- Added `swiz cleanup` command for managing and pruning session
  data.
- Added `swiz session` command to inspect the current session.
- Added a stop-auto-continue hook that generates autonomous
  next-step suggestions when a session ends, encouraging
  continuous productive work.
- Added a stop-memory-updater hook that prompts agents to persist
  session learnings to long-term memory. (closes #4)
- Added a shell shim for agent-agnostic command interception,
  allowing hooks to intercept CLI commands regardless of agent.
- Merge-based install now preserves user hooks alongside swiz
  hooks, so custom configurations are not overwritten.
- Added Bun availability checks at install time and runtime, with
  clear error messages when Bun is not found.
- Package manager and runtime enforcement is now project-aware,
  only enforcing Bun in projects that use it.
- `grep` and `find` command restrictions are now gentle nudges
  (suggesting `rg` and `Glob` alternatives) rather than hard
  blocks.
- `swiz skill` now supports `--no-front-matter` to strip YAML
  headers from skill output.
- Added session-start hook that checks plugin environment
  variables and warns about missing configuration.

### Bug Fixes

- Fixed dispatch not passing the agent event name correctly, so
  `hookEventName` now matches the agent's configuration format.
- Fixed async hooks not firing when a blocking hook short-circuited
  the dispatch — async hooks now always run.
- Fixed issue-checking stop hook incorrectly showing issues labelled
  `blocked`, `upstream`, `wontfix`, `duplicate`, or `backlog`.

## 2026-02-25

### New Features

- Initial release of the swiz CLI.
- Added `swiz skill` command to read and expand skill files with
  inline command expansion.
- Added `swiz hooks` command to inspect installed hooks across
  agents.
- Added `swiz install` command to install swiz hooks into the
  current agent's configuration.
- Added `swiz tasks` command for session-scoped task management,
  allowing agents to create, list, and update tasks per session.
