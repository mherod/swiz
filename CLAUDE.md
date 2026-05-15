# CLAUDE.md
CLI conventions.
---
description: CLI architecture, patterns, conventions.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---
## Runtime
- Use Bun only. DO NOT use Node.js, npm, pnpm, vite, dotenv, or Node-specific tooling.
- Use `bun <file>`, `bun test`, `bun install`, `bun run index.ts`, `bun --hot index.ts`, `bun link`.
- Prefer `swiz <command>` for CLI usage.
- Use `bun run index.ts <command>` to force checkout execution.
- Use `Bun.file()` and `Bun.write()` for file I/O.
- Use `node:fs/promises` only for directory operations (`readdir`, `mkdir`, `stat`).
## CLI Architecture
- Entry point: `index.ts`; command registration: `registerCommand()` in `src/cli.ts`.
- `src/types.ts` `Command` interface fields: `name`, `description`, optional `usage`, `run(args)`.
- Add command: create `src/commands/<name>.ts` exporting `Command`, then register in `index.ts`.
- DO NOT add routing or arg-parsing libraries; keep manual `process.argv` parsing.
- **DO**: Use `@anthropic-ai/claude-agent-sdk` `query()` for Claude; **DON'T** spawn `claude` CLI.
- Extract helpers for complexity/max-lines. Consolidate duplicate utilities into a canonical module (e.g., `agent-paths.ts`) and re-export.
## Agent Detection
- `src/agents.ts` owns agent metadata: `envVars`, `processPattern`, `binary`, `settingsPath`, `toolAliases`, `eventMap`, `tasksEnabled`, `hooksConfigurable`, `additionalDispatchEntries`. Add signals there first.
- Runtime detection: `src/agent-paths.ts` (`src/detect.ts` re-export). `detectCurrentAgentFromEnv(env)` checks truthy `envVars` in `AGENTS` order; `detectCurrentAgent()` falls back to parent `processPattern`; `isRunningInAgent()` is shell/shim-only (non-TTY stdin, `CURSOR_TRACE_ID`, `CLAUDECODE`).
- Translation is metadata-driven: `translateMatcher()`, `translateEvent()`, `toolNameForCurrentAgent()`, `resolveTranslationAgent()`. Never hard-code agent tool/event names. Precedence: explicit → env+aliases → unique observed tools → `detectCurrentAgent()`.
- Daemon dispatch preserves origin env: `swiz dispatch` stores agent vars in `_env`; `applyDispatchEnv()` wraps in-process hooks. Daemon hooks use `_env` + `detectCurrentAgentFromEnv()`, not launchd env.
- Keep installed/current/backend detection separate: `detectInstalledAgents()` checks `PATH`/settings; `detectAgentCli()`/`detectBestAgentCli()` find Cursor's `agent` binary for fallback prompting. Do not use either for hook-agent detection.
- Task governance pivots on `AgentDef.tasksEnabled`. `agentHasTaskTools()` defaults `true`; `buildManifest()` strips `TASK_HOOK_IDENTIFIERS` when false. `pretooluse-task-governance.ts` skips Edit/Write/Bash requirements without task tools. Codex has `tasksEnabled=false`; `update_plan` is not Claude-style task enforcement/advisory.
- Cross-agent task names live in `src/tool-matchers.ts` + `toolAliases`. `shouldInspectShellInput()` prefers `_env`, then process env, then Claude; `swiz tasks` CLI denial only applies to resolved Claude. Stop validators skip task creation/audit checks when task tools are unavailable; `stop-incomplete-tasks` exempts `isCurrentAgent("gemini")`.
- Task storage follows detection: `createDefaultTaskStore()` uses `detectCurrentAgent()` provider roots, falling back to Claude. Apply `_env` in daemon dispatch or tasks may use the wrong provider root.
## Project Root Resolution
- Resolve project root with `dirname(Bun.main)`.
- DO NOT use `join(dirname(Bun.main), "..")`; it breaks `bun link` execution.
## Hook System
- Hooks live in `hooks/`; canonical manifest is `manifest` in `src/manifest.ts`.
- Canonical events are camelCase: `stop`, `preToolUse`, `postToolUse`, `sessionStart`, `userPromptSubmit`, `preCommit`.
- Translation: `EVENT_MAP` (canonical→agent events), `TOOL_ALIASES` (per-agent tool names). Claude uses nested matchers; Cursor uses flat list.
- Agent hook flow: add `hooks/<name>.ts`; add `manifest` entry; for new events update `DISPATCH_ROUTES` in `src/dispatch/index.ts` and agent `eventMap` in `src/agents.ts`; run `swiz install --dry-run`; run `swiz install`.
- Scheduled hook flow (`preCommit`, `prePush`): add hook; add `manifest` entry with `scheduled: true`; add `DISPATCH_ROUTES`, `TOOL_NAME_OPTIONAL_EVENTS`, `DISPATCH_TIMEOUTS`; wire `lefthook.yml` with `SWIZ_DIRECT=1 bun run index.ts dispatch <event>`.
- Keep `DISPATCH_ROUTES`, `manifest`, and agent `eventMap` synchronized.
- `validateDispatchRoutes()` in `src/manifest.ts` must pass from `swiz dispatch` and `swiz install`.
- Keep `src/dispatch-routing.test.ts` passing.
- DO NOT duplicate preToolUse matcher strings across groups — `manifest.find()` returns the first match, shadowing the original. Add hooks to the existing group.
- DO NOT add sync hooks to unmatchered preToolUse groups — `manifest.test.ts` requires `matcher` for groups with sync hooks; async-only groups are exempt.
- DO NOT hard-code agent-specific event names or tool names in hook scripts.
- `classifyHookOutput` validates stdout against `hookOutputSchema`; `"invalid-schema"` on failure. Requires `systemMessage`/`reason`/`stopReason`/`additionalContext`; `{}` valid. Stop normalized via `stopHookOutputSchema`.
- In `lefthook.yml`, use `SWIZ_DIRECT=1 bun run index.ts dispatch <event>`; omitting triggers the global-link check.
- Hooks scanning staged diffs for code patterns (`.only`, `fdescribe`, etc.) must exclude `hooks/` and test files via `FOCUSED_TEST_EXCLUDE_RE` — regex definitions in hook source trigger false positives on themselves.
- **Inline SwizHook**: Use `preToolUseAllow()`/`preToolUseDeny()` + `runSwizHookAsMain()` from `SwizHook.ts`; `if (import.meta.main) await runSwizHookAsMain(hook)` (DON'T also `Bun.stdin.json()` — double-read = silent exit 0). Helper extraction + migration ship in one commit (`bun run typecheck` between). Safe imports: `tool-matchers`, `git-helpers`, `shell-patterns`, `skill-utils`, `node-modules-path`, `command-utils`, `utils/{edit-projection,inline-hook-helpers,package-detection}`, `hooks/schemas`. Avoid `hook-utils.ts`/`git-utils.ts` (circular).
- **Debt marker self-detection**: Hook files with keywords in `//` comments trigger `pretooluse-todo-tracker`. Use JSDoc `/** */` headers or dynamic regex (`"TO" + "DO"`).
- **Phase 2 extraction**: 6 modules (types→context→validators→action-plan→evaluate→wrapper). Export from core, import by orchestrator only; delete re-export wrappers. Reference: `PHASE_2_EXTRACTION_PATTERN.md`.
## Branch Change Detection
- Canonical (import; never redefine): `src/utils/git-utils.ts` exports `BRANCH_CHECK_RE`, `GIT_CHECKOUT_RE`, `GIT_SWITCH_RE`, `GH_PR_CHECKOUT_RE`, `GIT_CHECKOUT_NEW_BRANCH_RE`, `getDefaultBranch(cwd)` (project setting → upstream → remote → main/master). Equality via `src/git-helpers.ts::isDefaultBranch()` — never `=== "main"`.
- Reads `git branch --show-current`: `hooks/pretooluse-{pr-head-checkout-gate,issue-workflow-gate,pr-changes-branch-guard,pr-age-gate,stale-approval-gate,trunk-mode-branch-gate,branch-intent-gate,block-commit-to-main,main-branch-scope-gate,gitflow-integration-base-gate,sandboxed-edits}.ts`; `hooks/posttooluse-{pr-context,state-transition}.ts`; `src/commands/{push-ci,push-wait,status,daemon/pr-review-monitor}.ts`.
- `pretooluse-push-checks-gate.ts` gates `git push` on recent `BRANCH_CHECK_RE` transcript hit. `posttooluse-{pr-context,state-transition}.ts` fire on checkout/switch.
- Stop gates: `hooks/stop-{non-default-branch,branch-conflicts,quality-checks}.ts`. Daemon cache: `src/utils/daemon-git-state.ts` (POST `/git/state`). Status surfaces: `src/commands/{status-line,status}.ts`. Settings: project-only `defaultBranch` in `src/settings/{types,registry,persistence}.ts` — consume via `getDefaultBranch()`.
## Skill Requirement Gates
- Skill/tool "used this session" requirements mean used recently: within the last 20 transcript turns and last 10 minutes. Use shared helpers in `src/transcript-summary.ts`/`src/skill-utils.ts` (`getRecentlyInvokedSkillsForCurrentSession`, `getRecentlyUsedToolsForCurrentSession`, `getRecentBashCommandsUsedForCurrentSession`, `formatCurrentSessionUsageWindow`). DON'T rescan transcripts or duplicate recency math in individual hooks.
- `hooks/pretooluse-skill-invocation-gate.ts`: requires recent `/commit` before `git commit`, `/push` before `git push`, `/triage-issues` before adding `triaged`, `/refine-issue` before label changes, `/pr-open` before `gh pr create`, and `/pr-comments-address` before dismissing PR reviews. Branch deletion pushes are exempt.
- Commit gating also requires a recent `TaskList` before `git commit` after `/commit`, so task state is fresh.
- `hooks/pretooluse-push-checks-gate.ts`: before `git push`, branch (`git branch --show-current`), PR (`gh pr list --state open --head ...`), and required CI (`swiz ci-wait ...`) checks must be recent or the hook emits an advisory. Behind-remote, WIP/fixup/squash commits, secrets, and large files remain hard blocks.
- `hooks/stop-required-skills.ts`: stop requires recent applicable stop skills in priority order: `/end-of-day` when unpushed commits or incomplete tasks exist, `/farm-out-issues` in git repos, `/continue-with-tasks`, then `/reflect-on-session-mistakes`.
- `hooks/stop-incomplete-tasks.ts` and `hooks/stop-completion-auditor/task-reconciliation.ts` require recent `TaskList` when task state must be synced before stop. `hooks/posttooluse-mid-session-prompt.ts` only suppresses the prompt if `/mid-session-checkin` was recent.
- When changing current-session usage semantics, update transcript-backed parsing and daemon `_currentSessionToolUsage` providers together; daemon state must retain event timestamps/turn indexes when recency matters.
- Hook output is rephrased. Tests should assert stable decisions, categories, and required window text, not exact rephrased command strings unless the literal text is the behavior under test.
## Writing Hooks
- Update `README.md` whenever `src/manifest.ts` changes.
- `src/readme-hook-counts.test.ts` invariants:
  1. `### <EventName> (N)` heading count matches section rows.
  2. README intro `**N hooks**` (line 7) matches manifest total.
  3. Every README hook filename exists on disk.
- Per hook: increment section count, add table row, increment `**N hooks**`, run `bun test src/readme-hook-counts.test.ts`.
- Hooks are TypeScript. Use `hooks/hook-utils.ts`, read JSON stdin, exit 0.
- Output helpers: `allowPreToolUse`, `denyPreToolUse`, `emitContext`, `blockStop`/`blockStopRaw`, etc. — call `process.exit(0)`. **DON'T** write raw `console.log(JSON.stringify(...))`.
- **Hook tone**: Human voice; next action first. DON'T mention Swiz/hook mechanics, audit/sync/cache/drift, raw counts, thresholds, or echo the detector pattern/regex/forbidden phrase. Scold behavior, direct next action.
- **Stop aggregation** (`src/dispatch/blockingStrategy.ts`): named sections, one action-required footer, clear separators. Strip duplicate footers/`stop-ship-checklist` preambles. DON'T join with bare `\n\n\n\n`.
- **Stop ship checklist** (`hooks/stop-ship-checklist/action-plan.ts`): `combinedPlan.push(label, step.planSteps)` — separate args, not tuple.
- **Quality stop** (`hooks/stop-quality-checks.ts`): use `summarizeCheckOutput()`. Keep `file:line:col`, `Found N errors`, `Checked N files`; drop code frames.
- **Task-governance copy** (`src/tasks/task-governance-messages.ts`): no completion chains/projected math/state dumps. Direct to `TaskList`, update/create, evidence, retry.
- **Subprocess**: `spawnWithTimeout(cmd, { cwd, timeoutMs })` — not `Bun.spawn` + manual timers.
- **Dispatch**: `AbortController` strategies listen on `ctx.signal`. `performDispatch` injects `_effectiveSettings` + `_terminal`. Cursor cwd: `normalizeAgentHookPayload` uses `workspace_roots` when empty/outside. Captures in `/tmp/swiz-incoming/` (~10m); `SWIZ_CAPTURE_INCOMING=0` disables.
- **File-path guard**: Use `filePathGuardHook(predicate, denyReason, allowMsg?)` for file-path PreToolUse hooks.
- **Git utilities**: `src/utils/hook-utils.ts` (regexes, extractors, helpers), `src/git-helpers.ts` (classifiers, queries). DO NOT define locally; import canonical source.
- **GitHub API throttle**: `await acquireGhSlot()` before `gh` calls (4500 req/hr limit). Exempt: `gh auth status`, `gh run watch`.
- Skill helpers: `skillExists`, `skillAdvice`.
- Cross-agent tool checks: `isShellTool`, `isEditTool`, `isFileEditTool`, `isCodeChangeTool`, `isTaskTool`, `isTaskCreateTool`.
- Task exemptions: read-only git, `gh`, `swiz`, setup, recovery. DON'T add broad patterns to `RECOVERY_CMD_RE`.
- Package manager helpers: `detectPackageManager()`, `detectPkgRunner()`.
- Typed inputs: use schema parse from `hooks/schemas.ts`; **DON'T** use `as { ... }` casts for stdin. Settings/state schemas also in `src/settings/persistence.ts`.
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
- State machine: `pending` → `in_progress` → `completed` or `deleted`.
- Gates: stop (`hooks/stop-incomplete-tasks/evaluate.ts`) blocks incomplete tasks; transition (`pretooluse-task-transition-validator.ts`) blocks `pending`→`completed`; phantom (`pretooluse-no-phantom-task-completion.ts`) requires substantive tool calls (`Edit`, `Write`, `Bash`, `Read`, `Skill`, `Glob`, `Grep`) and evidence.
- Rate/dedupe: `pretooluse-task-completion-rate-limit.ts` max 2 completions/5s and requires `TaskList`; `deduplicateStaleTasks()` auto-completes pending tasks matching completed subjects.
- Exemptions: `AgentDef.tasksEnabled=false` (Codex) skips task enforcement. Exempt Bash: `ls`, `rg`, `grep`; read-only `git` (`log`, `status`, `diff`, `show`, `branch`, `remote`, `rev-parse`); `git push/pull/fetch`; all `gh`; `swiz issue close/comment`. `find` is not exempt.
- Workflow: `TaskCreate` → `in_progress` → work → evidence → `completed`; maintain ≥2 pending buffer. Use native task tools except `swiz tasks adopt`. Hooks use `createTaskInProcess()` or `createSessionTask()`.
- `pretooluse-require-tasks.ts` blocks Edit/Write/Bash unless ≥2 incomplete and ≥1 pending. Create tasks before non-exempt Bash. Keep last `in_progress` while shell work remains.
- Task subjects: one verb; `pretooluse-task-subject-validation.ts` rejects compound subjects. Change subject/description via `TaskUpdate`, not CLI.
- Completion evidence in `TaskUpdate description`: `commit:<sha>`, `pr:<url>`, `file:<path>`, `test:<result>`, `note:`. Example: `test:5_pass_0_fail -- integration verified`.
- Run `/commit` before `git commit`; `pretooluse-commit-skill-gate` enforces Conventional Commits. Stop requires clean git status.
- After compaction: `TaskList`, close stale tasks using `git log --oneline -3`. Call task tools every 10 calls; staleness gate at 20.
- On session resume, verify every `completed` commit/push task against `git status` — uncommitted/unpushed files mean phantom completion; reopen the task before new work.
- After `CLAUDE.md` edit: `wc -w CLAUDE.md`; run `/compact-memory` near threshold. Pre-issue labeling: `gh label list`; post `gh issue create`: `/refine-issue <number>`. Use body files, not heredoc.
- Verify CI jobs with `gh run view <run-id> --json conclusion,status,jobs`; never trust partial output. Check `.gitignore` before committing untracked `.lock` or local state.
## Standard Work Sequence
- Order: TaskCreate→in_progress → work → commit → TaskUpdate→completed → SHA → `git log origin/main..HEAD` → `swiz push-wait` → `swiz ci-wait $SHA --timeout 300` → confirm CI.
- Keep push task `in_progress` until `gh run view --json` confirms. No sleeps, no `--force-with-lease`, no `TaskUpdate`/`TaskList` during push/CI, no stop after unpushed commit. `TaskOutput` timeout ≤120000ms.
- Resolve issues with `swiz issue resolve <number> --body "<text>"`; `Fixes #N` auto-closes on push. No `duplicate`/`wontfix` close without evidence.
## Push and CI
- Repo is solo (`mherod/swiz`); push to `main`.
- **DO**: Run `swiz settings` before `/commit`, `/push`, or `/rebase-and-merge-into-main`.
- **DO**: Treat `.swiz/config.json` as authoritative for collaboration/trunk policy.
- CI `paths-ignore`: `.claude/**`, `docs/**` — only those paths skip; markdown triggers CI.
- Pre-push: `/push`; `git log origin/main..HEAD`; branch+PR check; capture SHA; `git push`; `gh run list --commit "$SHA" --limit 15`; `gh run watch`; `gh run view --json conclusion,status,jobs`.
- DO NOT use `gh run view --commit <SHA>`; list-by-commit then view-by-id.
- During cooldown use `swiz push-wait origin <branch>` instead of raw `git push`.
- No `--no-verify`; pre-push runs `bun test`; CI: `lint → typecheck → test`. If `bun test` fails with `proc.stdin.write` TypeError (`Bun.spawn` exhaustion), run failing test in isolation; if pass, retry.
- **DO**: After push: verify CI once with `gh run view --json` (not `gh run watch` alone); `in_progress` is acceptable — pre-push ran full test suite. Update tasks before stop.
- `github.base_ref` is empty on `push` events; use only on `pull_request`/`pull_request_target`. Push parsing must distinguish `git push --force` vs `git push -- --force`, including `-C <path>`.
- DON'T call `TaskUpdate`/`TaskList` after push starts; don't stop with unpushed commits; don't push `main`/`master` without collab guard; don't run branch/collab/PR checks after push.
- DON'T add `Co-Authored-By` trailers. DON'T use destructive git (`revert`, `restore`, `stash`, `reset --hard`, `checkout -- <file>`); use `reflog`. Exception: read-only `stash list`/`stash show`.
- DO: Read full file before reverting edits — Biome reformats other sections.
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
- Adding boolean setting (global): update `types.ts`, `registry.ts`, `persistence.ts`, `resolution.ts`, `settings.ts`, `settings-panel.tsx`, `settings.test.ts`.
## CLI Error Handling
- In `src/commands/`, throw errors instead of `process.exit(1)`.
- `src/cli.ts` handles command errors via `process.exitCode = 1`.
- `src/commands/continue.ts`: stream Agent SDK messages; `process.exitCode = 1` on non-success.
- Hook scripts (`hooks/*.ts`) are the exception: `process.exit(0)` is intentional.
- In CI/hook scripts, do not use `console.log` for status/debug; use `console.error`.
- `src/debug-logging.test.ts` allowlists `console.*`; elsewhere use `debugLog` from `./debug.ts`. Allowlist edits need a justification comment in the test.
- Reference implementations: `src/issue-store.ts`, `src/manifest.ts`, `src/commands/tasks.ts`.
## Conventions
- No top-level `await` in `src/`; use lazy async (`let cache; async load() {...}`). Hooks exempt.
- DON'T embed ESC (0x1b) in regex literals; construct at runtime — see `hooks/posttooluse-task-output.ts` `ANSI_RE`.
- Bun test output parse: `/\bRan \d+ tests? across \d+ files?\./`; absent → emit "unknown number of". Strip ANSI before matching.
- **CRITICAL self-ref PreToolUse**: edit import first, then usage (second edit). Reversed deadlocks session — recover with `git checkout -- <file>`. Atomic rename of declaration + all usages in one edit; DON'T add unrequested renames. Remove utility fn + all usages atomically.
- DO: Read every file in full before editing — snippets miss conflicts.
- ANSI escape codes direct; no color libraries.
- `Bun.spawn`: use `["sh", "-c", cmd]` for shell; drain stdout/stderr concurrently via `Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])` before `await proc.exited`.
- Hooks are `.ts`; run as `bun hooks/<file>.ts`.
- Settings writes: `.bak` backup first.
- Stop hooks inject session tasks from `~/.claude/tasks/<session_id>/`; `IN PROGRESS` before `COMPLETED`. Stop-memory prompts include `Cause: <cause>`.
- On `MEMORY CAPTURE ENFORCEMENT`: read `/update-memory/SKILL.md`, edit `CLAUDE.md`, resolve immediately.
- Unblocking a gated session: complete prior task with evidence, create `in_progress` task before tool calls.
- `pretooluse-require-tasks.ts` / `pretooluse-update-memory-enforcement.ts` skip outside git repos or when `CLAUDE.md` missing; guard with `isGitRepo(cwd)` + upward search, else `process.exit(0)`.
- DO: Own every diagnostic — investigate failures before completing tasks.
- Biome rule changes: `biome check .` (not `biome check src/`); add overrides for valid-console dirs.
- Bun test: `--reporter=dots`. `--concurrent` multi-file only; single-file rejected. Run once — piped re-runs trigger repeated-test hook.
- DO: Edit a file between `bun run format` and `bun run lint` — hook detects no-change consecutive runs.
- No `cd` in Bash; use absolute paths, `git -C`, `pnpm --prefix`, or `cwd` in `Bun.spawn()`.
- `sed -i`/`sed > file`, `awk > file` blocked; read-only pipelines OK. Use `bun -e` or `jq` (not `python`). Use `trash` (not `rm`).
- DO NOT edit `~/.claude/hooks/` or `~/.claude/skills/`; file cross-repo bugs as issues with error, root cause, fix, criteria.
- DO NOT mark tasks complete without shipped code: modify source → `git diff` → commit → complete.
- `REMINDER_FRAGMENT` re-triggers memory enforcement; 30-min `CLAUDE.md` mtime cooldown.
- Cache keys: `getCanonicalPathHash()` in `hook-utils.ts`; never duplicate.
- CLI subprocess tests: absolute `indexPath`, temp `cwd`, `HOME: tempDir`. No `isolation: "worktree"` (corrupts `.git/config`). Secret fixtures: array join to avoid push protection.
- DO: After every commit, `git log origin/main..HEAD --oneline` before stop; `/push` if unpushed. DON'T trust `git status` alone for unpushed detection.
- DO: In subprocess tests hitting `hasAiProvider() || detectAgentCli()`, pass `AI_TEST_NO_BACKEND: "1"`. Exempt: `GEMINI_API_KEY: "test-key"` + `GEMINI_TEST_RESPONSE`.
- DON'T: Treat first-run `pretooluse-repeated-lint-test` blocks as violations — make any Edit between runs.
- DON'T: Declare commit/push success before reading tool output confirming it.
- DO: Workflow tasks for multi-commit sessions; mark steps complete as they finish.
- DO: Use `mergeActionPlanIntoTasks(planSteps, sessionId, cwd)` in hooks — auto-creates tasks before blocking. Call before `blockStop`/`denyPreToolUse`.
## Agent Behavior
- DON'T ask permission (invocation is authorization), dismiss findings as "pre-existing", delete tasks after course correction (update subject; `TaskUpdate status="deleted"` for unwanted), use hedging ("small", "minor", "trivial", "quick", "just", "likely") before investigating, or use compliance-gaming phrases ("satisfies the gate", "unblocks the hook"). Use Claude Agent SDK in-process.
## Output & Shell
- Filter output with `tail` ≥10; Read with offset/limit instead. Run `bun run typecheck`/`bun run lint` unfiltered first; pipe to `tail` only on diagnostic passes.
- Use `bunx` (not `npx`); `sort -u` (not `awk '!seen[$0]++'` on macOS). Pass shell-sensitive content via `--body-file`, not `--body`.
## Issue Management
- Close via `Fixes #N` in commits (not CLI). Read all comments first. File to correct repo; label dep bumps `maintenance`/`chore`. Merge updates into the body — don't `gh issue comment` on your own issues. Pick highest priority autonomously.
## Testing
- DON'T: shared mutable `let` in concurrent tests (use local `const` per `it()`); mutate `process.env.HOME`/`globalThis.fetch` (inject); `bun test` with `run_in_background`; spawn `bun run index.ts` from tests (call `command.run(args)` in-process); re-run full suite with different filters after failure (run failing file in isolation first).
## Self-Referential Hook Editing
- DON'T split edits to a live PreToolUse hook — broken intermediates block all tools; only `git checkout -- <file>` recovers. When swapping import+usage: add new import → swap call site → remove old import. Grep all callers before changing a shared function's return type.
## Dispatch & Daemon Context
- DON'T `detectTerminal()` in daemon — read `_terminal` from payload. DON'T `JSON.parse(enrichedPayloadStr)` per hook — use `buildSpawnContext()` once.
- DON'T `merge({}, payload, ...)` — mutate directly (deep clones duplicate `_env` ~50KB). DON'T read-modify-write JSONL in hot paths — `appendFile` only.
- Cap AI prompt context size in hooks. Trace actual code path (daemon vs CLI) when diagnosing dispatch failures.
- `backfillPayloadDefaults()` (`src/dispatch/payload-backfill.ts`): cwd payload → `$GEMINI_CWD`/`$GEMINI_PROJECT_DIR`/`$CLAUDE_PROJECT_DIR` → `process.cwd()`; session_id → `$GEMINI_SESSION_ID` → latest `~/.claude/projects/<projectKey>/*.jsonl` mtime → `"unknown-session"`. Records `payload._inferredFields`.
