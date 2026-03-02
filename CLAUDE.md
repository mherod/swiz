# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---
description: Swiz CLI project guidance — architecture, patterns, and conventions.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

## Runtime

Use Bun exclusively. DO NOT use Node.js, npm, pnpm, vite, or any Node-specific tooling.

- `bun <file>` to run scripts, `bun test` for tests, `bun install` for deps
- `bun run index.ts` or `bun --hot index.ts` to start the CLI locally
- `bun link` to make `swiz` available globally
- Bun loads `.env` automatically — DO NOT use dotenv

Prefer `Bun.file()` and `Bun.write()` for file I/O. Use `node:fs/promises` only for directory operations (`readdir`, `mkdir`, `stat`) where Bun has no equivalent.

## CLI Architecture

Entry point: `index.ts`. Commands are registered via `registerCommand()` from `src/cli.ts`.

Every command implements the `Command` interface from `src/types.ts`:

```ts
export interface Command {
  name: string;
  description: string;
  usage?: string;
  run(args: string[]): Promise<void> | void;
}
```

To add a new command:
1. Create `src/commands/<name>.ts` exporting a `Command`
2. Import and call `registerCommand()` in `index.ts`

DO NOT add routing or arg-parsing libraries. The CLI uses manual `process.argv` parsing — keep it lightweight.

## Project Root Resolution

Use `dirname(Bun.main)` to resolve the swiz project root at runtime. DO NOT use `join(dirname(Bun.main), "..")` — this breaks when running via `bun link` because `Bun.main` already points to the project root's `index.ts`.

## Hook System

Hooks live in `hooks/` at the project root. The authoritative manifest is the `manifest` array in `src/manifest.ts` — it is agent-agnostic and uses camelCase event names (`stop`, `preToolUse`, `postToolUse`, `sessionStart`, `userPromptSubmit`).

Translation to agent-specific formats happens at config generation time:
- **Event names**: `EVENT_MAP` maps canonical names to Claude Code (PascalCase) and Cursor (camelCase/custom) equivalents. `UserPromptSubmit` becomes `beforeSubmitPrompt` in Cursor.
- **Tool matchers**: `TOOL_ALIASES` translates tool names per agent. Claude uses `Bash`, Cursor uses `Shell`.
- **Config structure**: Claude Code uses nested matcher groups in `~/.claude/settings.json`. Cursor uses a flat hook list with `version: 1` in `~/.cursor/hooks.json`.

When adding a hook:
1. Add a `.ts` script to `hooks/`
2. Add the entry to `manifest` in `src/manifest.ts`
3. Run `swiz install --dry-run` to verify

DO NOT hard-code agent-specific event names or tool names in hook scripts. The translation layer handles this.

## Writing Hooks

**DO** update `README.md` whenever adding a hook to `src/manifest.ts`. The `src/readme-hook-counts.test.ts` test enforces three invariants that will fail at pre-push if not updated:
1. The `### <EventName> (N)` section heading count must match the number of table rows in that section.
2. The `**N hooks**` bold total in the README intro (line 7) must match `manifest.ts` total.
3. Every hook filename referenced in the README must exist on disk.

When adding a hook: (a) increment `### PreToolUse (N)` by 1, (b) add a table row for the new `.ts` file, (c) increment the `**N hooks**` intro count. Run `bun test src/readme-hook-counts.test.ts` locally to verify before pushing.

All hooks are TypeScript and import from `hooks/hook-utils.ts` for shared utilities. Hook scripts receive a JSON payload on stdin from the agent and exit `0` in all cases — the JSON output determines the decision, not the exit code.

**Output helpers** — emit polyglot JSON understood by all agents (Claude, Cursor, Gemini, Codex):
- `denyPreToolUse(reason)` — blocks the tool call (PreToolUse)
- `denyPostToolUse(reason)` — feeds an error back after tool execution (PostToolUse)
- `emitContext(eventName, context)` — injects non-blocking context (SessionStart, UserPromptSubmit)

All output helpers return `never` and call `process.exit(0)` after writing JSON. This is load-bearing: `dispatch.ts` reads a hook's entire stdout and calls `JSON.parse()` once on it. Any output after the JSON corrupts the parse silently. DO NOT write anything to stdout after calling any output helper.

**Stop hook helpers:**
- `blockStop(reason)` — emits block decision with ACTION REQUIRED footer and exits
- `blockStopRaw(reason)` — emits block decision without footer (caller controls full reason)
- `actionRequired()` — returns the standard ACTION REQUIRED footer string

