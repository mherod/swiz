# CLAUDE.md
Direct guide for Swiz CLI project conventions.
---
description: Swiz CLI project guidance — architecture, patterns, and conventions.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---
## Runtime
- Use Bun only. DO NOT use Node.js, npm, pnpm, vite, dotenv, or Node-specific tooling.
- Use `bun <file>`, `bun test`, `bun install`, `bun run index.ts`, `bun --hot index.ts`, `bun link`.
- Prefer `swiz <command>` for normal CLI usage.
- Use `bun run index.ts <command>` when you must guarantee execution against the current checkout (avoid PATH/global `swiz` version drift).
- Use `Bun.file()` and `Bun.write()` for file I/O.
- Use `node:fs/promises` only for directory operations (`readdir`, `mkdir`, `stat`).
## CLI Architecture
- Entry point: `index.ts`; command registration: `registerCommand()` in `src/cli.ts`.
- `src/types.ts` `Command` interface fields: `name`, `description`, optional `usage`, `run(args)`.
- Add command: create `src/commands/<name>.ts` exporting `Command`, then register in `index.ts`.
- DO NOT add routing or arg-parsing libraries; keep manual `process.argv` parsing.
- **DO**: Use `@anthropic-ai/claude-agent-sdk` `query()` for Claude interactions. **DON'T** spawn `claude` CLI via `Bun.spawn` — use SDK `continue`/`resume` instead.
- **Complexity**: Extract helpers to reduce cyclomatic complexity and max-lines violations.
- **Consolidate utilities**: Multiple functions → single canonical module (e.g., `agent-paths.ts`). Re-export from originals.
## Project Root Resolution
- Resolve project root with `dirname(Bun.main)`.
- DO NOT use `join(dirname(Bun.main), "..")`; it breaks `bun link` execution.
## Hook System
- Hooks live in `hooks/`; canonical manifest is `manifest` in `src/manifest.ts`.
- Canonical events are camelCase: `stop`, `preToolUse`, `postToolUse`, `sessionStart`, `userPromptSubmit`, `preCommit`.
- Translation: `EVENT_MAP` (canonical→agent events), `TOOL_ALIASES` (per-agent tool names). Claude uses nested matchers in `settings.json`; Cursor uses flat list in `hooks.json`.
- Add hook flow (agent events):
  1. Add `hooks/<name>.ts`.
  2. Add entry to `manifest` in `src/manifest.ts`.
  3. If new event: update `DISPATCH_ROUTES` in `src/dispatch/index.ts` and each agent `eventMap` in `src/agents.ts`.
  4. Run `swiz install --dry-run`.
  5. Run `swiz install` to write dispatch entries.
- Add hook flow (non-agent/scheduled events like `preCommit`, `prPoll`):
  1. Add `hooks/<name>.ts`.
  2. Add entry to `manifest` with `scheduled: true` — skips agent eventMap validation and `swiz install`.
  3. Add `DISPATCH_ROUTES` entry in `src/dispatch/index.ts`.
  4. Add event to `TOOL_NAME_OPTIONAL_EVENTS` in `src/dispatch/execute.ts`.
  5. Add `DISPATCH_TIMEOUTS` entry in `src/manifest.ts`.
  6. Wire into `lefthook.yml` with `SWIZ_DIRECT=1 bun run index.ts dispatch <event>`.
