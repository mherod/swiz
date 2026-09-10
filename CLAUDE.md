# CLAUDE.md
---
description: Swiz CLI guidance — architecture, patterns, and conventions.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---
## Runtime
- Use Bun only. DO NOT use Node.js, npm, pnpm, vite, dotenv, or Node-specific tooling.
- Use `bun <file>`, `bun test`, `bun install`, `bun run index.ts`, `bun --hot index.ts`, `bun link`.
- Prefer `swiz <command>`.
- Use `bun run index.ts <command>` to guarantee checkout execution and avoid PATH `swiz` version drift.
- Use `Bun.file()` and `Bun.write()` for file I/O.
- Use `node:fs/promises` only for directories (`readdir`, `mkdir`, `stat`).
## CLI Architecture
- Entry: `index.ts`; register `src/cli.ts` commands through `Command` (`src/types.ts`); keep manual `process.argv` parsing.
- Use `@anthropic-ai/claude-agent-sdk` `query()` for Claude; don't spawn the `claude` CLI.
- Extract helpers into canonical modules (`agent-paths.ts`) to limit complexity.
- Antigravity remote MCP servers use `serverUrl` (and `headers`); other agents (Cursor, Codex, Claude) use `url`. `translateServerForAgent()` in `src/commands/manage.ts` translates keys during merge/sync.
## Project Root Resolution
- Resolve project root with `dirname(Bun.main)`.
- DO NOT use `join(dirname(Bun.main), "..")`; it breaks `bun link` execution.
## Hook development
- Read [hooks/CLAUDE.md](hooks/CLAUDE.md) before hook, manifest, dispatch, schema, or related utility work. Paths are repository-relative.
## Task Data
- Task storage: `createDefaultTaskStore()` in `src/task-roots.ts` via `getTaskRoots()` in `src/provider-adapters.ts`.
- Cross-session checks: `stop-completion-auditor.ts` scans `~/.claude/tasks/` via `readSessionTasks()`.
- **Codex task retirement**: Codex native task tools are retired (`codex.tasksEnabled = false`). Swiz task governance hooks stand down for Codex (`detectCurrentAgentFromHookPayload` returns `codex`). Never add `update_plan` to `TASK_TOOLS`, matchers, or dispatch routes.

