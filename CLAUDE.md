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

## Task Data

Tasks are stored per-session in `~/.claude/tasks/<session-id>/`. Each task is a JSON file named `<id>.json`. Audit logs go in `.audit-log.jsonl` within the session directory.

Session-to-project mapping is resolved by scanning `~/.claude/projects/` transcript files for `cwd` fields.

`swiz tasks complete <id>` requires `--evidence "text"` — the completion evidence is stored on the task and checked by the stop-completion-auditor hook.

**DO** keep at least one task in `pending` or `in_progress` status before running `git add` or `git commit`. The `pretooluse-require-tasks.ts` hook blocks `Edit`, `Write`, and `Bash` (including `git add`/`git commit`) when no incomplete task exists. Mark the commit task `completed` only after the commit succeeds.

**DON'T** create a task just for `git push` or `gh` commands — these are exempt from the task requirement. `git push`, `git pull`, `git fetch`, and all `gh` subcommands bypass the hook automatically.

**DO** commit all changes before attempting to stop the session. The `stop-git-status.sh` hook blocks stop when uncommitted changes exist. The correct end-of-task sequence is: edit → commit (with task in_progress) → push → mark task completed → stop.

## Push and CI

This is a personal solo repo (`mherod/swiz`). Push directly to `main` for all work — no pull request required.

**Pre-push checklist:**
1. `git log origin/main..HEAD --oneline` — review exactly which commits will be pushed before running push.
2. Branch/collaboration checks (**must run before `git push`**, not after):
   - `git branch --show-current` — confirm you're on the expected branch.
   - `gh pr list --state open --head $(git branch --show-current)` — check for an existing open PR; if one exists, the push updates it rather than requiring a new PR.
   - Confirm the repo is a solo personal project (no org, no other recent contributors, no open PRs) before pushing directly to `main`.
3. `git push origin main` — lefthook's `pre-push` hook runs `bun test` (full suite, ~1900 tests, ~44s). Push only succeeds once all tests pass.
4. `gh run list --limit 3 --branch main` — confirm a new CI run triggered for the commit.
5. `gh run watch <run-id> --exit-status` — wait for completion; fix any failures before stopping.

**Mandatory hooks — never bypass:**
- `lefthook pre-push` runs `bun test`. DON'T use `--no-verify` or any flag that skips it. Fix test failures first.
- CI workflow (`CI`) runs lint → typecheck → test. All three jobs must be green before the session can stop.

**DO** verify CI after every push with `gh run watch <run-id> --exit-status`. The stop hook will block until the push is confirmed green.

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