**Git / CLI helpers:**
- `git(args, cwd)` — run git command, returns trimmed stdout or `""` on failure
- `gh(args, cwd)` — run gh CLI command, returns trimmed stdout or `""` on failure
- `ghJson(args, cwd)` — run gh command and parse JSON, returns `null` on failure or invalid JSON
- `getOpenPrForBranch(branch, cwd, jsonFields)` — returns the first open PR for a branch or `null`
- `isGitRepo(cwd)` / `isGitHubRemote(cwd)` / `hasGhCli()` — environment checks

**Skill existence checking** — hooks reference skills portably by checking if they're installed:
- `skillExists(name)` — checks `.skills/` and `~/.claude/skills/` for `SKILL.md` (cached per process)
- `skillAdvice(skill, withSkill, withoutSkill)` — returns skill-aware message if the skill exists, or a fallback with manual CLI commands if it doesn't

**Cross-agent tool checks** — use these instead of hardcoding `"Bash"` or `"Edit"`:
- `isShellTool(name)` — matches `Bash`, `Shell`, `run_shell_command`, etc.
- `isEditTool(name)` — matches `Edit`, `StrReplace`, `replace`, `apply_patch`
- `isFileEditTool(name)` — edit or write tools
- `isCodeChangeTool(name)` — edit, write, or notebook tools
- `isTaskTool(name)` / `isTaskCreateTool(name)` — task management tools

**Package manager detection** — `detectPackageManager()` walks up from CWD to find the lockfile; `detectPkgRunner()` returns the appropriate `bunx`/`npx`/`pnpm dlx` command.

**Input types** — `StopHookInput`, `ToolHookInput`, `SessionHookInput` for typed stdin parsing.

**Test file detection** — `TEST_FILE_RE` from `hook-utils.ts` identifies test files (`.test.ts`, `.spec.ts`, `__tests__/`, `/test/`). Use this constant in hooks that scan source code to exclude test files from checks, allowing test fixtures to contain literal patterns without triggering the hook.

**Diff file tracking** — When scanning git diffs line-by-line, track the current file by reading `+++ b/<path>` headers, then apply file-level exclusions (e.g., `if (TEST_FILE_RE.test(currentFile)) continue`). This pattern is lighter than splitting the diff into file chunks and allows consistent file-based filtering across all checked lines.

**DO** extract a `sanitizeSessionId(sessionId: string | undefined): string | null` helper whenever a hook uses `/tmp` sentinel files keyed on session ID. Both the read path (cooldown check) and write path (mark prompted) need the same sanitization — extracting it eliminates duplication and prevents divergence between the two paths.

**DON'T** use `/tmp` sentinel files with hardcoded session IDs in tests. Sentinel files outlive test runs; on re-run the file exists from the prior run, causing cooldown logic to fire when it shouldn't. Use unique session IDs per test (e.g. appending `Date.now()`) or check the sentinel's own `mtime` against the cooldown window rather than just its existence.

**DO** use a two-stage filter when detecting background processes with `pgrep` in hooks. A bare `pgrep -f 'git push'` produces false positives in two distinct ways: (1) it matches the parent `git push` process when the hook is invoked from inside a pre-push test run, and (2) it matches unrelated pushes in other repositories open in other terminals. Apply both filters:
- **Ancestry filter**: walk `process.ppid` upward via `ps -p <pid> -o ppid=` to build a `Set<number>` of ancestors; exclude any pgrep PIDs that appear in the set.
- **Repo-scope filter**: for each remaining (non-ancestor) PID, use `lsof -p <pid> -d cwd -Fn` to get the process CWD; only treat it as in-flight if its CWD starts with the current repo's git root (`git rev-parse --show-toplevel`).

See `hooks/stop-git-status.ts` for the reference implementation of this pattern.

**DO** import `projectKeyFromCwd` from `src/transcript-utils.ts` when any hook needs to locate a project directory under `~/.claude/projects/`. The canonical encoding replaces **both** `/` and `.` with `-` (`cwd.replace(/[/.]/g, "-")`). DON'T reimplement it locally — a slash-only variant (`/\//g`) silently misses dots in paths like `/Users/jane.doe/...`, causing memory reads/writes to fail without any error.

**DO** implement workflow-enforcement hooks by scanning `transcript_path` for both the triggering reminder and the completion evidence, not by adding separate state files or in-memory flags. `pretooluse-update-memory-enforcement.ts` is the pattern: after a hook tells the agent to use `/update-memory`, the follow-up gate must verify the transcript shows a read of `update-memory/SKILL.md` and a write to a `.md` file such as `CLAUDE.md` before unblocking normal work. The reminder itself must also include the triggering cause (for example, the ignored user instruction or the specific blocked workflow violation) so the recorded DO/DON'T rule preserves why the enforcement fired.