- Keep `DISPATCH_ROUTES`, `manifest`, and agent `eventMap` synchronized.
- `validateDispatchRoutes()` in `src/manifest.ts` must pass from both `swiz dispatch` and `swiz install`.
- Keep `src/dispatch-routing.test.ts` passing.
- DO NOT duplicate preToolUse matcher strings across groups — `manifest.find()` returns the first match, shadowing the original. Add hooks to the existing group.
- DO NOT add sync hooks to unmatchered preToolUse groups — `manifest.test.ts` requires `matcher` for groups with sync hooks; async-only groups are exempt.
- DO NOT hard-code agent-specific event names or tool names in hook scripts.
- `classifyHookOutput` validates stdout against `hookOutputSchema`; `"invalid-schema"` on failure. Requires `systemMessage`/`reason`/`stopReason`/`additionalContext`; `{}` valid. Stop normalized via `stopHookOutputSchema`.
- In `lefthook.yml`, use `SWIZ_DIRECT=1 bun run index.ts dispatch <event>`; omitting triggers the global-link check.
- Hooks scanning staged diffs for code patterns (`.only`, `fdescribe`, etc.) must exclude `hooks/` and test files via `FOCUSED_TEST_EXCLUDE_RE` — regex definitions in hook source trigger false positives on themselves.
- **Inline SwizHook imports**: Avoid `hook-utils.ts`, `git-utils.ts` (circular deps). Safe: `tool-matchers.ts`, `git-helpers.ts`, `shell-patterns.ts`, `skill-utils.ts`, `node-modules-path.ts`, `command-utils.ts`, `utils/edit-projection.ts`, `utils/inline-hook-helpers.ts`, `utils/package-detection.ts`, `hooks/schemas.ts`.
- **Inline SwizHook migration**: Helper extraction and hook migration ship as one commit — run `bun run typecheck` after extraction, then migrate and commit together.
- **Inline SwizHook output**: Use `preToolUseAllow()`/`preToolUseDeny()` from `SwizHook.ts` — return objects instead of calling `process.exit`. Use `runSwizHookAsMain()` for standalone `import.meta.main` compatibility.
- **Inline SwizHook import.meta.main**: Use `if (import.meta.main) await runSwizHookAsMain(hook)`. DON'T keep `Bun.stdin.json()` alongside — double-read causes silent exit 0.
- **Debt marker self-detection**: Hook files containing keywords in `//` comments trigger `pretooluse-todo-tracker`. Use JSDoc `/** */` format for headers or dynamic regex construction (`"TO" + "DO"`) to avoid self-detection.
## Phase 2 Hook Extraction
- **6-module structure**: types → context → validators → action-plan → evaluate → wrapper.
- **Deduplication**: Export from core, import by orchestrator only. Delete re-export wrappers.
- Reference: `PHASE_2_EXTRACTION_PATTERN.md`.
## Writing Hooks
- Update `README.md` whenever `src/manifest.ts` changes.
- `src/readme-hook-counts.test.ts` invariants:
  1. `### <EventName> (N)` heading count matches section rows.
  2. README intro `**N hooks**` (line 7) matches manifest total.
  3. Every README hook filename exists on disk.
