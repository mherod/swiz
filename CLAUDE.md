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
- Git/GitHub helpers: `git`, `gh`, `ghJson`, `getOpenPrForBranch`, `isGitRepo`, `isGitHubRemote`, `hasGhCli`.
- Skill helpers: `skillExists` (checks `.skills/` and `~/.claude/skills/` for `SKILL.md`), `skillAdvice`.
- Cross-agent tool checks: `isShellTool`, `isEditTool`, `isFileEditTool`, `isCodeChangeTool`, `isTaskTool`, `isTaskCreateTool`.
- Package manager helpers: `detectPackageManager()`, `detectPkgRunner()`.
- Typed inputs: `StopHookInput`, `ToolHookInput`, `SessionHookInput` — use typed schema parse (`stopHookInputSchema`, `toolHookInputSchema`, `fileEditHookInputSchema`, `shellHookInputSchema`, `sessionHookInputSchema`) or direct type annotation; **DO NOT** use `as { ... }` casts for stdin.
- NFKC-normalize `new_string`/`content`/`old_string` before pattern matching in content-inspecting hooks: `.normalize("NFKC")`. Enforced by `src/nfkc-enforcement.test.ts`. Exempt hooks must be listed in `EXEMPT_HOOKS`.
- Use `TEST_FILE_RE` (`.test.ts`, `.spec.ts`, `__tests__/`, `/test/`) for test-file exclusions.
- DO NOT test external repo code in this repo. Example: remove `src/tasks-list-verify.test.ts` that targeted `~/.claude/hooks/tasks-list.ts`; file issue in owning repo instead.
- Track current diff file from `+++ b/<path>` headers; apply file-level exclusions via that path.
- Use shared `sanitizeSessionId()` for `/tmp` sentinel file names.
- DO NOT hardcode `/tmp` sentinel session IDs in tests; use unique IDs or `mtime` cooldown checks.
- For `pgrep` checks, use two filters: ancestry (`process.ppid`) and repo scope (`lsof -p <pid> -d cwd -Fn`).
- Reference implementation: `hooks/stop-git-status.ts`.
- For `~/.claude/projects/` lookups, import `projectKeyFromCwd` from `src/transcript-utils.ts`; use encoding `cwd.replace(/[/.]/g, "-")`.
- DO NOT reimplement project-key logic with slash-only replacement (`/\//g`).
- In `hook-utils.ts`, use lazy `await import("../src/transcript-utils.ts")` for `projectKeyFromCwd` consumers to avoid circular imports.
- For workflow enforcement, scan `transcript_path` for reminder and completion evidence instead of extra state files/flags.
- Pattern: `pretooluse-update-memory-enforcement.ts` requires transcript evidence of reading `update-memory/SKILL.md` and writing a `.md` file (for example `CLAUDE.md`) before unblocking.
- Memory-reminder text must include explicit trigger cause.
- Cross-repo issue guidance is consolidated in `buildIssueGuidance()` in `hook-utils.ts`. All sandbox enforcement hooks (pretooluse-protect-sandbox, pretooluse-sandboxed-edits) delegate to this function rather than inlining guidance text. Supports both generic guidance (`buildIssueGuidance(null)`) and cross-repo with hostname detection (`buildIssueGuidance(repo, { crossRepo: true, hostname })`) — single source of truth prevents message duplication.
## Task Data
- Task storage: `~/.claude/tasks/<session-id>/<id>.json`; audit log: `~/.claude/tasks/<session-id>/.audit-log.jsonl`.
- Session-to-project mapping resolves from `~/.claude/projects/` transcript `cwd` fields.
- Completion command requires evidence: `swiz tasks complete <id> --evidence "text"`; enforced by `stop-completion-auditor`.
- First action in a session must be task creation/tracking (`TaskCreate`/`TaskUpdate`), including after compaction resumes.
- `pretooluse-require-tasks.ts` blocks Edit/Write/Bash when no incomplete task exists.
- When the no-task block reports prior-session incomplete tasks, recreate equivalent task and set `in_progress` before retrying blocked work.
- After compaction, run `TaskList`; close stale `in_progress`/`pending` tasks after verification (`git log --oneline -3`, `gh run view --json conclusion`).
- DO NOT create compound task subjects; `pretooluse-task-subject-validation.ts` rejects multi-action subjects.
- Keep one task per verb (`Run tests`, `Commit fix`, `Push to origin`, `Verify CI`, `Close issue #N`).
- Keep at least one `pending`/`in_progress` task before `git add` or `git commit`; mark commit task complete only after commit success.
- Run `/commit` before `git commit`; `pretooluse-commit-skill-gate` enforces it.
- `/commit` checks: branch verification, task preflight, Conventional Commits `<type>(<scope>): <summary>`.
- Run `git branch --show-current` early (before first commit) to satisfy commit gate transcript checks.
- Call task tools (`TaskUpdate`, `TaskCreate`, `TaskList`, `TaskGet`) regularly: at least every 10 calls; staleness gate triggers at 20.
- During multi-file work, call `TaskUpdate` after each file; add updates at least every 3 edits.
- Create tasks before non-exempt Bash.
- **DON'T**: Complete your last in-progress task if you still need to run shell commands (e.g., push verification). Either create the next task before completing the current one, or defer completion until all shell work is finished. `pretooluse-require-tasks` blocks Bash when zero incomplete tasks exist.
- Exempt Bash categories: `ls`, `rg`, `grep`; read-only `git` subcommands (`log`, `status`, `diff`, `show`, `branch`, `remote`, `rev-parse`, etc.); `git push/pull/fetch`; all `gh`; `swiz issue close/comment`.
- `find` is not exempt; use `rg` or Glob for discovery.
- DO NOT create task solely for `git push`, `gh`, or `swiz issue close/comment` (`SWIZ_ISSUE_RE`, `GH_CMD_RE`).
- Stop requires no uncommitted changes (`stop-git-status.sh`).
- For push verification task completion use evidence, for example: `swiz tasks complete <id> --evidence "note:CI green — conclusion: success, run <run-id>"`.
- **Task completion format**: Use `swiz tasks complete <id> --evidence "note:..."`. The canonical CLI is `swiz tasks complete`; do not invoke `bun ~/.claude/hooks/tasks-list.ts` directly. The only reliably accepted evidence key is `note:`; do NOT attempt compound keys like `commit:SHA ci_green:run ...` in a single evidence string — the parser rejects them. Use `note:CI green` for CI verification evidence.
- **Evidence field format**: The `--evidence` flag requires exactly one recognized prefix: `note:`, `commit:`, `run:`, `conclusion:`, `ci_green:`, `pr:`, `no_ci:`. Multiple fields in a single string (e.g. `"commit:abc run:123"`) are NOT supported — the parser finds 0 structured fields and rejects the call with "found 0". DO NOT construct multi-field evidence strings without first running `swiz tasks complete --help` to verify the accepted schema. Safe default: use a single `note:` field containing all context inline.
- **DON'T**: Use plain `TaskUpdate` with `status: "completed"` to mark tasks done — stop hooks reject completions without structured evidence. Always use `swiz tasks complete <id> --evidence "note:..."` instead.
- **DON'T**: Assume CI success from partial output (e.g., `gh run watch` alone). Always verify terminal job states with `gh run view <run-id> --json conclusion,status,jobs` and confirm every job reached `conclusion: "success"` before claiming CI green.
- Mark tasks complete immediately at work completion.
- Treat `gh issue create` and task completion as atomic; if missed, recover with `swiz tasks complete <id> --session <session-id> --evidence "note:..."`.
- Run `git diff <files>` before `git add`.
- Run `git status` immediately after each `git commit`.
- After each `CLAUDE.md` edit, run `wc -w CLAUDE.md`; `stop-memory-size.ts` blocks stop above 5000 words.
- Run `/compact-memory` before reaching 5000 words.
- Before adding a new rule to `CLAUDE.md`, scan nearby rules for conflicts.
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
- Keep separate `Push and verify CI` task `in_progress` through steps 5-10; complete only after `gh run view --json` confirms success.
- Capture SHA before push; CI checks must reference that SHA.
- Use `swiz push-wait`; no fixed sleeps and no `--force-with-lease`.
- Use `swiz ci-wait`; no manual `gh run watch/view` loops.
- Do not call `TaskUpdate`/`TaskList` during steps 7-10.
- DO NOT stop after step 3; stop hook requires origin up to date.
- Treat push as inseparable from commit.
- Wait for background pushes (`TaskOutput block:true`) before CI verification.
- Use `swiz issue resolve <number> --body "<text>"` instead of `gh issue comment` + `gh issue close`; for close-only use `swiz issue close <number>`.
- **DO** check issue state before resolving: `gh issue view <number> --json state -q .state`. A `Fixes #N` commit message auto-closes issues when pushed to main — `swiz issue resolve` is redundant on already-closed issues (it will still post a comment, not fail, but wastes an API call).
## Push and CI
- Repo is solo (`mherod/swiz`); push directly to `main` (no PR required).
- Run `/push` before `git push`; PreToolUse push gate requires it.
- If collaboration guard errors, fix and re-run guard checks before pushing.
- CI workflow (`.github/workflows/ci.yml` lines 3-21) has `paths-ignore` for `**/*.md`, `.claude/**`, and `docs/**`; documentation-only commits skip CI intentionally. Pre-push hooks verify code quality locally before push is allowed, so no CI run is needed for markdown-only changes.
- Pre-push checklist:
  0. **Run Step 0 collaboration guard** from the `/push` skill before every push to `main`/`master` — no exceptions. Assumed repo type is not sufficient; the signal checks must be executed and their output evaluated.
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
- For workflow jobs using `github.base_ref`, run only on `pull_request`/`pull_request_target`, never `push`; `github.base_ref` is empty on push and breaks `git diff origin/BASE_REF...HEAD`.
- Example: `.github/workflows/ci.yml` line 45 workflow-permissions job must be PR-only.
- For push-command parsing in hooks, use token parsing to distinguish `git push --force` vs `git push -- --force`, including `-C <path>` global options.
- DO NOT call `TaskUpdate` or `TaskList` after push starts.
- DO NOT stop with unpushed commits.
- DO NOT push to `main`/`master` without running the Step 0 collaboration guard script first and reading its output — two pushes in a prior session (`dbe3440`, `2339489`) skipped Step 0 and violated the mandatory gate.
- DO NOT skip `git log origin/main..HEAD --oneline` pre-push review.
- DO NOT run branch/collaboration/open-PR checks after push.
- DO NOT add `Co-Authored-By: Claude` or other AI attribution in commits/PR descriptions.
- DO NOT use destructive git commands: `git revert`, `git restore`, `git stash`, `git reset --hard`, `git checkout -- <file>`; use `git reflog` for recovery.
## Settings Configuration
- **DO**: Use separate state files for mutable runtime data (e.g., `.swiz/context-stats.json`) to avoid polluting user-authored configuration files (e.g., `.swiz/config.json`). Runtime observations change frequently and should never mix with intentional user settings.
- Use 3-tier setting resolution: `project > user > default`.
- Track source per value, not per group (`memoryLineSource`, `memoryWordSource`).
- Always show effective values, regardless of source tier.
- Label each setting with source tier: `(project)`, `(user)`, `(default)`.
- Do not hide user/default values.
- Do not use one shared `source` for multiple settings.
- Verify implementation directly before declaring completion: hierarchy, per-value source tracking, display correctness.
## CLI Error Handling
- In `src/commands/`, throw errors instead of `process.exit(1)`.
- `src/cli.ts` handles command errors via `process.exitCode = 1`.
- `src/commands/continue.ts` pattern: `process.exitCode = proc.exitCode ?? 0; return`.
- Hook scripts (`hooks/*.ts`) are the exception: `process.exit(0)` is intentional.
- In CI/hook scripts, do not use `console.log` for status/debug; use `console.error`.
- Use `console.log` only for structured machine-consumed output.
- Gate diagnostics with `SWIZ_DEBUG` using `const debugLog = process.env.SWIZ_DEBUG ? console.error.bind(console) : () => {};`.
- Reference implementations: `src/issue-store.ts`, `src/manifest.ts`, `src/commands/tasks.ts`.
## Conventions
- DO NOT embed the ESC character (0x1b) directly in regex literals — Biome's `no-control-regex` rule blocks it. Construct ANSI-matching regexes at runtime: `new RegExp(String.fromCharCode(27) + "\\[[0-9;]*[a-zA-Z]", "g")`. Reference: `hooks/posttooluse-task-output.ts` `ANSI_RE`.
- When parsing bun test terminal output for counts, check for the completion marker `/\bRan \d+ tests? across \d+ files?\./` (note `tests?`/`files?` for singular/plural) before reporting an exact figure; absent the marker output is truncated and the count is untrustworthy — emit "unknown number of" instead. Strip ANSI before matching. Reference: `detectFailure` in `hooks/posttooluse-task-output.ts`.
- DO: Read every file being modified in its entirety before making any change to it. Viewing a snippet of a file is insufficient; the full read is required to catch conflicts or existing patterns in other sections.
- Use ANSI escape codes directly; do not add color libraries.
- Prefer `Bun.spawn(["sh", "-c", cmd])` for shell execution in skills/hooks.
- With piped `Bun.spawn`, drain stdout/stderr concurrently via `Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])` before `await proc.exited`.
- Hooks are `.ts` and run as `bun hooks/<file>.ts`.
- Settings writes must create `.bak` backups first.
- For multiline frontmatter regex, do not use `\s*` after closing delimiter if blank lines must remain; use `[ \t]*\n?`. Avoid `/^---[\s\S]*?^---\s*\n?/m`; use `[ \t]*` instead.
- Stop hooks can inject session tasks from `~/.claude/tasks/<session_id>/`; format `IN PROGRESS` before `COMPLETED`, then inject before transcript.
- Stop-memory prompts must include `Cause to capture: <specific cause>`.
- On `MEMORY CAPTURE ENFORCEMENT`, immediately: read `/update-memory/SKILL.md`, edit `CLAUDE.md` with the DO/DON'T rule, then resume other work.
- Do not defer memory capture requested by stop hooks.
- When unblocking a gated session via prior task completion: mark prior task complete first with evidence, then create an `in_progress` task in current session directory before executing tool calls; do not attempt tool calls while memory enforcement is active.
- `pretooluse-require-tasks.ts` and `pretooluse-update-memory-enforcement.ts` must skip enforcement when not in a git repo or when no `CLAUDE.md` exists up the directory tree; guard with `isGitRepo(cwd)` then upward `CLAUDE.md` search, otherwise `process.exit(0)`.
- Test Biome rule changes with `biome check .` (not only `biome check src/`); add overrides for every directory with valid console usage (`hooks/`, `scripts/`, `push/scripts/`, etc.).
- Bun test reporter must be `--reporter=dots` (not `dot`).
- **DO**: After `bun run format`, make at least one Edit tool change before running `bun run lint`. The `pretooluse-repeated-lint-test` hook's `bashMutatesWorkspace` does not detect `biome format --write .` run via the `bun run format` wrapper (the wrapper command string lacks `--write`), so the hook sees two consecutive lint events with no intervening edit and blocks the second run.
- Do not run `cd` in Bash commands; use absolute paths, `git -C <dir>`, `pnpm --prefix <dir>`, or `cwd` in `Bun.spawn()`.
- Do not edit files with `sed -i`; use Edit tool for file writes; use `sed` only for non-writing stream transforms.
- Do not use `awk`; use `bun -e`, `sort -u`, `cut -d' ' -f1`, or git `--format`.
- Do not use `python`/`python3`; use `bun -e` or `jq`.
- Do not use `rm`/`rm -rf`; use `trash <path>` and guard missing paths with `[[ -e <path> ]] && trash <path>`.
- Do not edit files outside session sandbox. `~/.claude/hooks/` belongs to `mherod/.claude`; `~/.claude/skills/` belongs to `mherod/skills`. For cross-repo bugs discovered (e.g., argument parser, task completion verification), file GitHub issues in the owning repo with: (1) exact error message and reproduction steps, (2) root cause analysis, (3) proposed fix with code location, (4) success criteria. Example: `gh issue create --repo mherod/.claude --title "..." --body "..."`.
- **DO NOT mark tasks complete without shipping actual code changes.** Testing a concept inline (e.g., running a bash script to validate logic) does not count as implementation. Always: (1) modify actual source files, (2) verify `git diff` shows the code change, (3) commit the change, then (4) mark task complete. For cross-repo fixes where Edit tool is blocked by the session sandbox (e.g., `/push` skill in `mherod/skills`), file a GitHub issue on the owning repo with: file path, line number, exact fix needed (code snippet or regex replacement), and success criteria. Do not claim completion until the code is shipped in the actual repository.
- Use `swiz tasks complete <id> --evidence "note:..."` for task completion; `tasks-list.ts` is deprecated and must not be invoked directly.
- Stop-hook footers containing `REMINDER_FRAGMENT` can re-trigger memory enforcement. `pretooluse-update-memory-enforcement.ts` uses a 30-minute `CLAUDE.md` mtime cooldown; run `swiz install` after hook changes so installed config updates.
- Cross-session gap: cooldown does not carry between sessions; complete memory follow-through before session end.
- For cache-key fixes, search all callers (`Bun.hash(cwd)`, `createHash().update(repoRoot)`) and extract shared utility (for example `getCanonicalPathHash()` in `hook-utils.ts`) using `realpathSync()` and full hashes.
- Migrate all callers together; check `hooks/*.ts` and `src/commands/*.ts`. Example unified callers: `stop-personal-repo-issues.ts`, `pretooluse-push-cooldown.ts`, `src/commands/push-wait.ts`.
- Do not leave duplicated cache-key generation logic.
- In CLI subprocess tests (for example `runSwiz`), do not set `cwd: process.cwd()`; use absolute `indexPath = join(process.cwd(), "index.ts")`, temp-directory `cwd`, and `env: { ...process.env, HOME: tempDir }`.
- Do not use Agent tool `isolation: "worktree"`; rejected/partial setup can corrupt `.git/config` (`core.bare = true`, bogus `[branch "worktree-..."]`/`[user]`) and break git with "this operation must be run in a work tree".
- When creating test fixtures containing secret-like patterns (e.g., `sk_live_...` for testing `stop-secret-scanner.ts`), use array join or string concatenation to construct the pattern in source code: `const fakeSecret = ['s', 'k', '_', 'l', 'i', 'v', 'e', '_', ...].join('')`. This avoids GitHub push protection (which scans source code for patterns like `sk_live_`) while allowing git diffs to show the expanded pattern for hook detection. The secret scanner hook scans git diffs, not source code, so the expanded pattern in the diff will still trigger detection.
- **DO**: When stop hooks detect memory thresholds exceeded in files outside the session sandbox (e.g., global `~/.claude/CLAUDE.md` or ramp-frontend `MEMORY.md` while in swiz session), file GitHub issues on the owning repos (`mherod/.claude`, `mherod/ramp-frontend`) with word count, target threshold, and compaction guidance. Edit tool sandboxing prevents direct edits—issue filing is the correct workflow.
- **DON'T**: Attempt to edit files outside the session sandbox; the Edit tool will block and sandbox enforcement is non-negotiable.
- **DO**: After every commit, immediately run `git log origin/main..HEAD --oneline` to confirm no commits are unpushed before attempting to stop. Use `/push` skill to push unpushed commits.
- **DON'T**: Rely on `git status` alone for unpush detection—it doesn't show upstream divergence. Always use `git log origin/main..HEAD --oneline` to list unpushed commits.
- **DON'T**: Declare commit or push success before reading the actual tool output confirming it. Outcomes must be verified from evidence (git status clean, commit SHA captured, push output showing remote updated) before claiming the step complete.
