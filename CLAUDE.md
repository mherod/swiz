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
- **DO**: Use `@anthropic-ai/claude-agent-sdk` `query()` for Claude session interactions. **DON'T** spawn `claude` CLI via `Bun.spawn` — use SDK `continue`/`resume` options instead.
- **Complexity reduction**: Extract helpers to reduce cyclomatic complexity and max-lines violations.
- **Consolidate related utilities**: Multiple related functions → single canonical module (e.g., `agent-paths.ts`). Re-export from original locations.
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
- `classifyHookOutput` in `src/dispatch/engine.ts` extracts JSON from polluted stdout. DO NOT revert — defense-in-depth.
- In `lefthook.yml`, use `SWIZ_DIRECT=1 bun run index.ts dispatch <event>`; omitting triggers the global-link check.
- Hooks scanning staged diffs for code patterns (`.only`, `fdescribe`, etc.) must exclude `hooks/` and test files via `FOCUSED_TEST_EXCLUDE_RE` — regex definitions in hook source trigger false positives on themselves.
## Writing Hooks
- Update `README.md` whenever `src/manifest.ts` changes.
- `src/readme-hook-counts.test.ts` invariants:
  1. `### <EventName> (N)` heading count matches section table rows.
  2. README intro `**N hooks**` (line 7) matches manifest total.
  3. Every README hook filename exists on disk.