- After compaction, first action is `TaskList`/`TaskCreate`/`TaskUpdate`; close stale tasks via `git log --oneline -3`.
- `pretooluse-require-tasks.ts` blocks Edit/Write/Bash unless ≥2 incomplete tasks AND ≥1 `pending`.
- Prior-session task blocks: complete prior-session `in_progress` tasks (`TaskUpdate status: completed`) before new Bash. If work remains, recreate with `TaskCreate`.
- One verb per task subject; `pretooluse-task-subject-validation.ts` rejects compound subjects. DON'T list multiple files/steps in one subject.
- Keep ≥1 `pending`/`in_progress` task open through all shell work, `git add`, and `git commit`; before completing the last incomplete task create a pending next-step task — `pretooluse-require-tasks.ts` blocks at zero.
- **Task store is dual-keyed**: `src/commands/mcp.ts` keys by `projectKeyFromCwd(cwd)`, native tools by session id. Gating/counting surfaces must use `readTasksAcrossStores(sessionId, projectKeyFromCwd(cwd), tasksDir)` (bare `readTasks` shows an empty MCP queue). Merge cache lists with `mergeTaskStoresByRecency`; `TaskStateCache` watches project-key dir directly.
- `TaskUpdate` rejects `in_progress` -> `pending`. DON'T open a task speculatively for a one-off read-only check.
- **NEVER** let guardrails, task/branch gates, or scope boundaries harden into refusing obviously-wanted work; on tracked, well-specified issues execute a minimal concrete step rather than explaining why you "cannot".
- Run `/commit` before `git commit` (`pretooluse-commit-skill-gate` enforces it); it checks task preflight and Conventional Commits `<type>(<scope>): <summary>`.
- Call task tools every 20 calls; staleness gate at 40.
- **DO**: Use native task tools, not `swiz tasks` CLI (exception: `swiz tasks adopt`); change a subject via `TaskUpdate` `subject`/`description`.
- **DO**: Use `createTaskInProcess()` from `src/tasks/task-service.ts` or `createSessionTask()` from `hook-utils.ts` in hooks.
- Call `TaskUpdate` after each file, at least every 3 edits.
- Exempt Bash: `ls`, `rg`, `grep`; read-only `git` (`log`, `status`, `diff`, `show`, `branch`, `remote`, `rev-parse`); `git push/pull/fetch`; all `gh`; `swiz issue close/comment`.
- `find` is not exempt; use `rg` or Glob.
- DO NOT create task solely for `git push`, `gh`, or `swiz issue close/comment` (`SWIZ_ISSUE_RE`, `GH_CMD_RE`).
- **Task completion**: `TaskUpdate` `taskId` + `status: completed`; evidence in `description`: `commit:`, `pr:`, `file:`, `test:`, `note:`.
- **DON'T**: Assume CI success from partial output or from `gh run watch` alone. Confirm every job: `gh run view <run-id> --json conclusion,status,jobs`.
- Treat `gh issue create` and task completion as atomic; recover with `TaskUpdate`.
- After each `CLAUDE.md` edit run `wc -w CLAUDE.md`: the lefthook `memory` step hard-fails commits above project `memory-word-threshold` (3500 via `swiz settings show --project`, not `/compact-memory`'s laxer analyzer). Offset additions with trims in the same pass.
- Before adding a `CLAUDE.md` rule, scan nearby rules for conflicts.
- Before issue labeling, run `gh label list`; use requested literal labels when present.
- After `gh issue create`, run `/refine-issue <number>` and apply readiness label.
- **DON'T**: Use `$(cat <<'EOF')` in `gh issue create --body` — redirect guard blocks it. Write body to `/tmp/swiz-issue-N.md`, use `--body-file`.
- Before stop, audit open issue labels; if stop hook lists actionable issues, pick one via `/work-on-issue <number>` (prioritize `ready` over `backlog`).
## Standard Work Sequence
- Per work unit:
  1. `TaskCreate`/`TaskUpdate` -> `in_progress`.
  2. Edit/Bash implementation.
  3. `git add` + `git commit`.
  4. `TaskUpdate` -> `completed`.
  5. `SHA=$(git rev-parse HEAD)`.
  6. `git log origin/main..HEAD --oneline`.
  7. Run `/push`, then `swiz push-wait origin <permitted-branch>`; project trunk policy selects main.
  8. `swiz ci-wait $SHA --timeout 300`: 0=verified, 1=failure/timeout, 2=error, 3=skipped (`ignoreCi`).
  9. `gh run view <run-id> --json conclusion,status,jobs` confirms completion/jobs; required after skips. Fix failures.
  10. Announce result.
- Keep `Push and verify CI` task `in_progress` until `gh run view --json` confirms success.
- Use `swiz push-wait` for pushes and cooldowns (no fixed sleeps or `--force-with-lease`) and `swiz ci-wait` for CI; no manual watch/view loops.
- Don't call `TaskUpdate`/`TaskList` during steps 7-10.
- Push is inseparable from commit: don't stop after step 3; the stop hook requires origin current.
- Await background pushes (`TaskOutput block:true`) before CI and active tasks (`manage_task`) before `git commit`/`push`, preventing `.git/index.lock` collisions. **DON'T** pass `TaskOutput` timeout > 120000ms.
- Use `swiz issue resolve <number> --body "<text>"`, not `gh issue comment` + `gh issue close`; close-only: `swiz issue close <number>`.
- **DON'T** close as `duplicate`/`wontfix` without file+line evidence per acceptance criterion.
- **DO** check issue state before resolving: `gh api repos/:owner/:repo/issues/{number} --jq '.state'`; `Fixes #N` auto-closes on push.
## Push and CI
- **DO**: Run `swiz settings show --project` before `/commit`, `/push`, or `/rebase-and-merge-into-main`; its effective project settings are the branch-policy authority.
- **DO**: With project `trunk-mode` enabled and `strict-no-direct-main` disabled, stay on default branch and push directly. Contributor/PR activity or unknown collaboration heuristics affect timing but cannot force a feature branch; remote or branch-protection rejection is authoritative.
- CI `paths-ignore`: `.claude/**`, `docs/**` — only those paths skip; markdown triggers CI.
- Pre-push checklist:
  0. Run `/push` before every push and reconcile its heuristics with `swiz settings show --project`; explicit project trunk mode wins the branch-model decision.
  1. `git branch --show-current`; `gh pr list --state open --head $(git branch --show-current)`.
  2. `git push origin <permitted-branch>` (lefthook pre-push runs full `bun test`); with project trunk mode enabled, the permitted branch is the configured default branch.
  3. **CI** run id from `gh run list --commit "$SHA" --limit 15`—row `[0]` may be Dependabot (**MEMORY.md**).
  4. `gh run watch <run-id> --exit-status`.
  5. `gh run view <run-id> --json conclusion,status,jobs --jq '{conclusion,status,jobs:[.jobs[]|{name,conclusion,status}]}'`.
- DO NOT use `gh run view --commit <SHA>`; list-by-commit then view-by-id.
- No `--no-verify`; pre-push runs `bun test`; CI jobs `lint -> typecheck -> test` must pass.
- Pre-push `bun test` may fail with `proc.stdin.write` TypeError under concurrent load (`Bun.spawn` exhaustion): rerun the failing test in isolation, then retry.
- If a bounded `bun test --reporter=dots --parallel=4` run exposes file-isolated failures, run each failing file directly, await every process, then rerun the exact lefthook pre-push selection.
- **DO**: Before stop after push, confirm the **MEMORY.md** triad: CI **completed** + jobs, `TaskUpdate` if shipped. **DON'T** skip it for `task #unkn-1` or an unstructured workflow.
- DO NOT block waiting for CI. Check once with `gh run view`; `in_progress` is acceptable — pre-push ran full test suite.
- `github.base_ref` is empty on `push` events; use only on `pull_request`/`pull_request_target`.

- Push-command parsing: token-parse to distinguish `git push --force` vs `git push -- --force`, including `-C <path>` global options.
- DO NOT run branch/collaboration/open-PR checks after push.
- DO NOT add `Co-Authored-By` or AI attribution in commits/PR descriptions.
- DO NOT use destructive git: `revert`, `restore`, `stash`, `reset --hard`, `checkout -- <file>`; use `reflog`. Exception: `stash list`/`stash show` (read-only).
- DO: Read full file before reverting edits — Biome auto-formatting changes other sections.
## Source components
- Read [src/CLAUDE.md](src/CLAUDE.md) before daemon, settings, or CLI work. Paths are repository-relative.
## Conventions
- No top-level `await` in `src/` (ESLint `no-restricted-syntax`). Use lazy async init with cache. `hooks/` exempt.
- No ESC (0x1b) in regex literals (Biome `no-control-regex`). Construct at runtime: `new RegExp(String.fromCharCode(27) + "\\[[0-9;]*[a-zA-Z]", "g")`. Reference: `hooks/posttooluse-task-output.ts`.
- When parsing bun test output, check `/\bRan \d+ tests? across \d+ files?\./`; if absent, emit "unknown number of". Strip ANSI before matching.
- Testing multiline TOML strings with `Bun.TOML.parse()`: use `.trim()` on parsed string values. Bun 1.4+ trims the immediate newline after `"""`, while Bun ≤1.3 retains it.
- **DO**: Rename declarations and all usages in one edit — splits in PreToolUse hooks cause deadlocks. **DON'T** add unrequested renames; change only what was asked for.
- **DO**: When removing utility functions, grep usages and remove atomically. Removing only the definition leaves broken imports.
- DO: Read every file in full before editing — snippets miss conflicts and patterns in other sections.
- Use ANSI escape codes directly; do not add color libraries.
- Prefer `Bun.spawn(["sh", "-c", cmd])` in skills/hooks.
- Piped `Bun.spawn`: drain stdout/stderr concurrently via `Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])` before `await proc.exited`.
- Hooks are `.ts` and run as `bun hooks/<file>.ts`.
- Settings writes must create `.bak` backup first.
- Stop hooks inject session tasks from `~/.claude/tasks/<session_id>/`; format `IN PROGRESS` before `COMPLETED`.
- Stop-memory prompts must include `Cause: <cause>`.
- On `MEMORY CAPTURE ENFORCEMENT`, read `/update-memory/SKILL.md`, edit `CLAUDE.md`, resolve immediately.
- When unblocking a gated session: complete prior task with evidence, create `in_progress` task before tool calls.
- `pretooluse-require-tasks.ts` and `pretooluse-update-memory-enforcement.ts` skip outside git repos or without `CLAUDE.md` (guard with `isGitRepo(cwd)` + upward search, else exit 0).
- **DO**: Own every diagnostic — never label warnings "pre-existing". Investigate all test failures before completing tasks.
- **DON'T**: Attribute feedback to "hooks", "systems", or "auto-steer" — all from the user. Act immediately.
- **DON'T**: End with permission questions — authority is delegated. Execute; state what you're doing.
- Test Biome changes with `biome check .`, not `biome check src/`; add overrides for dirs with valid console usage.
- Bun test reporter: `--reporter=dots`. Multi-file runs use bounded workers (`--parallel=<1-8>`); never `--concurrent`. Run unpiped; piped re-runs trigger repeated-test hook.
- **DO**: In `ci-routes.test.ts` and `issue-routes.test.ts`, use per-test cleanup or `afterAll` for registries/repos. **DON'T** delete shared temp `cwd` in `afterEach`.
- **DO**: Edit a file between `bun run format` and `bun run lint` — hook detects no file changes on consecutive runs.
- No `cd` in Bash; use absolute paths, `git -C`, `pnpm --prefix`, or `cwd` in `Bun.spawn()`.
- `sed -i`/`sed > file` blocked; `sed -n` allowed. Use Read `offset`/`limit`.
- `awk` is blocked entirely; prefer `bun -e`, `cut`, `git --format`.
- Do not use `python`/`python3`; use `bun -e` or `jq`.
- No `rm`/`rm -rf`; use `trash <path>`; guard with `[[ -e <path> ]] && trash <path>`.
- DO NOT edit `~/.claude/hooks/` or `~/.claude/skills/` (external repos). For cross-repo bugs, file an issue with error, root cause, fix, and criteria.
- **DO NOT mark tasks complete without shipped code:** modify source, verify `git diff`, commit, mark complete.
- Stop footers with `REMINDER_FRAGMENT` re-trigger memory enforcement. `pretooluse-update-memory-enforcement.ts` uses 30-min `CLAUDE.md` mtime cooldown; run `swiz install` after hook changes.
- Cache keys: use `getCanonicalPathHash()` in `hook-utils.ts`. DO NOT duplicate cache-key logic.
- In CLI subprocess tests, do not set `cwd: process.cwd()`; use absolute `indexPath = join(process.cwd(), "index.ts")`, temp `cwd`, and `HOME: tempDir`.
- No Agent tool `isolation: "worktree"` — corrupts `.git/config`.
- For secret test fixtures, build via array join (`['s','k','_','l','i','v','e','_',...].join('')`) — push protection blocks literal secrets.
- **DO**: In subprocess tests reaching `hasAiProvider() || detectAgentCli()`, pass `AI_TEST_NO_BACKEND: "1"` — prevents real backend calls. Exempt: tests with `GEMINI_API_KEY: "test-key"` + `GEMINI_TEST_RESPONSE`.
- **DON'T**: Treat first-run `pretooluse-repeated-lint-test` blocks as violations. Workaround: make any Edit between runs.
- Declare commit or push success only after confirming tool output.
- **DO**: Use `mergeActionPlanIntoTasks(planSteps, sessionId, cwd)` in action-plan hooks to auto-create tasks before calling `blockStop`/`denyPreToolUse` (which call `process.exit(0)`).