## Task Data

Tasks are stored per-session in `~/.claude/tasks/<session-id>/`. Each task is a JSON file named `<id>.json`. Audit logs go in `.audit-log.jsonl` within the session directory.

Session-to-project mapping is resolved by scanning `~/.claude/projects/` transcript files for `cwd` fields.

`swiz tasks complete <id>` requires `--evidence "text"` — the completion evidence is stored on the task and checked by the stop-completion-auditor hook.

**DO** keep at least one task in `pending` or `in_progress` status before running `git add` or `git commit`. The `pretooluse-require-tasks.ts` hook blocks `Edit`, `Write`, and `Bash` (including `git add`/`git commit`) when no incomplete task exists. Mark the commit task `completed` only after the commit succeeds.

**DO** call a task tool (TaskUpdate, TaskCreate, TaskList, or TaskGet) at least every 15 tool calls. The staleness gate fires after 20 consecutive tool calls with no task tool interaction — staying under 15 provides a safe buffer. When the staleness gate fires mid-task, call `TaskUpdate` on the active task with current progress notes; if that doesn't unblock, call `TaskCreate` for the next concrete step.

**DO** create a task before any session that will involve Bash commands beyond the read-only exemptions. The hook exempts: `ls`, `rg`, `grep` (always); git read-only subcommands (`log`, `status`, `diff`, `show`, `branch`, `remote`, `rev-parse`, etc.) when no write subcommand is present; `git push/pull/fetch`; all `gh` commands; and `swiz issue close/comment`. `find` is NOT exempt — use `rg` or Glob tool for file discovery instead.

**DON'T** create a task just for `git push`, `gh`, or `swiz issue close/comment` — these are exempt from the task requirement. `git push`, `git pull`, `git fetch`, all `gh` subcommands, and `swiz issue close/comment` bypass the hook automatically. The exemption for `swiz issue` is defined by `SWIZ_ISSUE_RE` in `hook-utils.ts` and is wired into the exemption block in `pretooluse-require-tasks.ts` alongside `GH_CMD_RE`.

**DO** commit all changes before attempting to stop the session. The `stop-git-status.sh` hook blocks stop when uncommitted changes exist. The correct end-of-task sequence is: edit → commit (task still in_progress) → mark task completed → push → CI watch → `gh run view --json` → announce result → stop.

**DO** run `git diff` before `git add` and output the result explicitly — do not skip straight to staging and rely on hooks or CI to catch logic errors. The staged-diff review is the final pre-commit sanity check and must be visible in the conversation so the agent can verify the exact changed logic before committing. After multiple edits to the same file, piecemeal edits can produce incoherent or contradictory content when combined; only the diff reveals this. Pattern: `git diff <files>` → inspect output → `git add <files>` → `git commit`.

**DO** check for conflicts with existing nearby guidance before adding new rules to CLAUDE.md. Read the surrounding paragraphs and search for related DO/DON'T blocks before writing. Adding a rule that contradicts an existing one causes silent policy drift — both rules will be followed inconsistently.

## Standard Work Sequence

Follow this order for every unit of work. Deviating from it causes hook blocks.

```
1. TaskCreate / TaskUpdate → in_progress   (required before any Edit/Bash)
2. Edit / Bash                              (implementation)
3. git add + git commit                     (hooks: lint, typecheck; task still in_progress)
4. TaskUpdate → completed                   (after commit succeeds, before push)
5. SHA=$(git rev-parse HEAD)                (capture SHA before push)
6. git log origin/main..HEAD --oneline      (review commits)
7. git push origin main                     (hook: bun test full suite; push/gh exempt from task req)
8. swiz ci-wait $SHA --timeout 300          (poll CI run for completion with timeout)
9. Verify CI passed (exit code 0); if failed, fix and re-push
10. Announce result — done.
```