- Per hook: increment section count, add table row, increment `**N hooks**`, run `bun test src/readme-hook-counts.test.ts`.
- Hooks are TypeScript. Use `hooks/hook-utils.ts`, read JSON stdin, exit 0.
- Output helpers: `allowPreToolUse`, `denyPreToolUse`, `emitContext`, `blockStop`/`blockStopRaw`, etc. — call `process.exit(0)`. **DON'T** write raw `console.log(JSON.stringify(...))`.
- **Subprocess timeout**: Use `spawnWithTimeout(cmd, { cwd, timeoutMs })`. DON'T use `Bun.spawn()` with manual timers.
- **Dispatch abort**: Strategies with `AbortController` must listen on `ctx.signal` (from `DispatchRequest.signal` or `HookStrategyContext.signal`).
- **Dispatch payload enrichment**: `performDispatch` injects `_effectiveSettings` and `_terminal` into payload.
- **Cursor cwd**: `normalizeAgentHookPayload` uses `workspace_roots` if cwd empty/outside. Captures in `/tmp/swiz-incoming/` (~10m retention); `SWIZ_CAPTURE_INCOMING=0` disables.
- **File-path guard**: Use `filePathGuardHook(predicate, denyReason, allowMsg?)` for file-path PreToolUse hooks.
- **Git utilities**: `src/utils/hook-utils.ts` (regexes, extractors, helpers), `src/git-helpers.ts` (classifiers, queries). DO NOT define locally; import canonical source.
- **GitHub API throttle**: `await acquireGhSlot()` before `gh` calls (4500 req/hr limit). Exempt: `gh auth status`, `gh run watch`.
- Skill helpers: `skillExists`, `skillAdvice`.
- Cross-agent tool checks: `isShellTool`, `isEditTool`, `isFileEditTool`, `isCodeChangeTool`, `isTaskTool`, `isTaskCreateTool`.
- Task exemptions: read-only git, `gh`, `swiz`, setup, recovery. DON'T add broad patterns to `RECOVERY_CMD_RE`.
- Package manager helpers: `detectPackageManager()`, `detectPkgRunner()`.
- Typed inputs: use schema parse from `hooks/schemas.ts`; **DON'T** use `as { ... }` casts for stdin. Hook/settings/state schemas in `hooks/schemas.ts` and `src/settings/persistence.ts`.
- **Hook cooldowns**: `cooldownSeconds` skips re-runs within the window (per hook+cwd).
- **Auto-steer**: `scheduleAutoSteer(sessionId, message, trigger?, cwd?)` with triggers: `next_turn`, `after_commit`, `after_all_tasks_complete`, `on_session_stop`.
- **DO**: Use `resolveThresholds(cwd)` for memory thresholds (default 5000). Never hardcode.
- **DO**: Use `computeProjectedContent()` — suppresses interpolation. DON'T call `.replace()`. Fail-open on errors.
- NFKC-normalize `new_string`/`content`/`old_string` before pattern matching in content-inspecting hooks: `.normalize("NFKC")`. Enforced by `src/nfkc-enforcement.test.ts`. Exempt hooks must be listed in `EXEMPT_HOOKS`.
- Use `TEST_FILE_RE` (`.test.ts`, `.spec.ts`, `__tests__/`, `/test/`) for test-file exclusions.
- DO NOT test external repo code here; file issue in owning repo.
- Track current diff file from `+++ b/<path>` headers; apply file-level exclusions via that path.
- Use `sanitizeSessionId()` for `/tmp` names.
- DO: Use `src/temp-paths.ts` for `/tmp` paths; no `/tmp/*` literals.
- DO NOT hardcode `/tmp` sentinel session IDs in tests; use unique IDs or `mtime` checks.
- For `pgrep` checks, use ancestry (`process.ppid`) and scope (`lsof -p <pid> -d cwd -Fn`).
- Reference: `hooks/stop-ship-checklist.ts` (git+CI+issues). `hooks/stop-git-status.ts` exports `collectGitWorkflowStop`/`evaluateStopGitStatus`.
- For `~/.claude/projects/` lookups, import `projectKeyFromCwd` from `src/transcript-utils.ts` — DO NOT reimplement.
- In `hook-utils.ts`, lazy `await import(...)` for `projectKeyFromCwd` (circular import avoidance).
- Workflow enforcement: scan `transcript_path` for evidence — no extra state files.
- `pretooluse-update-memory-enforcement.ts` requires reading `update-memory/SKILL.md` and writing `.md` before unblocking.
- Cross-repo issue guidance: `buildIssueGuidance()` in `hook-utils.ts`. Generic: `buildIssueGuidance(null)`; cross-repo: `buildIssueGuidance(repo, {crossRepo:true, hostname})`.
- **DO**: When extracting from a shared module, re-export all types downstream consumers import. Verify `pnpm typecheck` before committing.
## Task Data
- Task storage: `createDefaultTaskStore()` in `src/task-roots.ts` via `getTaskRoots()` in `src/provider-adapters.ts`.
- Cross-session checks: `stop-completion-auditor.ts` scans `~/.claude/tasks/` via `readSessionTasks()`.
- **Task state cache**: `TaskStateCache` (`src/tasks/task-state-cache.ts`) — LRU + `fs.watch` + `applyTaskUpdate()` write-through. `getTasksFresh()` forces disk reload when no watcher/openCount zero. **DO**: `watchSession()` on daemon activate. **DON'T**: Trust cache for stop hooks — use `readSessionTasksFresh()`.
- **In-memory event state**: `src/tasks/task-event-state.ts` — `Map<sessionId, EventTaskState[]>` updated by PostToolUse hooks. `posttooluse-task-count-context` reads `getSessionEventState()` first (zero I/O), falls back to disk + `applyMutationOverlay`.
- **Last-task-standing enforcement**: `updateStatus()` calls unconditional `validateLastTaskStanding`; on empty-would-result, `promoteNextTaskFromIssues()` auto-creates a successor from `IssueStore` ready issues. Blocks only if no candidate. `skipLastTaskGuard` for explicit overrides.
- **Native task file lifecycle**: Native `TaskCreate`/`TaskUpdate` DELETE `.json` files on completion; session dir keeps only `.highwatermark` + `.lock`. `readSessionTasksFresh` returns `[]` on clean sessions. **DON'T** treat `allTasks.length === 0` as "no tasks created" in stop hooks.
- **CI evidence field**: Native `TaskUpdate description` stores evidence in `t.description`, NOT `t.completionEvidence` (only set by `swiz tasks complete --evidence`). Stop hooks MUST check both. See `ci-evidence-validator.ts::taskHasCiEvidence`.
- **CI evidence transcript fallback**: When `allTasks = []`, `ci-evidence-validator` scans `TranscriptSummary.bashCommands` for CI verification commands. Regex: `CI_CMD_RE = /gh run (?:view|watch)|swiz ci.?wait/`.

