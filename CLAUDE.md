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
## Project Root Resolution
- Resolve project root with `dirname(Bun.main)`.
- DO NOT use `join(dirname(Bun.main), "..")`; it breaks `bun link` execution.
## Hook System
- Hooks live in `hooks/`; canonical manifest is `manifest` in `src/manifest.ts`.
- Canonical events are camelCase: `stop`, `preToolUse`, `postToolUse`, `sessionStart`, `userPromptSubmit`.
- Translation layer only:
  - `EVENT_MAP` maps canonical events to Claude and Cursor names (`UserPromptSubmit` -> Cursor `beforeSubmitPrompt`).
  - `TOOL_ALIASES` maps tool names per agent (`Bash` vs `Shell`).
  - Claude config uses nested matcher groups in `~/.claude/settings.json`; Cursor uses flat `version: 1` list in `~/.cursor/hooks.json`.
- Add hook flow:
  1. Add `hooks/<name>.ts`.
  2. Add entry to `manifest` in `src/manifest.ts`.
  3. If new event: update `DISPATCH_ROUTES` in `src/commands/dispatch.ts` and each agent `eventMap` in `src/agents.ts`.
  4. Run `swiz install --dry-run`.
  5. Run `swiz install` to write dispatch entries.
- Keep `DISPATCH_ROUTES`, `manifest`, and agent `eventMap` synchronized.
- `validateDispatchRoutes()` in `src/manifest.ts` must pass from both `swiz dispatch` and `swiz install`.
- Keep `src/dispatch-routing.test.ts` passing.
- DO NOT hard-code agent-specific event names or tool names in hook scripts.
- `classifyHookOutput` in `src/dispatch/engine.ts` extracts JSON from polluted stdout (non-JSON prefix text from SDK log lines). DO NOT revert this fallback — it's defense-in-depth against any SDK writing to `process.stdout` in hook subprocesses.
## Writing Hooks
- Update `README.md` whenever `src/manifest.ts` changes.
- `src/readme-hook-counts.test.ts` invariants:
  1. `### <EventName> (N)` heading count matches section table rows.
  2. README intro `**N hooks**` (line 7) matches manifest total.
  3. Every README hook filename exists on disk.
- For each new hook: increment section count, add table row, increment intro `**N hooks**`, run `bun test src/readme-hook-counts.test.ts`.
- Hooks are TypeScript, use `hooks/hook-utils.ts`, read JSON stdin, and exit `0`.
- Output helpers (all return `never`, call `process.exit(0)`, never write stdout after them):
  - PreToolUse: `denyPreToolUse(reason)` — block with ACTION REQUIRED footer; `allowPreToolUse(reason)` — allow with optional hint; `allowPreToolUseWithUpdatedInput(updatedInput, reason?)` — allow with modified input.
  - PostToolUse: `denyPostToolUse(reason)` — feed error back to Claude.
  - Context injection: `emitContext(eventName, context, cwd?)` — use for SessionStart, UserPromptSubmit, and PostToolUse `additionalContext`; handles `systemMessage` wrapper and state-line injection automatically.
  - Stop: `blockStop(reason, opts?)` — block with ACTION REQUIRED footer; `blockStopRaw(reason)` — block without footer.
- **DO NOT** write `console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: ..., permissionDecision: "allow" } }))` — use `allowPreToolUse(reason)` instead.
- **DO NOT** write `console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: ..., additionalContext: ... } }))` — use `emitContext(eventName, context, cwd)` instead.
- **DO NOT** write `console.log(JSON.stringify({ decision: "block", reason: ... }))` in Stop hooks — use `blockStop(reason)` or `blockStopRaw(reason)` instead.
- **Git Utilities Policy** — canonical locations, no duplication:
  - `hooks/hook-utils.ts` — hook Git helpers: regexes (`GIT_PUSH_RE`, `GIT_MERGE_RE`, etc.), extractors, runtime helpers (`git`, `gh`, `ghJson`).
  - `src/git-helpers.ts` — command Git helpers: classifiers (`isDocsOrConfig`, `parseCommitType`), status types, queries.
  - DO NOT define Git utilities locally — import from canonical source. Duplicates: move to canonical file, update consumers, delete local.