**Enforcement summary:**
- Steps 1–3 require an in_progress task (hook blocks otherwise)
- Step 4 must happen after commit and before push (no TaskUpdate at steps 7–10)
- Capture SHA (step 5) before push so step 8 can filter by exact commit
- Step 8 uses `swiz ci-wait` for timeout-based polling (replaces manual gh run watch/view)
- **DO NOT** use fixed sleeps or manual polling — use `swiz ci-wait` instead
- No TaskUpdate/TaskList calls at steps 7–10
- **DON'T stop or declare work done after step 3 alone** — a commit without a push is incomplete work. The stop hook blocks every stop attempt until origin is up to date. Always complete steps 5–10 before stopping.
- **DO** treat push as inseparable from commit — after any `/commit` skill or manual `git commit`, immediately continue with steps 5–10 (capture SHA → log review → push → CI wait → verify exit code). The stop hook will block every stop attempt until `origin/main` is up to date.

## Push and CI

This is a personal solo repo (`mherod/swiz`). Push directly to `main` for all work — no pull request required.

**Pre-push checklist:**
1. `git log origin/main..HEAD --oneline` — review exactly which commits will be pushed before running push.
2. Branch/collaboration checks (**must run before `git push`**, not after):
   - `git branch --show-current` — confirm you're on the expected branch.
   - `gh pr list --state open --head $(git branch --show-current)` — check for an existing open PR; if one exists, the push updates it rather than requiring a new PR.
   - Confirm the repo is a solo personal project (no org, no other recent contributors, no open PRs) before pushing directly to `main`.
3. `SHA=$(git rev-parse HEAD)` — capture the commit SHA before pushing.
4. `git push origin main` — lefthook's `pre-push` hook runs `bun test` (full suite, ~1900 tests, ~44s). Push only succeeds once all tests pass.
5. `gh run list --commit $SHA --json databaseId --jq '.[0].databaseId'` — get the run ID for the exact pushed SHA. Do NOT use `--limit 1 --branch main` — that returns the latest run which may be stale.
6. `gh run watch <run-id> --exit-status` — wait for completion; fix any failures before stopping.
7. `gh run view <run-id> --json conclusion,status,jobs --jq '{conclusion,status,jobs:[.jobs[]|{name,conclusion,status}]}'` — fetch the explicit conclusion and per-job statuses; only announce success when `conclusion` is `"success"` and every job shows `"success"`.

**Mandatory hooks — never bypass:**
- `lefthook pre-push` runs `bun test`. DON'T use `--no-verify` or any flag that skips it. Fix test failures first.
- CI workflow (`CI`) runs lint → typecheck → test. All three jobs must be green before the session can stop.

**DO** verify CI after every push with `gh run view --json conclusion,status,jobs` and confirm `conclusion === "success"` before announcing completion. `gh run watch` output alone is not sufficient — always follow up with the explicit JSON fetch tied to the same SHA captured before push (`SHA=$(git rev-parse HEAD)`).

**DO** use token-based parsing (not regex) when writing hooks that must distinguish `git push --force` (force flag) from `git push -- --force` (refspec after end-of-flags sentinel). Regex cannot correctly handle the `--` sentinel, git global options like `-C <path>`, or flags in arbitrary operand positions. Export the parser from `hook-utils.ts` so it can be unit-tested independently without triggering stdin reads from the hook file itself.

**DON'T** call TaskUpdate or TaskList during or after the push+CI verification sequence. Mark tasks completed *after commit but before push* so the push+CI loop is purely mechanical: push → watch → `gh run view --json` → announce. Any TaskUpdate call after `git push` is a sign the task ordering is wrong — fix it by completing tasks at step 4 of the Standard Work Sequence.

**DON'T** stop the session after committing without pushing. A local commit that hasn't reached `origin/main` is incomplete work — the stop hook blocks until `git push` succeeds and CI is verified. Every commit must be followed by steps 5–11 of the Standard Work Sequence before the session ends.

**DON'T** skip `git log origin/main..HEAD --oneline` before pushing — it prevents accidentally pushing incomplete or unintended commits.

**DON'T** run branch/collaboration/open-PR checks after `git push` — they must run before. Post-hoc checks provide no safety benefit.

**DON'T** add `Co-Authored-By: Claude` or any AI attribution trailer to commit messages — commits must be indistinguishable from human-authored work. This applies to all commits and PR descriptions without exception.

**DON'T** use destructive git commands: `git revert`, `git restore`, `git stash`, `git reset --hard`, `git checkout -- <file>`. These discard or risk losing uncommitted work. If changes are accidentally lost, use `git reflog` to recover before doing anything else.

## CLI Error Handling

Commands in `src/commands/` must throw errors instead of calling `process.exit(1)`. `process.exit` terminates the process immediately, bypassing `finally` blocks and dropping any pending async work.

```ts
// DO
throw new Error("No session found. Use --all-projects to see all.");

// DON'T
console.error("No session found.");
process.exit(1);
```