## Task Lifecycle & Enforcement

**State Machine:** `pending` → `in_progress` → `completed` (or `deleted`).

**Enforcement (3-gate system):**
1. **Stop gate** (`hooks/stop-incomplete-tasks/evaluate.ts`): Blocks stop if incomplete tasks remain. Allow only when all tasks `completed` or `deleted`.
2. **Transition gate** (`pretooluse-task-transition-validator.ts`): Block `TaskUpdate` from `pending` to `completed`. Require `pending` → `in_progress` → `completed`.
3. **Phantom gate** (`pretooluse-phantom-task-detector.ts`): Block `TaskUpdate` to `completed` without substantive tool calls (Edit, Write, Bash, Read, Skill, Glob, Grep). Require evidence in description.

**Rate limit:** `pretooluse-task-completion-rate-limit.ts` — max 2 completions per 5 seconds. Requires `TaskList` before each completion.

**Deduplication:** `deduplicateStaleTasks()` auto-completes pending tasks matching completed subjects.

**Exemptions:** Agents where `AgentDef.tasksEnabled=false` (Codex, Junie) skip all task enforcement.

**Evidence prefixes:** `commit:<sha>`, `pr:<url>`, `file:<path>`, `test:<result>`, `note:`. Example: `test:5_pass_0_fail -- integration verified`.

**Workflow:** `TaskCreate` → `in_progress` → work → evidence → `completed`. Maintain ≥2 pending as buffer.