- Per new hook: increment section count, add table row, increment `**N hooks**`, run `bun test src/readme-hook-counts.test.ts`.
- Hooks are TypeScript, use `hooks/hook-utils.ts`, read JSON stdin, and exit `0`.
- Output helpers (all return `never`, call `process.exit(0)`, don't write stdout after):
  - PreToolUse: `denyPreToolUse(reason)` — block with ACTION REQUIRED footer; `allowPreToolUse(reason)` — allow with optional hint; `allowPreToolUseWithUpdatedInput(updatedInput, reason?)` — allow with modified input.
  - PostToolUse: `denyPostToolUse(reason)` — feed error back to Claude.
  - Context injection: `emitContext(eventName, context, cwd?)` — use for SessionStart, UserPromptSubmit, and PostToolUse `additionalContext`; handles `systemMessage` wrapper and state-line injection automatically.
  - Stop: `blockStop(reason, opts?)` — block with ACTION REQUIRED footer; `blockStopRaw(reason)` — block without footer.
- **DO NOT** write raw `console.log(JSON.stringify(...))` for hook output — use output helpers: `allowPreToolUse`, `denyPreToolUse`, `emitContext`, `blockStop`/`blockStopRaw`.
- **Subprocess timeout**: Use `spawnWithTimeout(cmd, { cwd, timeoutMs })` from `hook-utils.ts`. DON'T use raw `Bun.spawn()` with manual timers.
- **Dispatch abort**: `DispatchRequest.signal` and `HookStrategyContext.signal` carry abort signals. Strategies with local `AbortController` must listen on `ctx.signal`.
- **Dispatch payload enrichment**: `performDispatch` injects `_effectiveSettings` and `_terminal` into payload. **DO**: Read from payload. **DON'T**: Call `detectTerminal()` in daemon code.
- **File-path guard**: `filePathGuardHook(predicate, denyReason, allowMsg?)` in `hook-utils.ts` for file-path PreToolUse hooks.
- **Git Utilities Policy** — canonical locations:
  - `src/utils/hook-utils.ts` — regexes (`GIT_PUSH_RE`, `GIT_MERGE_RE`), extractors, runtime helpers (`git`, `gh`, `ghJson`).
  - `src/git-helpers.ts` — classifiers (`isDocsOrConfig`, `parseCommitType`), status types, queries. `git()` strips `GIT_*` env vars.
  - DO NOT define Git utilities locally — import from canonical source.
- **GitHub API Throttle** (`src/gh-rate-limit.ts`): `await acquireGhSlot()` before every `gh` CLI call. `gh()` calls it; direct `Bun.spawn(["gh"...` must too. 4500 req/hr limit. Exempt: `gh auth status`, `gh run watch`.
- Skill helpers: `skillExists` (checks `.skills/` and `~/.claude/skills/` for `SKILL.md`), `skillAdvice`.
- Cross-agent tool checks: `isShellTool`, `isEditTool`, `isFileEditTool`, `isCodeChangeTool`, `isTaskTool`, `isTaskCreateTool`.
- Task-tracking exemptions: `isTaskTrackingExemptShellCommand()` exempts read-only git, `gh`, `swiz`, setup, recovery (`RECOVERY_CMD_RE`: `ps`, `lsof`, `trash`, `wc`). **DON'T** add broad patterns (e.g., `cat`) to `RECOVERY_CMD_RE`.
- Package manager helpers: `detectPackageManager()`, `detectPkgRunner()`.
- Typed inputs: `StopHookInput`, `ToolHookInput`, `SessionHookInput` — use typed schema parse (`stopHookInputSchema`, `toolHookInputSchema`, `fileEditHookInputSchema`, `shellHookInputSchema`, `sessionHookInputSchema`) or direct type annotation; **DO NOT** use `as { ... }` casts for stdin.
- Hook schemas (`hooks/schemas.ts`, all `z.looseObject`): `fileEditHookInputSchema`, `shellHookInputSchema`, `toolHookInputSchema`, `stopHookInputSchema`, `sessionHookInputSchema`, `hookOutputSchema`, `taskUpdateInputSchema`. Settings schemas (`src/settings.ts`): `swizSettingsSchema`, `projectSettingsSchema`, `sessionSwizSettingsSchema`, `projectStateSchema`. State schemas (`src/state-machine.ts`): `workflowIntentSchema`, `statePrioritySchema`, `stateMetadataSchema`.
- **Hook cooldowns**: `cooldownSeconds` on a manifest entry skips re-runs within the window (per hook+cwd).
- **Auto-steer scheduling**: `scheduleAutoSteer(sessionId, message, trigger?, cwd?)` in `hook-utils.ts`. **DO**: Pass `cwd` for project-scoped dedup; `await` and branch: `if (await scheduleAutoSteer(id, reason, undefined, cwd)) { allowPreToolUse(reason) } else { denyPreToolUse(reason) }`. **DON'T**: Fire-and-forget with `void`; omit `cwd` (falls back to session-only scope). Consumption: use `store.consumeOne()` (thread-safe); `store.consume()` is deprecated. Consumed by `posttooluse-auto-steer.ts`. Gated by `requiredSettings: ["autoSteer"]`. SQLite queue `~/.swiz/auto-steer.db` (`src/auto-steer-store.ts`): two-layer dedup, optional TTL, `project_key` column. Triggers: `next_turn`, `after_commit`, `after_all_tasks_complete`, `on_session_stop`. Stop auto-steer in `BlockingStrategy` (`src/dispatch/strategies.ts`). `sendAutoSteer` types text via AppleScript.
- **DO**: All three memory-threshold checkpoints must share the same value via `resolveThresholds(cwd)` (project > global > default 5000). Never hardcode.
- **DO**: Use `computeProjectedContent()` from `hook-utils.ts` for content validation — suppresses `$&`/`$'`/`` $` `` interpolation. DON'T call `currentContent.replace(old, new)` directly. Fail-open on read/parse errors.
- NFKC-normalize `new_string`/`content`/`old_string` before pattern matching in content-inspecting hooks: `.normalize("NFKC")`. Enforced by `src/nfkc-enforcement.test.ts`. Exempt hooks must be listed in `EXEMPT_HOOKS`.
- Use `TEST_FILE_RE` (`.test.ts`, `.spec.ts`, `__tests__/`, `/test/`) for test-file exclusions.
- DO NOT test external repo code here; file issue in owning repo.
- Track current diff file from `+++ b/<path>` headers; apply file-level exclusions via that path.
- Use `sanitizeSessionId()` for `/tmp` names.
- DO: Use `src/temp-paths.ts` for `/tmp` paths; no `/tmp/*` literals.
- DO NOT hardcode `/tmp` sentinel session IDs in tests; use unique IDs or `mtime` checks.
- For `pgrep` checks, use ancestry (`process.ppid`) and repo scope (`lsof -p <pid> -d cwd -Fn`).
- Reference implementation: `hooks/stop-git-status.ts`.
- For `~/.claude/projects/` lookups, import `projectKeyFromCwd` from `src/transcript-utils.ts` — DO NOT reimplement.
- In `hook-utils.ts`, use lazy `await import(...)` for `projectKeyFromCwd` (circular import avoidance).
- Workflow enforcement: scan `transcript_path` for evidence — no extra state files.
- `pretooluse-update-memory-enforcement.ts` requires reading `update-memory/SKILL.md` and writing `.md` before unblocking.
- Cross-repo issue guidance: `buildIssueGuidance()` in `hook-utils.ts`. Generic: `buildIssueGuidance(null)`; cross-repo: `buildIssueGuidance(repo, {crossRepo:true, hostname})`.
- **DO**: When extracting functions/types from a shared module, re-export all types that downstream consumers import. Verify with `pnpm typecheck` before committing.
## Task Data
- Task storage per agent: `createDefaultTaskStore()` in `src/task-roots.ts` detects the current agent via `detectCurrentAgent()` and resolves agent-specific paths from `getTaskRoots()` in `src/provider-adapters.ts`. Falls back to Claude paths.
- Session-to-project mapping from `<projectsDir>/` transcript `cwd`.
- Cross-session checks: `stop-completion-auditor.ts` scans `~/.claude/tasks/` via `readSessionTasks()`.
- Completion: use `TaskUpdate` with `status: completed` and record evidence in the task `description` (or other allowed fields).

- First action: `TaskCreate`/`TaskUpdate`; required after compaction.
- `pretooluse-require-tasks.ts` blocks Edit/Write/Bash unless ≥2 incomplete tasks AND ≥1 `pending`.
- Prior-session task blocks: recreate as `in_progress` before retrying.
- After compaction: `TaskList`, close stale tasks after `git log --oneline -3`.
- One verb per task subject; `pretooluse-task-subject-validation.ts` rejects compound subjects. DON'T list multiple files or steps in one subject — one task per file/step.
- Keep ≥1 `pending`/`in_progress` task before `git add`/`git commit`; mark commit task complete after success.
- Run `/commit` before `git commit`; `pretooluse-commit-skill-gate` enforces it.
- `/commit` checks: task preflight, Conventional Commits `<type>(<scope>): <summary>`.
- Call task tools regularly: every 10 calls; staleness gate at 20.
- **DO**: Use native task tools for all task work (create, query, status, completion). **DON'T**: Use the `swiz tasks` CLI in the agent. Exception: `swiz tasks adopt` only (orphan recovery after compaction).
- **DO**: Use `createTaskInProcess()` from `src/tasks/task-service.ts` for in-process task creation. Use `createSessionTask()` from `src/utils/hook-utils.ts` when sentinel dedup is needed. **DON'T**: Shell out to `swiz tasks create` from hooks.
- Call `TaskUpdate` after each file; add updates at least every 3 edits.
- Create tasks before non-exempt Bash.
- **DON'T**: Complete last in-progress task while shell commands remain. Keep ≥1 `in_progress` until all shell work finishes.
- Exempt Bash: `ls`, `rg`, `grep`; read-only `git` (`log`, `status`, `diff`, `show`, `branch`, `remote`, `rev-parse`); `git push/pull/fetch`; all `gh`; `swiz issue close/comment`.
- `find` is not exempt; use `rg` or Glob.
- DO NOT create task solely for `git push`, `gh`, or `swiz issue close/comment` (`SWIZ_ISSUE_RE`, `GH_CMD_RE`).
- Stop requires no uncommitted changes (`stop-git-status.sh`).
- **Task completion**: `TaskUpdate` with `taskId` and `status: completed`; put structured evidence in `description` using prefixes like `commit:`, `pr:`, `file:`, `test:`, `note:`.
- **Subject changes**: use `TaskUpdate` `subject` / `description` — not the CLI.
- **DON'T**: Assume CI success from partial output. Always run `gh run view <run-id> --json conclusion,status,jobs` and confirm every job reached `conclusion: "success"`.
- Mark tasks complete immediately.
- Treat `gh issue create` and task completion as atomic; recover with `TaskUpdate` to the relevant `taskId` (include session context in the evidence text if needed).
- Run `git diff <files>` before `git add`.
- Run `git status` immediately after each `git commit`.
- After each `CLAUDE.md` edit, run `wc -w CLAUDE.md`; run `/compact-memory` when approaching threshold.
- Before adding a rule to `CLAUDE.md`, scan nearby rules for conflicts.
- Before issue labeling, run `gh label list`; use requested literal labels when present, otherwise ask before substituting.
- When user provides explicit labels, remove conflicting labels; don't restore them.
- After `gh issue create`, run `/refine-issue <number>` and apply readiness label (`ready`, `triaged`, `confirmed`, `accepted`, `spec-approved`). **DON'T** skip `/refine-issue` — adding `ready` directly bypasses proposals.
- **DON'T**: Use `$(cat <<'EOF')` in `gh issue create --body` — redirect guard blocks it. Write body to `/tmp/swiz-issue-N.md`, use `--body-file`.
- Before stop, audit open issue labels; if stop hook lists actionable issues, pick at least one via `/work-on-issue <number>` (prioritize `ready` over `backlog`).
## Standard Work Sequence
- Required order for each unit of work:
  1. `TaskCreate`/`TaskUpdate` -> `in_progress`.
  2. Edit/Bash implementation.
  3. `git add` + `git commit`.
  4. `TaskUpdate` -> `completed`.
  5. `SHA=$(git rev-parse HEAD)`.
  6. `git log origin/main..HEAD --oneline`.
  7. `swiz push-wait origin main`.
  8. `swiz ci-wait $SHA --timeout 300`.
  9. Confirm CI success; if failed, fix and re-push.
  10. Announce result.
- Keep `Push and verify CI` task `in_progress` until `gh run view --json` confirms success.
- Capture SHA before push; CI checks must reference it.
- Use `swiz push-wait`; no fixed sleeps, no `--force-with-lease`.
- Use `swiz ci-wait`; no manual watch/view loops.
- Don't call `TaskUpdate`/`TaskList` during steps 7-10.
- Don't stop after step 3; stop hook requires origin up to date.
- Push is inseparable from commit.
- Await background pushes (`TaskOutput block:true`) before CI. **DON'T** pass `TaskOutput` timeout > 120000ms; 300000 always fails.
- Use `swiz issue resolve <number> --body "<text>"` (not `gh issue comment` + `gh issue close`); close-only: `swiz issue close <number>`.
- **DON'T** close as `duplicate`/`wontfix` without file+line evidence per acceptance criterion.
- **DO** check issue state before resolving: `gh api repos/:owner/:repo/issues/{number} --jq '.state'`; `Fixes #N` auto-closes on push.
## Push and CI
- Repo is solo (`mherod/swiz`); push to `main`.
- **DO**: Run `swiz settings` before `/commit`, `/push`, or `/rebase-and-merge-into-main`.
- **DO**: Treat `.swiz/config.json` as authoritative for collaboration/trunk/branch policy; stay on `main` in solo+trunk mode.
- Run `/push` before `git push`; PreToolUse push gate requires it.
- CI workflow `paths-ignore`: `.claude/**`, `docs/**` — only those paths skip CI; markdown triggers CI.
- Pre-push checklist:
  0. **Run Step 0 collaboration guard** (`/push`) before every push to `main`/`master`; read output and never assume repo type.
  1. `git log origin/main..HEAD --oneline`.
  2. `git branch --show-current`; `gh pr list --state open --head $(git branch --show-current)`.
  3. `SHA=$(git rev-parse HEAD)`.
  4. `git push origin main` (lefthook pre-push runs full `bun test`).
  5. `gh run list --commit $SHA --json databaseId --jq '.[0].databaseId'`.
  6. `gh run watch <run-id> --exit-status`.
  7. `gh run view <run-id> --json conclusion,status,jobs --jq '{conclusion,status,jobs:[.jobs[]|{name,conclusion,status}]}'`.
- DO NOT use `gh run view --commit <SHA>`; list-by-commit then view-by-id.
- During cooldown use `swiz push-wait origin <branch>` instead of raw `git push`.
- No `--no-verify`; pre-push runs `bun test`; CI jobs `lint -> typecheck -> test` must pass.
- Pre-push `bun test` may fail with `proc.stdin.write` TypeError under concurrent load (`Bun.spawn` resource exhaustion). Run failing test in isolation; if it passes, retry.
- Verify CI with `gh run view --json`; `gh run watch` alone is insufficient.
- DO NOT block session waiting for CI. Check once with `gh run view`; `in_progress` is acceptable — pre-push ran full test suite.
- `github.base_ref` is empty on `push` events; use only on `pull_request`/`pull_request_target`.

- Push-command parsing: token-parse to distinguish `git push --force` vs `git push -- --force`, including `-C <path>` global options.
- DO NOT call `TaskUpdate` or `TaskList` after push starts.
- DO NOT stop with unpushed commits.
- DO NOT push to `main`/`master` without the Step 0 collaboration guard.
- DO NOT skip `git log origin/main..HEAD --oneline` pre-push review.
- DO NOT run branch/collaboration/open-PR checks after push.
- DO NOT add `Co-Authored-By` or AI attribution in commits/PR descriptions.
- DO NOT use destructive git: `revert`, `restore`, `stash` (mutations), `reset --hard`, `checkout -- <file>`; use `reflog` for recovery. Exception: `stash list`/`stash show` (read-only).
- DO: Read full file before reverting edits — Biome auto-formatting changes other sections.
## Daemon
- `src/commands/daemon.ts`: long-lived `Bun.serve` on port 7943; serves multiple projects simultaneously — scope per-project state by `cwd`.
- Endpoints: `/health`, `/dispatch` (POST), `/status-line/snapshot` (POST), `/metrics` (GET), `/ci-watch` (POST), `/ci-watches` (GET).
- `swiz daemon status` fetches `/metrics`. Metrics are in-memory only; tracked globally and per-project.
- LaunchAgent: `~/Library/LaunchAgents/com.swiz.daemon.plist`; `swiz daemon --install` / `--uninstall`.
- **DO**: In daemon-served `src/web/**` modules, use browser-resolvable imports only (`./`, `../`, `/web/...`). **DON'T** use bare package imports unless daemon adds import-map/bundling support.
- **DO**: After web-import changes, restart daemon (`lsof -ti tcp:7943 | xargs -r kill && bun run index.ts daemon --port 7943`) and diagnose from newest console entries for the current URL.
- **DO**: Use `IssueStore` (`src/issue-store.ts`) for issues/PRs/CI. Daemon `syncUpstreamState` keeps it fresh. **DON'T** use per-project file caches — `~/.swiz/issues.db` replaces them.
- **DO**: Add consumer-needed fields (e.g., `mergeable`, `url`) to `syncUpstreamState` in `src/issue-store.ts`.
- **DO**: Prefer `gh api repos/{owner}/{repo}/...` (REST) over `gh issue view`/`gh pr list` (GraphQL) — REST has higher rate limits. Close issues via `gh api repos/:owner/:repo/issues/{number} -X PATCH -f state=closed`.
## Settings Configuration
- Separate state files for runtime data (`.swiz/context-stats.json`); never mix into config (`.swiz/config.json`).
- 3-tier resolution: `project > user > default`. Track source per value, not per group. Label with `(project)`, `(user)`, `(default)`.
- Show all effective values; never hide user/default. No shared `source` for multiple settings.
- Adding a boolean setting (global scope) requires updates to 7 files:
  1. `src/settings/types.ts` — `SwizSettings` interface.
  2. `src/settings/registry.ts` — `SETTINGS_REGISTRY` entry.
  3. `src/settings/persistence.ts` — `DEFAULT_SETTINGS` and `swizSettingsSchema`.
  4. `src/settings/resolution.ts` — `getEffectiveSwizSettings` base object.
  5. `src/commands/settings.ts` — `printGlobalSettings`.
  6. `src/web/components/settings-panel.tsx` — `GlobalSettingsForm`, `DEFAULT_GLOBAL_FORM`, `globalSettingsToForm`, `GLOBAL_TOGGLES`.
  7. `src/commands/settings.test.ts` — `SwizSettings` literals and `expectedKeys`.
## CLI Error Handling
- In `src/commands/`, throw errors instead of `process.exit(1)`.
- `src/cli.ts` handles command errors via `process.exitCode = 1`.
- `src/commands/continue.ts`: stream Agent SDK messages; `process.exitCode = 1` on non-success.
- Hook scripts (`hooks/*.ts`) are the exception: `process.exit(0)` is intentional.
- In CI/hook scripts, do not use `console.log` for status/debug; use `console.error`.
- `src/debug-logging.test.ts` enforces allowlists for `console.error`/`console.warn` (STDERR_ALLOWLIST) and `console.log`/`console.info` (STDOUT_ALLOWLIST). Files not on an allowlist must use `import { debugLog } from "./debug.ts"` for diagnostics. Adding to an allowlist requires a justification comment in the test.
- Reference implementations: `src/issue-store.ts`, `src/manifest.ts`, `src/commands/tasks.ts`.
## Conventions
- DO NOT use top-level `await` in `src/` files — ESLint `no-restricted-syntax` rule blocks it. Use lazy async initialization with cached results instead: `let cache: T | null = null; async function load(): Promise<T> { if (cache !== null) return cache; cache = await fetch(); return cache; }`. Hooks in `hooks/` are exempt since they run as main modules.
- DO NOT embed ESC (0x1b) in regex literals — Biome's `no-control-regex` blocks it. Construct at runtime: `new RegExp(String.fromCharCode(27) + "\\[[0-9;]*[a-zA-Z]", "g")`. Reference: `hooks/posttooluse-task-output.ts` `ANSI_RE`.
- When parsing bun test output for counts, check for `/\bRan \d+ tests? across \d+ files?\./` before reporting an exact figure; absent the marker, output is truncated — emit "unknown number of". Strip ANSI before matching. Reference: `detectFailure` in `hooks/posttooluse-task-output.ts`.
- **DO**: Rename variable/constant declaration and all usages in one edit — splits in PreToolUse hooks cause unrecoverable deadlocks. **DON'T** add unrequested renames to hook changes; change only what was asked for.
- DO: Read every file in full before editing — snippets miss conflicts and patterns in other sections.
- Use ANSI escape codes directly; do not add color libraries.
- Prefer `Bun.spawn(["sh", "-c", cmd])` for shell execution in skills/hooks.
- With piped `Bun.spawn`, drain stdout/stderr concurrently via `Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])` before `await proc.exited`.
- Hooks are `.ts` and run as `bun hooks/<file>.ts`.
- Settings writes must create `.bak` backups first.
- Stop hooks inject session tasks from `~/.claude/tasks/<session_id>/`; format `IN PROGRESS` before `COMPLETED`.
- Stop-memory prompts must include `Cause to capture: <cause>`.
- On `MEMORY CAPTURE ENFORCEMENT`, read `/update-memory/SKILL.md`, edit `CLAUDE.md`, and resolve it immediately.
- When unblocking a gated session: complete prior task with evidence, create `in_progress` task before tool calls.
- `pretooluse-require-tasks.ts` and `pretooluse-update-memory-enforcement.ts` must skip outside git repos or when `CLAUDE.md` is missing; guard with `isGitRepo(cwd)` + upward search, else `process.exit(0)`.
- **DO**: Own every diagnostic in workflow output — never label warnings as "pre-existing" or attribute failures to other sessions. Investigate all test failures before completing tasks, even when changes seem unrelated.
- Test Biome rule changes with `biome check .` (not only `biome check src/`); add overrides for directories with valid console usage.
- Bun test reporter: `--reporter=dots --concurrent`. Run once without pipe — piped re-runs trigger repeated-test hook.
- **DO**: Edit a file between `bun run format` and `bun run lint` — hook detects no file changes on consecutive runs.
- No `cd` in Bash; use absolute paths, `git -C`, `pnpm --prefix`, or `cwd` in `Bun.spawn()`.
- `sed -i`/`sed > file` blocked; `sed -n` pipelines allowed. Use Read `offset`/`limit`.
- `awk > file`/`awk | tee -i` blocked; `awk '{print}'` allowed. Prefer `bun -e`, `cut`, or git `--format`.
- Do not use `python`/`python3`; use `bun -e` or `jq`.
- Do not use `rm`/`rm -rf`; use `trash <path>`; guard with `[[ -e <path> ]] && trash <path>`.
- DO NOT edit `~/.claude/hooks/` or `~/.claude/skills/`; they are external repos. For cross-repo bugs, file an issue with error, root cause, fix, and criteria.
- **DO NOT mark tasks complete without shipped code.** Always: modify source, verify `git diff`, commit, then mark complete.
- Stop-hook footers with `REMINDER_FRAGMENT` re-trigger memory enforcement. `pretooluse-update-memory-enforcement.ts` uses a 30-min `CLAUDE.md` mtime cooldown; run `swiz install` after hook changes.
- Cooldown doesn't carry between sessions; complete memory follow-through before session end.
- Cache-key generation: use `getCanonicalPathHash()` in `hook-utils.ts`. DO NOT duplicate cache-key logic.
- In CLI subprocess tests, do not set `cwd: process.cwd()`; use absolute `indexPath = join(process.cwd(), "index.ts")`, temp `cwd`, and `env: { ...process.env, HOME: tempDir }`.
- Do not use Agent tool `isolation: "worktree"` — corrupts `.git/config`.
- For secret-like test fixtures, build via array join (`['s','k','_','l','i','v','e','_',...].join('')`) — push protection blocks literal secrets.
- **DO**: After every commit, run `git log origin/main..HEAD --oneline` before stop; use `/push` for unpushed commits.
- **DON'T**: Rely on `git status` alone for unpush detection; use `git log origin/main..HEAD --oneline`.
- **DO**: In subprocess tests reaching `hasAiProvider() || detectAgentCli()`, pass `AI_TEST_NO_BACKEND: "1"` — prevents real backend calls with Codex/Gemini. Exempt: tests using `GEMINI_API_KEY: "test-key"` + `GEMINI_TEST_RESPONSE`.
- **DON'T**: Treat first-run `pretooluse-repeated-lint-test` blocks as violations. Workaround: make any Edit between runs.
- **DON'T**: Declare commit or push success before reading tool output confirming it.
- **DON'T**: Work on auto-continue findings without a filed issue.
- **DO**: Route LaunchAgent `prPoll` via daemon first, then fallback to `bun index.ts dispatch`.
- **DO**: Use `mergeActionPlanIntoTasks(planSteps, sessionId, cwd)` in hooks that build action plans — auto-creates tasks from plan steps before blocking. Call before `blockStop`/`denyPreToolUse` since those call `process.exit(0)`.