The top-level handler in `src/cli.ts` catches thrown errors and sets `process.exitCode = 1`, letting the event loop drain naturally. The pass-through in `src/commands/continue.ts` uses `process.exitCode = proc.exitCode ?? 0; return` for the same reason.

Hook scripts (`hooks/*.ts`) are the exception — their `process.exit(0)` calls are intentional and must stay.

## Conventions

- ANSI escape codes for terminal output — no chalk or color libraries
- Prefer `Bun.spawn(["sh", "-c", cmd])` for shell execution in skills/hooks
- All hooks are `.ts` and invoked with `bun hooks/<file>.ts`
- All settings file writes create a `.bak` backup first
- **Multiline regex with `\s*`**: DO NOT use `\s*` after a closing delimiter like `---` if you need to preserve blank lines. Use `[ \t]*` instead to match only horizontal whitespace. The pattern `/^---[\s\S]*?^---\s*\n?/m` greedily consumes newlines after the closing `---`, eating blank lines that should remain. Change to `[ \t]*\n?` to avoid this.
- **Stop hook session context**: Hooks like `stop-auto-continue.ts` can load session task context from `~/.claude/tasks/<session_id>/` and inject it into agent prompts. This gives the agent a longer-term view of session accomplishments beyond just the transcript. Load task files, format by status (IN PROGRESS before COMPLETED), and inject as a dedicated section before the transcript.
- **Stop-hook memory prompts**: When `hooks/stop-auto-continue.ts` tells the model to suggest `/update-memory` or a direct `CLAUDE.md`/`MEMORY.md` update, require the prompt text to include `Cause to capture: <specific cause>` and name the exact ignored instruction, blocked workflow gap, or failure mode. Do not leave memory-capture follow-ups generic.
- **Memory enforcement gate — comply immediately**: When `hooks/pretooluse-update-memory-enforcement.ts` blocks Bash or Edit with "MEMORY CAPTURE ENFORCEMENT", stop all other work and comply in this exact order: (1) Read `/update-memory/SKILL.md` directly via the Read tool, (2) write the DO/DON'T rule into `CLAUDE.md` via the Edit tool. Do not read other files, investigate the hook source, or continue the current task first. The gate clears only once the transcript shows both a Read of the skill file and an Edit/Write to a `.md` file after the original block message.
- **DON'T enforce task or memory workflow rules outside git repos**: `pretooluse-require-tasks.ts` and `pretooluse-update-memory-enforcement.ts` must both skip enforcement when `cwd` is not inside a git repository OR when no `CLAUDE.md` file exists anywhere in the `cwd` directory tree. Enforcement in non-project directories (e.g., `~`) causes an unrecoverable deadlock: the unlock steps require skills and markdown writes that themselves fail without git context. The guard pattern: check `isGitRepo(cwd)` first, then walk up from `cwd` to the filesystem root looking for `CLAUDE.md` — if neither condition is met, `process.exit(0)` immediately.
- **Bun test reporter flag**: Always use `--reporter=dots` (not `--reporter=dot`). Bun only supports `dots` and `junit` — `dot` is invalid and blocked by the reporter-normalization hook.
- **DON'T use `cd` in Bash commands.** A PreToolUse hook blocks every `cd` invocation. Use absolute paths, `git -C <dir> <cmd>`, or `pnpm --prefix <dir> <cmd>` instead. To run a hook script from a specific working directory, pass `cwd` to `Bun.spawn()` or construct the command with absolute paths inline: `echo '...' | bun /abs/path/to/hook.ts`.
- **Stop hook advice footers re-trigger memory enforcement**: The stop-git-status, stop-auto-continue, pretooluse-push-checks-gate, and similar hooks append a memory-advice footer containing the REMINDER_FRAGMENT. Each time one of these fires, it creates a new enforcement trigger. Mitigation: `pretooluse-update-memory-enforcement.ts` has a 30-minute CLAUDE.md mtime cooldown — if any CLAUDE.md in the project tree was written within 30 minutes, the gate is skipped. After modifying the hook, run `swiz install` to update the installed version in `~/.claude/settings.json`. **Cross-session gap**: The cooldown resets when a session ends. If the previous session ended with a pending REMINDER_FRAGMENT trigger (e.g., the follow-through CLAUDE.md edit happened near the end of the session), the next session starts with an expired cooldown and the gate fires again immediately. DON'T defer the memory follow-through — complete it before doing any other substantive work so it is within the 30-minute window and the trigger is fully satisfied before the session ends.