- After compaction: `TaskList`, close stale tasks via `git log --oneline -3`.
- `pretooluse-require-tasks.ts` blocks Edit/Write/Bash unless ≥2 incomplete AND ≥1 `pending`.
- Prior-session task blocks: complete `in_progress` tasks (`TaskUpdate status: completed`) before new Bash.
- One verb per task subject; `pretooluse-task-subject-validation.ts` rejects compound subjects.
- Run `/commit` before `git commit`; `pretooluse-commit-skill-gate` enforces it.
- `/commit` checks: task preflight, Conventional Commits `<type>(<scope>): <summary>`.
- Call task tools every 10 calls; staleness gate at 20.
- **DO**: Use native task tools, not `swiz tasks` CLI (exception: `swiz tasks adopt`).
- **DO**: Use `createTaskInProcess()` from `src/tasks/task-service.ts` or `createSessionTask()` from `hook-utils.ts` in hooks.
- Call `TaskUpdate` after each file, at least every 3 edits.
- Create tasks before non-exempt Bash.
- **DON'T**: Complete last in-progress task while shell commands remain. Keep ≥1 `in_progress` until all shell work finishes.
- Exempt Bash: `ls`, `rg`, `grep`; read-only `git` (`log`, `status`, `diff`, `show`, `branch`, `remote`, `rev-parse`); `git push/pull/fetch`; all `gh`; `swiz issue close/comment`.
- `find` is not exempt; use `rg` or Glob.
- DO NOT create task solely for `git push`, `gh`, or `swiz issue close/comment` (`SWIZ_ISSUE_RE`, `GH_CMD_RE`).
- Stop requires no uncommitted changes (`stop-git-status.sh`).
- **Task completion**: `TaskUpdate` `taskId` + `status: completed`; evidence in `description`: `commit:`, `pr:`, `file:`, `test:`, `note:`.
- **Subject changes**: `TaskUpdate` `subject`/`description` — not the CLI.
- **DON'T**: Assume CI success from partial output. Confirm every job: `gh run view <run-id> --json conclusion,status,jobs`.
- **DON'T** commit untracked files (`.lock`, local state) without checking `.gitignore` first — stop hooks flag all uncommitted files regardless.
- After each `CLAUDE.md` edit, run `wc -w CLAUDE.md`; run `/compact-memory` near threshold.
- Before issue labeling, run `gh label list`. After `gh issue create`, run `/refine-issue <number>`.
- DON'T use `$(cat <<'EOF')` in `gh issue create --body` — write body to `/tmp/swiz-issue-N.md`, use `--body-file`.
## Standard Work Sequence
- Order: TaskCreate→in_progress → Edit/Bash → git add+commit → TaskUpdate→completed → SHA capture → `git log origin/main..HEAD` → `swiz push-wait` → `swiz ci-wait $SHA --timeout 300` → confirm CI.
- Keep push task `in_progress` until `gh run view --json` confirms. Use `swiz push-wait`/`swiz ci-wait`; no sleeps, no `--force-with-lease`.
- Don't call `TaskUpdate`/`TaskList` during push/CI. Don't stop after commit without push. `TaskOutput` timeout ≤ 120000ms.
- `swiz issue resolve <number> --body "<text>"`; `Fixes #N` auto-closes on push. DON'T close as `duplicate`/`wontfix` without evidence.
## Push and CI
- Repo is solo (`mherod/swiz`); push to `main`.
- **DO**: Run `swiz settings` before `/commit`, `/push`, or `/rebase-and-merge-into-main`.
- **DO**: Treat `.swiz/config.json` as authoritative for collaboration/trunk/branch policy; stay on `main` in solo+trunk mode.
- Run `/push` before `git push`; PreToolUse push gate requires it.
- CI `paths-ignore`: `.claude/**`, `docs/**` — only those paths skip; markdown triggers CI.
- Pre-push: (0) `/push` collab guard (1) `git log origin/main..HEAD` (2) branch+PR check (3) capture SHA (4) `git push` (5) `gh run list --commit "$SHA" --limit 15` (6) `gh run watch` (7) `gh run view --json conclusion,status,jobs`.
- DO NOT use `gh run view --commit <SHA>`; list-by-commit then view-by-id.
- During cooldown use `swiz push-wait origin <branch>` instead of raw `git push`.
- No `--no-verify`; pre-push runs `bun test`; CI jobs `lint -> typecheck -> test` must pass.
- Pre-push `bun test` may fail with `proc.stdin.write` TypeError (`Bun.spawn` exhaustion). Run failing test in isolation; if it passes, retry.
- Verify CI with `gh run view --json`; `gh run watch` alone is insufficient.
- **DO**: Before stop after push: verify CI status + update tasks.
- DO NOT block waiting for CI. Check once with `gh run view`; `in_progress` is acceptable — pre-push ran full test suite.
- `github.base_ref` is empty on `push` events; use only on `pull_request`/`pull_request_target`.