- **GitHub API Throttle** (`src/gh-rate-limit.ts`): `await acquireGhSlot()` before every `gh` CLI call. `gh()` calls it; direct `Bun.spawn(["gh"...` must too. 4500 req/hr rolling window. Exempt: `gh auth status`, `gh run watch`.
- Skill helpers: `skillExists` (checks `.skills/` and `~/.claude/skills/` for `SKILL.md`), `skillAdvice`.
- Cross-agent tool checks: `isShellTool`, `isEditTool`, `isFileEditTool`, `isCodeChangeTool`, `isTaskTool`, `isTaskCreateTool`.
- Task-tracking exemptions: `isTaskTrackingExemptShellCommand()` exempts read-only git, `gh`, `swiz`, setup, and recovery commands (`RECOVERY_CMD_RE`: `ps`, `lsof`, `trash`, `wc`). **DO**: Verify hook deny-message commands are task-exempt. **DON'T**: Add broad patterns (e.g., `cat`) to `RECOVERY_CMD_RE`.
- Package manager helpers: `detectPackageManager()`, `detectPkgRunner()`.
- Typed inputs: `StopHookInput`, `ToolHookInput`, `SessionHookInput` — use typed schema parse (`stopHookInputSchema`, `toolHookInputSchema`, `fileEditHookInputSchema`, `shellHookInputSchema`, `sessionHookInputSchema`) or direct type annotation; **DO NOT** use `as { ... }` casts for stdin.
- Hook schemas (`hooks/schemas.ts`, all `z.looseObject`): `fileEditHookInputSchema`, `shellHookInputSchema`, `toolHookInputSchema`, `stopHookInputSchema`, `sessionHookInputSchema`, `hookOutputSchema`, `taskUpdateInputSchema`. Settings schemas (`src/settings.ts`): `swizSettingsSchema`, `projectSettingsSchema`, `sessionSwizSettingsSchema`, `projectStateSchema`. State schemas (`src/state-machine.ts`): `workflowIntentSchema`, `statePrioritySchema`, `stateMetadataSchema`.
- **DO**: All three memory-threshold checkpoints — `pretooluse-claude-md-word-limit.ts`, `posttooluse-memory-size.ts`, `swiz memory --strict` — must share the same value via `resolveThresholds(cwd)` (project > global > default 5000). Never hardcode — mismatched thresholds cause commits to fail after edits succeed.
- **DO**: For PreToolUse hooks that validate file content (not just tool names/paths), compute projected content for Edit tools: read `Bun.file(filePath).text()`, apply `currentContent.replace(old_string, new_string)`, then validate. DON'T parse raw `new_string` — it's often a fragment, not complete file content. Reference: `pretooluse-no-direct-deps.ts` (dep-block guard), `pretooluse-claude-md-word-limit.ts` (word-count guard). Fail-open when file read or JSON parse fails.
- NFKC-normalize `new_string`/`content`/`old_string` before pattern matching in content-inspecting hooks: `.normalize("NFKC")`. Enforced by `src/nfkc-enforcement.test.ts`. Exempt hooks must be listed in `EXEMPT_HOOKS`.
- Use `TEST_FILE_RE` (`.test.ts`, `.spec.ts`, `__tests__/`, `/test/`) for test-file exclusions.
- DO NOT test external repo code in this repo; file issue in owning repo instead.
- Track current diff file from `+++ b/<path>` headers; apply file-level exclusions via that path.
- Use `sanitizeSessionId()` for `/tmp` names.
- DO: Use `src/temp-paths.ts` for `/tmp` paths; no `/tmp/*` literals.
- DO NOT hardcode `/tmp` sentinel session IDs in tests; use unique IDs or `mtime` checks.
- For `pgrep` checks, use ancestry (`process.ppid`) and repo scope (`lsof -p <pid> -d cwd -Fn`).
- Reference implementation: `hooks/stop-git-status.ts`.
- For `~/.claude/projects/` lookups, import `projectKeyFromCwd` from `src/transcript-utils.ts`; use encoding `cwd.replace(/[/.]/g, "-")`.
- DO NOT reimplement project-key logic with slash-only replacement (`/\//g`).
- In `hook-utils.ts`, use lazy `await import("../src/transcript-utils.ts")` for `projectKeyFromCwd` consumers to avoid circular imports.
- For workflow enforcement, scan `transcript_path` for reminder and completion evidence instead of extra state files/flags.
- Pattern: `pretooluse-update-memory-enforcement.ts` requires transcript evidence of reading `update-memory/SKILL.md` and writing a `.md` file (for example `CLAUDE.md`) before unblocking.
- Memory-reminder text must include explicit trigger cause.
- Cross-repo issue guidance: `buildIssueGuidance()` in `hook-utils.ts`. Sandbox enforcement hooks (`pretooluse-protect-sandbox`, `pretooluse-sandboxed-edits`) delegate to it. Generic: `buildIssueGuidance(null)`; cross-repo: `buildIssueGuidance(repo, { crossRepo: true, hostname })`.
## Task Data
- Task storage: `~/.claude/tasks/<session-id>/<id>.json`; audit log: `~/.claude/tasks/<session-id>/.audit-log.jsonl`.
- Session-to-project mapping resolves from `~/.claude/projects/` transcript `cwd` fields.
- Cross-session task checks in `hooks/stop-completion-auditor.ts`: fallback scan `~/.claude/tasks/`, load JSON via `readSessionTasks()`.
- Completion requires evidence: `swiz tasks complete <id> --evidence "text"`; enforced by `stop-completion-auditor`.
- First action must be `TaskCreate`/`TaskUpdate`; required again after compaction resumes.
- `pretooluse-require-tasks.ts` blocks Edit/Write/Bash when no incomplete task exists.
- Prior-session task blocks: recreate and set `in_progress` before retrying.
- After compaction: `TaskList`, close stale tasks after `git log --oneline -3`.
- One verb per task subject; `pretooluse-task-subject-validation.ts` rejects compound subjects.
- Keep at least one `pending`/`in_progress` task before `git add` or `git commit`; mark commit task complete only after commit success.
- Run `/commit` before `git commit`; `pretooluse-commit-skill-gate` enforces it.
- `/commit` checks: branch verification, task preflight, Conventional Commits `<type>(<scope>): <summary>`.
- Run `git branch --show-current` early (before first commit) to satisfy commit gate transcript checks.
- Call task tools (`TaskUpdate`, `TaskCreate`, `TaskList`, `TaskGet`) regularly: at least every 10 calls; staleness gate triggers at 20.
- During multi-file work, call `TaskUpdate` after each file; add updates at least every 3 edits.
- Create tasks before non-exempt Bash.
- **DON'T**: Complete last in-progress task while shell commands remain. Keep ≥1 `in_progress` until all shell work finishes.
- Exempt Bash categories: `ls`, `rg`, `grep`; read-only `git` subcommands (`log`, `status`, `diff`, `show`, `branch`, `remote`, `rev-parse`, etc.); `git push/pull/fetch`; all `gh`; `swiz issue close/comment`.
- `find` is not exempt; use `rg` or Glob.
- DO NOT create task solely for `git push`, `gh`, or `swiz issue close/comment` (`SWIZ_ISSUE_RE`, `GH_CMD_RE`).
- Stop requires no uncommitted changes (`stop-git-status.sh`).
- **Task completion**: `swiz tasks complete <id> --evidence "note:..."`. Valid evidence prefixes: `commit:`, `pr:`, `file:`, `test:`, `note:` — compound strings and unrecognized prefixes rejected. Plain `TaskUpdate status=completed` rejected by stop hooks.
- **`swiz tasks complete` has NO `--subject` flag**. For native-tool tasks: stub via `swiz tasks update <id> --subject "..." --status in_progress`, then complete.
- **`swiz tasks update` bulk IDs**: `swiz tasks update <id1> <id2> ... [--subject TEXT] [--status STATUS]` — leading non-flag tokens are IDs.
- **DON'T**: Assume CI success from partial output (e.g., `gh run watch` alone). Always verify terminal job states with `gh run view <run-id> --json conclusion,status,jobs` and confirm every job reached `conclusion: "success"` before claiming CI green.
- Mark tasks complete immediately on completion.
- Treat `gh issue create` and task completion as atomic; recover with `swiz tasks complete <id> --session <session-id> --evidence "note:..."`.
- Run `git diff <files>` before `git add`.
- Run `git status` immediately after each `git commit`.
- After each `CLAUDE.md` edit, run `wc -w CLAUDE.md`; run `/compact-memory` when approaching the threshold (default 5000, project-configurable via `.swiz/config.json` `memoryWordThreshold`).
- Before adding a rule to `CLAUDE.md`, scan nearby rules for conflicts.
- Before issue labeling, run `gh label list`; use requested literal labels when present, otherwise ask before substituting.
- When user provides explicit labels, remove conflicting inferred labels; do not restore inferred labels.
- After `gh issue create`, immediately run `/refine-issue <number>` and apply readiness label (`ready`, `triaged`, `confirmed`, `accepted`, `spec-approved`); `backlog` is not readiness.
- Before stop, audit labels: `gh issue list --state open --json number,title,labels --jq '.[] | select(.labels | map(.name) | any(. == "ready" or . == "backlog" or . == "blocked" or . == "wontfix" or . == "duplicate" or . == "upstream")) | .number'`.
- If stop hook lists actionable issues, pick at least one via `/work-on-issue <number>`; prioritize `ready` over `backlog`.
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
- Use `swiz push-wait`; no fixed sleeps and no `--force-with-lease`.
- Use `swiz ci-wait`; no manual watch/view loops.
- Don't call `TaskUpdate`/`TaskList` during steps 7-10.
- Don't stop after step 3; stop hook requires origin up to date.
- Push is inseparable from commit.
- Await background pushes (`TaskOutput block:true`) before CI verification.
- Use `swiz issue resolve <number> --body "<text>"` (not `gh issue comment` + `gh issue close`); close-only: `swiz issue close <number>`.
- **DON'T** close as `duplicate`/`wontfix` without reading the implementation and verifying each acceptance criterion. "Already implemented" requires file+line evidence, not inference.
- **DO** check issue state before resolving: `gh issue view <number> --json state -q .state`. `Fixes #N` in a commit message auto-closes on push — `swiz issue resolve` on a closed issue posts a comment (doesn't fail, but wastes an API call).
## Push and CI
- Repo is solo (`mherod/swiz`); push directly to `main` (no PR required).
- Run `/push` before `git push`; PreToolUse push gate requires it.
- If collaboration guard errors, fix and re-run guard checks before pushing.
- CI workflow (`.github/workflows/ci.yml` lines 3-21) `paths-ignore`: `**/*.md`, `.claude/**`, `docs/**` — markdown-only commits skip CI; pre-push hooks verify quality locally.
- Pre-push checklist:
  0. **Run Step 0 collaboration guard** (`/push` skill) before every push to `main`/`master` — execute and read signal checks, never assume repo type.
  1. `git log origin/main..HEAD --oneline`.
  2. `git branch --show-current`; `gh pr list --state open --head $(git branch --show-current)`.
  3. `SHA=$(git rev-parse HEAD)`.
  4. `git push origin main` (lefthook pre-push runs full `bun test`).
  5. `gh run list --commit $SHA --json databaseId --jq '.[0].databaseId'`.
  6. `gh run watch <run-id> --exit-status`.
  7. `gh run view <run-id> --json conclusion,status,jobs --jq '{conclusion,status,jobs:[.jobs[]|{name,conclusion,status}]}'`.
- DO NOT use `gh run view --commit <SHA>` (unsupported); always list-by-commit then view-by-id.
- During cooldown use `swiz push-wait origin <branch>` instead of raw `git push`.
- Never bypass mandatory hooks: no `--no-verify`; pre-push runs `bun test`; CI jobs `lint -> typecheck -> test` must pass.
- Always verify CI with `gh run view --json`; `gh run watch` alone is insufficient.
- DO NOT block the session waiting for CI. If pre-push hooks pass, continue; check once with `gh run view` later (or daemon notifications).
- For workflow jobs using `github.base_ref`, run only on `pull_request`/`pull_request_target`, never `push`; `github.base_ref` is empty on push and breaks `git diff origin/BASE_REF...HEAD`.

- Push-command parsing in hooks: token-parse to distinguish `git push --force` vs `git push -- --force`, including `-C <path>` global options.
- DO NOT call `TaskUpdate` or `TaskList` after push starts.
- DO NOT stop with unpushed commits.
- DO NOT push to `main`/`master` without running the Step 0 collaboration guard and reading its output (`dbe3440`, `2339489` skipped this gate).
- DO NOT skip `git log origin/main..HEAD --oneline` pre-push review.
- DO NOT run branch/collaboration/open-PR checks after push.
- DO NOT add `Co-Authored-By: Claude` or other AI attribution in commits/PR descriptions.
- DO NOT use destructive git commands: `git revert`, `git restore`, `git stash`, `git reset --hard`, `git checkout -- <file>`; use `git reflog` for recovery.
- DO: When reverting file edits, read the full file first — Biome auto-formatting may have changed other sections, so naive diff-based undos create new errors.
## Daemon
- `src/commands/daemon.ts`: long-lived `Bun.serve` on port 7943; serves multiple projects simultaneously — scope per-project state by `cwd`.
- Endpoints: `/health`, `/dispatch` (POST), `/status-line/snapshot` (POST), `/metrics` (GET), `/ci-watch` (POST), `/ci-watches` (GET).
- `swiz daemon status` fetches `/metrics`. Metrics are in-memory only; tracked globally and per-project.
- LaunchAgent: `~/Library/LaunchAgents/com.swiz.daemon.plist`; `swiz daemon --install` / `--uninstall`.
- **DO**: In daemon-served `src/web/**` modules, use browser-resolvable imports only (`./`, `../`, `/web/...`). **DON'T** use bare package imports unless daemon adds import-map/bundling support.
- **DO**: After web-import changes, restart daemon (`lsof -ti tcp:7943 | xargs -r kill && bun run index.ts daemon --port 7943`) and diagnose from newest console entries for the current URL only.
- **DO**: Use `IssueStore` (`src/issue-store.ts`) as the primary data source for issues, PRs, and CI runs. The daemon's `syncUpstreamState` keeps it fresh; status-line and hooks read from the store first, falling back to `gh` CLI when stale. **DON'T** use per-project file caches — the shared SQLite store (`~/.swiz/issues.db`) replaces them.
- **DO**: When adding fields that consumers need (e.g., `mergeable`, `url`, `createdAt` for PRs), add them to the `syncUpstreamState` query in `src/issue-store.ts` so the stored data has all required fields.
- **DO**: Use REST API fallback (`gh api repos/{owner}/{repo}/issues/{number}`) when `gh issue` commands hit GraphQL rate limits. `src/commands/issue.ts` implements `isGraphQLRateLimited()` detection and automatic REST retry.
## Settings Configuration
- Use separate state files for mutable runtime data (e.g., `.swiz/context-stats.json`); never mix runtime observations into user-authored config (`.swiz/config.json`).
- Use 3-tier setting resolution: `project > user > default`.
- Track source per value, not per group (`memoryLineSource`, `memoryWordSource`).
- Always show effective values, regardless of source tier.
- Label each setting with source tier: `(project)`, `(user)`, `(default)`.
- Do not hide user/default values.
- Do not use one shared `source` for multiple settings.
- Verify before declaring completion: hierarchy, per-value source tracking, display correctness.
- Adding a new boolean setting (global scope) requires updates to 7 files plus tests:
  1. `src/settings/types.ts` — add field to `SwizSettings` interface.
  2. `src/settings/registry.ts` — add `SETTINGS_REGISTRY` entry with `key`, `aliases`, `kind`, `scopes`, `docs`.
  3. `src/settings/persistence.ts` — add to `DEFAULT_SETTINGS` and `swizSettingsSchema`.
  4. `src/settings/resolution.ts` — add to `getEffectiveSwizSettings` base object.
  5. `src/commands/settings.ts` — add display line in `printGlobalSettings`.
  6. `src/web/components/settings-panel.tsx` — add to `GlobalSettingsForm`, `DEFAULT_GLOBAL_FORM`, `globalSettingsToForm`, and `GLOBAL_TOGGLES`.
  7. `src/commands/settings.test.ts` — add to every `SwizSettings` object literal and the `expectedKeys` array in the registry test.
## CLI Error Handling
- In `src/commands/`, throw errors instead of `process.exit(1)`.
- `src/cli.ts` handles command errors via `process.exitCode = 1`.
- `src/commands/continue.ts` pattern: `process.exitCode = proc.exitCode ?? 0; return`.
- Hook scripts (`hooks/*.ts`) are the exception: `process.exit(0)` is intentional.
- In CI/hook scripts, do not use `console.log` for status/debug; use `console.error`.
- `src/debug-logging.test.ts` enforces allowlists for `console.error`/`console.warn` (STDERR_ALLOWLIST) and `console.log`/`console.info` (STDOUT_ALLOWLIST). Files not on an allowlist must use `import { debugLog } from "./debug.ts"` for diagnostics. Adding to an allowlist requires a justification comment in the test.
- Reference implementations: `src/issue-store.ts`, `src/manifest.ts`, `src/commands/tasks.ts`.
## Conventions
- DO NOT embed ESC (0x1b) in regex literals — Biome's `no-control-regex` blocks it. Construct at runtime: `new RegExp(String.fromCharCode(27) + "\\[[0-9;]*[a-zA-Z]", "g")`. Reference: `hooks/posttooluse-task-output.ts` `ANSI_RE`.
- When parsing bun test output for counts, check for `/\bRan \d+ tests? across \d+ files?\./` before reporting an exact figure; absent the marker, output is truncated — emit "unknown number of". Strip ANSI before matching. Reference: `detectFailure` in `hooks/posttooluse-task-output.ts`.
- **DO**: Rename variable/constant declaration and all usages in one edit. Split renames in PreToolUse hooks cause unrecoverable deadlocks (broken hook blocks Edit/Write/Bash).
- DO: Read every file in full before editing — snippets miss conflicts and patterns in other sections.
- Use ANSI escape codes directly; do not add color libraries.
- Prefer `Bun.spawn(["sh", "-c", cmd])` for shell execution in skills/hooks.
- With piped `Bun.spawn`, drain stdout/stderr concurrently via `Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])` before `await proc.exited`.
- Hooks are `.ts` and run as `bun hooks/<file>.ts`.
- Settings writes must create `.bak` backups first.
- Stop hooks inject session tasks from `~/.claude/tasks/<session_id>/`; format `IN PROGRESS` before `COMPLETED`, before transcript.
- Stop-memory prompts must include `Cause to capture: <specific cause>`.
- On `MEMORY CAPTURE ENFORCEMENT`: read `/update-memory/SKILL.md`, edit `CLAUDE.md` with the DO/DON'T rule, then resume work.
- Do not defer memory capture requested by stop hooks.
- When unblocking a gated session: mark prior task complete with evidence first, then create an `in_progress` task in the current session before executing tool calls; do not attempt tool calls while memory enforcement is active.
- `pretooluse-require-tasks.ts` and `pretooluse-update-memory-enforcement.ts` must skip when not in a git repo or no `CLAUDE.md` exists up the tree; guard with `isGitRepo(cwd)` then upward `CLAUDE.md` search, else `process.exit(0)`.
- Test Biome rule changes with `biome check .` (not only `biome check src/`); add overrides for every directory with valid console usage (`hooks/`, `scripts/`, `push/scripts/`, etc.).
- Bun test reporter: `--reporter=dots --concurrent` (`--concurrent` required by hook). Run once without any pipe — piped re-runs trigger `pretooluse-repeated-lint-test` as consecutive.
- **DO**: Make an Edit between `bun run format` and `bun run lint` — format-via-wrapper lacks `--write` so `pretooluse-repeated-lint-test` doesn't see it as a mutation; consecutive lint runs without an edit trigger a block.
- Do not run `cd` in Bash commands; use absolute paths, `git -C <dir>`, `pnpm --prefix <dir>`, or `cwd` in `Bun.spawn()`.
- `sed -i`/`sed > file` blocked; `sed -n` pipelines allowed. Use Read `offset`/`limit`.
- `awk > file`/`awk | tee -i` blocked; `awk '{print $1}'` and `awk --help` allowed. Prefer `bun -e`, `cut`, or git `--format`.
- Do not use `python`/`python3`; use `bun -e` or `jq`.
- Do not use `rm`/`rm -rf`; use `trash <path>`; guard with `[[ -e <path> ]] && trash <path>`.
- DO NOT edit files outside session sandbox. `~/.claude/hooks/` and `~/.claude/skills/` are owned by external repos. For cross-repo bugs, file GitHub issues with: error, root cause, proposed fix, success criteria.
- **DO NOT mark tasks complete without shipped code.** Always: modify source, verify `git diff`, commit, then mark complete.
- Stop-hook footers with `REMINDER_FRAGMENT` re-trigger memory enforcement. `pretooluse-update-memory-enforcement.ts` uses a 30-minute `CLAUDE.md` mtime cooldown; run `swiz install` after hook changes.
- Cross-session gap: cooldown doesn't carry between sessions; complete memory follow-through before session end.
- Cache-key generation: use shared `getCanonicalPathHash()` in `hook-utils.ts` with `realpathSync()`. DO NOT duplicate cache-key logic across hooks/commands.
- In CLI subprocess tests, do not set `cwd: process.cwd()`; use absolute `indexPath = join(process.cwd(), "index.ts")`, temp-directory `cwd`, and `env: { ...process.env, HOME: tempDir }`.
- Do not use Agent tool `isolation: "worktree"` — corrupts `.git/config` and breaks git.
- For secret-like test fixtures, build via array join (`['s','k','_','l','i','v','e','_',...].join('')`) — push protection blocks literal secrets.
- **DON'T**: Edit files outside session sandbox — Edit tool blocks it. For out-of-sandbox memory threshold violations, file a GitHub issue instead.
- **DO**: After every commit, run `git log origin/main..HEAD --oneline` before stop. Use `/push` for unpushed commits.
- **DON'T**: Rely on `git status` alone for unpush detection—it doesn't show upstream divergence. Always use `git log origin/main..HEAD --oneline` to list unpushed commits.
- **DO**: In subprocess tests reaching `hasAiProvider() || detectAgentCli()`, pass `AI_TEST_NO_BACKEND: "1"` in env overrides — prevents real backend calls on machines with Codex/Gemini installed. Exempt: tests using `GEMINI_API_KEY: "test-key"` + `GEMINI_TEST_RESPONSE`.
- **DON'T**: Treat first-run `pretooluse-repeated-lint-test` blocks as violations. Workaround: make any Edit between runs.
- **DON'T**: Declare commit or push success before reading tool output confirming it.
- **DON'T**: Work on auto-continue findings without a filed issue.
- **DO**: Route LaunchAgent `prPoll` via daemon first, then fallback to `bun index.ts dispatch`.