- Push-command parsing: token-parse to distinguish `git push --force` vs `git push -- --force`, including `-C <path>` global options.
- DON'T call `TaskUpdate`/`TaskList` after push starts. DON'T stop with unpushed commits.
- DON'T push to `main`/`master` without Step 0 collaboration guard. DON'T skip `git log origin/main..HEAD --oneline` pre-push review. DON'T run branch/collaboration/open-PR checks after push.
- DON'T add `Co-Authored-By` trailers (commitlint enforced). DON'T use destructive git (`revert`, `restore`, `stash`, `reset --hard`, `checkout -- <file>`); use `reflog`. Exception: `stash list`/`stash show` (read-only).
- DO: Read full file before reverting edits — Biome auto-formatting changes other sections.
## Daemon
- `src/commands/daemon.ts`: long-lived `Bun.serve` on port 7943; serves multiple projects simultaneously — scope per-project state by `cwd`.
- Endpoints: `/health`, `/dispatch` (POST), `/status-line/snapshot` (POST), `/metrics` (GET), `/ci-watch` (POST), `/ci-watches` (GET).
- `swiz daemon status` fetches `/metrics`. Metrics: in-memory only, tracked globally and per-project.
- LaunchAgent: `~/Library/LaunchAgents/com.swiz.daemon.plist`; `swiz daemon --install` / `--uninstall`.
- **DO**: In daemon-served `src/web/**` modules, use browser-resolvable imports only (`./`, `../`, `/web/...`). **DON'T** use bare package imports unless daemon adds import-map/bundling support.
- **DO**: After web-import changes, restart daemon (`lsof -ti tcp:7943 | xargs -r kill && bun run index.ts daemon --port 7943`).
- **DO**: Use `IssueStore` (`src/issue-store.ts`) for issues/PRs/CI. **DON'T** use per-project file caches — `~/.swiz/issues.db` replaces them.
- **DO**: Prefer `gh api` (REST) over `gh issue view`/`gh pr list` (GraphQL) — higher rate limits.
- **Hook installation**: `swiz install` writes dispatch entries. `sessionstart-self-heal` re-installs if missing. Run `swiz install` after hook changes; verify with `swiz doctor`.
## Settings Configuration
- Separate state files for runtime data (`.swiz/context-stats.json`); never mix into config (`.swiz/config.json`).
- 3-tier resolution: `project > user > default`. Track source per value, not per group. Label with `(project)`, `(user)`, `(default)`.
- Show all effective values; never hide user/default. No shared `source` for multiple settings.
- Adding boolean setting (global): update `types.ts`, `registry.ts`, `persistence.ts`, `resolution.ts`, `settings.ts`, `settings-panel.tsx`, `settings.test.ts` (7 files).
## CLI Error Handling
- In `src/commands/`, throw errors instead of `process.exit(1)`.
- `src/cli.ts` handles command errors via `process.exitCode = 1`.
- `src/commands/continue.ts`: stream Agent SDK messages; `process.exitCode = 1` on non-success.
- Hook scripts (`hooks/*.ts`) are the exception: `process.exit(0)` is intentional.
- In CI/hook scripts, do not use `console.log` for status/debug; use `console.error`.
- `src/debug-logging.test.ts` allowlists `console.*`; elsewhere use `debugLog` from `./debug.ts`. Allowlist edits need a justification comment in the test.
- Reference implementations: `src/issue-store.ts`, `src/manifest.ts`, `src/commands/tasks.ts`.
## Conventions
- DO NOT use top-level `await` in `src/` — use lazy async (`let cache; async load() {...}`). Hooks exempt.
- DO NOT embed ESC (0x1b) in regex literals; construct at runtime. See `hooks/posttooluse-task-output.ts` `ANSI_RE`.
- When parsing bun test output, check `/\bRan \d+ tests? across \d+ files?\./`; if absent, emit "unknown number of". Strip ANSI before matching.
- **DO**: Rename declarations and all usages in one edit — splits in PreToolUse hooks cause deadlocks. **DON'T** add unrequested renames.
- **CRITICAL**: In self-referential PreToolUse hooks, add import first, then usage in a second edit. Reversed order deadlocks the session; only `git checkout -- <file>` recovers.
- **DO**: When removing utility functions, grep usages and remove atomically. Removing only the definition leaves broken imports.
- DO: Read every file in full before editing — snippets miss conflicts and patterns in other sections.
- Use ANSI escape codes directly; do not add color libraries.
- Prefer `Bun.spawn(["sh", "-c", cmd])` for shell execution in skills/hooks.
- With piped `Bun.spawn`, drain stdout/stderr concurrently via `Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])` before `await proc.exited`.
- Hooks are `.ts` and run as `bun hooks/<file>.ts`.
- Settings writes must create `.bak` backup first.
- Stop hooks inject session tasks from `~/.claude/tasks/<session_id>/`; format `IN PROGRESS` before `COMPLETED`.
- Stop-memory prompts must include `Cause: <cause>`.
- On `MEMORY CAPTURE ENFORCEMENT`, read `/update-memory/SKILL.md`, edit `CLAUDE.md`, resolve immediately.
- When unblocking a gated session: complete prior task with evidence, create `in_progress` task before tool calls.
- `pretooluse-require-tasks.ts` and `pretooluse-update-memory-enforcement.ts` must skip outside git repos or when `CLAUDE.md` is missing; guard with `isGitRepo(cwd)` + upward search, else `process.exit(0)`.
- **DO**: Own every diagnostic — investigate all test failures before completing tasks.
- Test Biome rule changes with `biome check .` (not `biome check src/`); add overrides for directories with valid console usage.
- Bun test reporter: `--reporter=dots --concurrent`. Run once without pipe — piped re-runs trigger repeated-test hook.
- **DO**: Edit a file between `bun run format` and `bun run lint` — hook detects no file changes on consecutive runs.
- No `cd` in Bash; use absolute paths, `git -C`, `pnpm --prefix`, or `cwd` in `Bun.spawn()`.
- `sed -i`/`sed > file`, `awk > file` blocked; read-only pipelines OK. Use `bun -e` or `jq` (not `python`). Use `trash` (not `rm`).
- DO NOT edit `~/.claude/hooks/` or `~/.claude/skills/`; they are external repos. For cross-repo bugs, file an issue with error, root cause, fix, and criteria.
- **DO NOT mark tasks complete without shipped code.** Always: modify source, verify `git diff`, commit, then mark complete.
- `REMINDER_FRAGMENT` re-triggers memory enforcement; 30-min `CLAUDE.md` mtime cooldown. Run `swiz install` after hook changes.
- Cache-key generation: use `getCanonicalPathHash()` in `hook-utils.ts`. DO NOT duplicate cache-key logic.
- CLI subprocess tests: use absolute `indexPath`, temp `cwd`, `HOME: tempDir`. No `isolation: "worktree"` (corrupts `.git/config`). Secret fixtures: array join to avoid push protection.
- **DO**: After every commit, `git log origin/main..HEAD --oneline` before stop; `/push` if unpushed. **DON'T** use `git status` alone for unpushed detection.
- **DO**: In subprocess tests reaching `hasAiProvider() || detectAgentCli()`, pass `AI_TEST_NO_BACKEND: "1"` — prevents real backend calls. Exempt: tests using `GEMINI_API_KEY: "test-key"` + `GEMINI_TEST_RESPONSE`.
- **DON'T**: Treat first-run `pretooluse-repeated-lint-test` blocks as violations. Workaround: make any Edit between runs.
- **DON'T**: Declare commit or push success before reading tool output confirming it.
- **DO**: Create workflow tasks for multi-commit sessions. Mark complete as steps finish.
- **DO**: Route LaunchAgent `prPoll` via daemon first, fallback to `bun index.ts dispatch`.
- **DO**: Use `mergeActionPlanIntoTasks(planSteps, sessionId, cwd)` in hooks — auto-creates tasks before blocking. Call before `blockStop`/`denyPreToolUse` (they call `process.exit(0)`).
## Agent Behavior
- **DON'T**: Ask permission — invocation is authorization. No "Shall I?", no capability announcements.
- **DON'T**: Dismiss findings as "pre-existing" — own everything, act immediately.
- **DON'T**: Delete tasks after course correction — update subject/description. Use `TaskUpdate status="deleted"` for unwanted tasks.
- **DON'T**: Use "small", "minor", "trivial", "quick", "just", "likely" before actions. Investigate before characterizing.
- **DON'T**: Use compliance-gaming phrases ("satisfies the gate", "unblocks the hook"). Create tasks for real work, not mechanical bypass.
- **DO**: Use Claude Agent SDK in-process.
## Output Filtering
- **DON'T**: Filter output with `tail` less than 10 lines — minimum `tail -10`. Use Read tool with offset/limit instead.
- **DO**: Run `bun run typecheck`/`bun run lint` without output filters first — pipe to `tail` only on subsequent diagnostic passes.
## Shell & Tools
- **DON'T**: Use `npx` — use `bunx`. Use `sort -u` not `awk '!seen[$0]++'` (macOS).
- **DON'T**: Pass shell-sensitive content in `--body` — write to file, use `--body-file`.
## Issue Management
- **DO**: Close issues via `Fixes #N` in commit messages — not CLI. Read all comments before implementation.
- **DON'T**: File to wrong repo. Label dep bumps as 'maintenance'/'chore', not 'enhancement'.
- **DON'T**: `gh issue comment` on own issues before editing body — merge updates into body.
- **DON'T**: Ask user for issue selection — pick highest priority autonomously.
## Testing
- **DON'T**: Use shared mutable `let` in concurrent tests — use local `const` per `it()` block.
- **DON'T**: Mutate `process.env.HOME`/`globalThis.fetch` in concurrent tests — use constructor injection.
- **DON'T**: Run `bun test` with `run_in_background`. Don't spawn `bun run index.ts` from tests — call `command.run(args)` in-process.
- **DON'T**: Re-run full suite with different filters after failure — run specific file in isolation first.
## Self-Referential Hook Editing
- **DON'T**: Split edits to a live PreToolUse hook across multiple Edit calls — broken intermediates crash the hook and block all tools.
- **DO**: Prefer minimal value-only changes. When replacing import+usage: (1) add new import, (2) swap call site, (3) remove old import.
- **DO**: The moment a PreToolUse hook edit crashes, tell the user to run `git checkout -- <file>`. Don't attempt other tools.
- **DO**: Before changing a shared function's return type, grep all callers first.
## Dispatch & Daemon Context
- **DON'T**: Call `detectTerminal()` in daemon — read `_terminal` from payload. DON'T `JSON.parse(enrichedPayloadStr)` per hook — use `buildSpawnContext()` once.
- **DON'T**: `merge({}, payload, ...)` — mutate directly. Deep clones duplicate `_env` (~50KB). DON'T read-modify-write JSONL in hot paths — `appendFile` only.
- **DO**: Cap AI prompt context size in hooks. Trace actual code path (daemon vs CLI) when diagnosing dispatch failures.
