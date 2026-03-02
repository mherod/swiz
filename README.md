# swiz

AI coding agents are capable of impressive things. They're also capable of forgetting to commit, shipping debug statements, ignoring failing CI, losing track of what they were supposed to do, and declaring "task complete" the moment they want to stop. **swiz** is a hook framework that doesn't let them get away with any of it.

One manifest of TypeScript hook scripts gets installed across Claude Code, Cursor, Gemini CLI, and Codex CLI — translating tool names, event names, and config formats automatically so every agent plays by the same rules. The hooks enforce discipline at every stage of the agent loop: before tools run, after they complete, and before the session is allowed to stop.

**49 hooks. 5 event types. Every agent. Zero compromises.**

## Install

```bash
bun install
bun link
```

Then use `swiz` from anywhere.

## How It Works

Every agent exposes hook events at key moments in the loop. swiz intercepts those moments:

```
User prompt submitted  →  userpromptsubmit-* hooks inject context (git state, active tasks)
                                        ↓
Agent calls a tool     →  pretooluse-* hooks can block the call before it executes
                                        ↓
Tool completes         →  posttooluse-* hooks validate results, remind about tests
                                        ↓
Agent tries to stop    →  stop-* hooks audit the full session state and block if anything is unresolved
```

Hooks communicate back using **polyglot JSON** — a single output format that all four agents understand. A hook script written once works identically whether it was triggered by Claude, Cursor, Gemini, or Codex.

```json
{
  "decision": "block",
  "reason": "Uncommitted changes detected: 2 modified (3 file(s))...",
  "hookSpecificOutput": { "permissionDecision": "deny" }
}
```

## The Agent Ecosystem

swiz supports every agent that has a hook system, with automatic translation of tool names and event names from a single canonical manifest:

| Agent | Config Path | Status |
|-------|------------|--------|
| Claude Code | `~/.claude/settings.json` | Full support — nested matcher groups, all 5 event types |
| Cursor IDE | `~/.cursor/hooks.json` | Full support — flat list (`version: 1`), all events |
| Cursor CLI | `~/.cursor/hooks.json` | Limited — only `beforeShellExecution`/`afterShellExecution` fire ([tracking issue](https://forum.cursor.com/t/cursor-cli-doesnt-send-all-events-defined-in-hooks/148316)). Use `swiz shim` as workaround. |
| Gemini CLI | `~/.gemini/settings.json` | Full support — nested matcher groups, all 5 event types |
| Codex CLI | `~/.codex/config.toml` | Tool mappings tracked, ready when user-configurable hooks ship |

### Cross-Agent Translation

The canonical manifest uses neutral names. At install time, `agents.ts` translates everything per-agent so hook scripts never need to know which agent ran them:

**Tool Names**

| Concept | Claude Code | Cursor | Gemini CLI | Codex CLI |
|---------|------------|--------|------------|-----------|
| Shell | `Bash` | `Shell` | `run_shell_command` | `shell_command` / `exec_command` |
| Edit | `Edit` | `StrReplace` | `replace` | `apply_patch` |
| Write | `Write` | `Write` | `write_file` | `apply_patch` |
| Read | `Read` | `Read` | `read_file` | `read_file` |
| Grep | `Grep` | `Grep` | `grep_search` | `grep_files` |
| Glob | `Glob` | `Glob` | `glob` | `list_dir` |
| Notebook | `NotebookEdit` | `EditNotebook` | — | `apply_patch` |
| Tasks | `TaskCreate` | `TodoWrite` | `write_todos` | `spawn_agent` |

**Event Names**

| Event | Claude Code | Cursor | Gemini CLI | Codex CLI |
|-------|------------|--------|------------|-----------|
| Before tool use | `PreToolUse` | `preToolUse` | `BeforeTool` | — (planned) |
| After tool use | `PostToolUse` | `postToolUse` | `AfterTool` | `AfterToolUse` |
| Stop / completion | `Stop` | `stop` | `AfterAgent` | `AfterAgent` |
| Session start | `SessionStart` | `sessionStart` | `SessionStart` | — |
| User prompt | `UserPromptSubmit` | `beforeSubmitPrompt` | `BeforeAgent` | — |

Hook scripts use equivalence sets from `hook-utils.ts` (`isShellTool("run_shell_command")` returns `true`) so they work regardless of which agent's name lands in the payload.

## Bundled Hooks

43 hook scripts across 5 event types. All TypeScript. All sharing utilities from `hooks/hook-utils.ts`.

### Stop (14)

Stop hooks run before the agent is allowed to end a session. They're the last line of defense — and the most powerful. A blocking stop hook keeps the agent working until the problem is resolved.

| Hook | What it does |
|------|-------------|
| `stop-secret-scanner.ts` | Scans staged diffs for API keys, tokens, and credentials. Blocks stop if any are found — because secrets in git history are permanent. |
| `stop-debug-statements.ts` | Catches `console.log`, `debugger`, and other debug artifacts left in source files. Excludes infrastructure files that legitimately reference these patterns. |
| `stop-large-files.ts` | Blocks stop if any uncommitted file exceeds the size threshold — preventing accidental binary or generated-file commits. |
| `stop-git-status.ts` | Unified git workflow enforcer. If there are uncommitted changes, unpushed commits, or the branch is behind remote, it blocks with a numbered action plan: commit → pull → push. One hook, full workflow. |
| `stop-lockfile-drift.ts` | Detects when `package.json` has been modified but the lockfile hasn't been updated. Agents forget to run `bun install` — this doesn't let them forget. |
| `stop-lint-staged.ts` | Runs lint-staged on the current working tree before allowing stop. Catches lint and format issues that would block CI. |
| `stop-branch-conflicts.ts` | Checks for potential merge conflicts with the base branch before the session ends, while there's still time to resolve them cleanly. |
| `stop-pr-description.ts` | Validates that open PRs have a real description, not an empty template. Forces the agent to document what it built. |
| `stop-pr-changes-requested.ts` | Blocks stop if the current PR has unresolved change requests from reviewers. The agent doesn't get to declare done while reviewers are waiting. |
| `stop-github-ci.ts` | Blocks stop if GitHub Actions CI is still running or has failed on the current branch. No shipping broken code. |
| `stop-todo-tracker.ts` | Scans git diffs for newly introduced `TODO`, `FIXME`, or `HACK` comments. Technical debt accumulates fast — this keeps the bar high. |
| `stop-completion-auditor.ts` | Reads task files and verifies that every task has actual completion evidence before the session ends. Agents can't just mark things done — they have to prove it. |
| `stop-personal-repo-issues.ts` | Checks for actionable open GitHub issues, skipping those labelled `blocked`, `upstream`, `wontfix`, `duplicate`, `on-hold`, or `waiting`. Surfaces real work that's been left on the table. |
| `stop-auto-continue.ts` | Blocks stop with an AI-generated "what should you do next?" suggestion. Instead of ending, the agent gets a concrete next step. Combined with `swiz continue`, this creates an autonomous work loop. |

### PreToolUse (21)

PreToolUse hooks intercept tool calls *before* they execute. A blocking hook here prevents the action entirely — the agent has to find another way.

| Hook | What it does |
|------|-------------|
| `pretooluse-banned-commands.ts` | Blocks `grep` (use `rg`), `sed`/`awk` (use Edit), `rm` (use trash), `cd`, and raw `python`. Redirects to safer, more auditable alternatives. |
| `pretooluse-no-npm.ts` | Intercepts `npm` and `yarn` commands and redirects to the project's actual package manager. No more lock file corruption from the wrong tool. |
| `pretooluse-long-sleep.ts` | Blocks `sleep` commands over a threshold. Agents shouldn't be waiting in loops — if they are, something is wrong. |
| `pretooluse-no-as-any.ts` | Blocks code edits that introduce `as any` type assertions. TypeScript exists for a reason. |
| `pretooluse-no-eslint-disable.ts` | Blocks edits that add `eslint-disable` comments. The linter is authority — the agent must fix the underlying issue, not silence it. |
| `pretooluse-no-ts-ignore.ts` | Blocks `@ts-ignore`, `@ts-expect-error`, and `@ts-nocheck` comments in TypeScript files. The type checker is not optional. |
| `pretooluse-eslint-config-strength.ts` | Prevents weakening ESLint configs — rules can only be added or escalated, never removed or downgraded. Enforces a quality ratchet. |
| `pretooluse-json-validation.ts` | Validates JSON syntax before any write to a `.json` file. Catches malformed JSON before it breaks the project. |
| `pretooluse-no-direct-deps.ts` | Blocks direct edits to dependency blocks in `package.json`. Dependencies must go through the package manager, not hand-edited. |
| `pretooluse-update-memory-enforcement.ts` | If a prior hook explicitly told the agent to record an `/update-memory` DO/DON'T rule, blocks normal work until the agent reads that skill and writes the rule into a markdown file. |
| `pretooluse-require-tasks.ts` | Blocks Edit, Write, and Shell tools unless the agent has active tasks. No more undisciplined free-form editing — work must be tracked. |
| `pretooluse-no-task-delegation.ts` | Prevents agents from creating sub-tasks to delegate work instead of doing it. Task creation is for tracking, not avoidance. |
| `pretooluse-task-subject-validation.ts` | Validates task subjects meet quality standards before they're created — no vague "fix stuff" tasks. |
| `pretooluse-commit-checks-gate.ts` | Blocks `git commit` unless a branch check (`git branch --show-current`) has already been run in the current session. Prevents committing to the wrong branch without first verifying context. |
| `pretooluse-push-checks-gate.ts` | Blocks `git push` unless branch and open-PR checks have already been run in the current session. Prevents pushing without verifying context and avoiding duplicate PRs. |
| `pretooluse-push-cooldown.ts` | Enforces a 60-second cooldown between `git push` commands for the same repository. Prevents accidental rapid-fire pushes. Bypass with `--force`, `--force-with-lease`, `--force-with-lease=<ref>`, `--force-if-includes`, or `-f`. |
| `pretooluse-main-branch-scope-gate.ts` | Enforces scope-based push policy for main branch: trivial changes (≤3 files, ≤20 lines, docs-only) can push to main in solo repos; non-trivial work (features, refactors, multi-file changes) in collaborative repos must use feature branch + PR. Blocks push with actionable guidance. |
| `pretooluse-skill-invocation-gate.ts` | Blocks `git commit` and `git push` unless the corresponding `/commit` or `/push` skill has been invoked in the current session. Only enforced when the skill is installed on the machine. |
| `pretooluse-no-push-when-instructed.ts` | Blocks `git push` when the transcript contains an explicit "do not push" instruction (e.g. from the `/commit` skill) without a subsequent push-approval signal. Push requires explicit user authorisation. |
| `pretooluse-task-recovery.ts` | Before TaskUpdate or TaskGet, checks whether the referenced task ID exists on disk. If it's missing (lost during context compaction), creates a stub file so the tool call succeeds transparently — the agent never sees "Task not found". |
| `pretooluse-sandboxed-edits.ts` | Blocks Edit, Write, and NotebookEdit calls targeting paths outside the session's working directory and temporary directories. Enabled by default; disable with `swiz settings disable sandboxed-edits`. |

### PostToolUse (10)

PostToolUse hooks run after a tool completes. They can feed error context back to the agent or inject advisory information.

| Hook | What it does |
|------|-------------|
| `posttooluse-git-status.ts` | Injects current git status context after every tool use. The agent always knows what state the working tree is in. |
| `posttooluse-git-task-autocomplete.ts` | After a successful `git commit` or `git push`, automatically marks any matching "Commit" or "Push" tasks as completed. After a push, reminds the agent to create a CI-wait task. |
| `posttooluse-json-validation.ts` | Re-validates JSON files after any edit or write. Catches any JSON that got corrupted during a tool call. |
| `posttooluse-test-pairing.ts` | Detects when source files were edited without corresponding test updates and reminds the agent. Tests aren't optional. |
| `posttooluse-task-advisor.ts` | Issues a countdown warning as the agent approaches the task enforcement threshold — before it gets blocked. |
| `posttooluse-pr-context.ts` | Injects PR context (description, review status, CI state) when the agent checks out a branch. Instant situational awareness. |
| `posttooluse-prettier-ts.ts` | Auto-formats TypeScript files after edits. Runs async so it never slows the agent down. |
| `posttooluse-task-subject-validation.ts` | Validates task subjects after creation, catching issues that the pre-creation hook might have missed. |
| `posttooluse-task-recovery.ts` | After a TaskUpdate or TaskGet, re-checks the session task list and recovers any tasks that were lost during context compaction. |
| `posttooluse-task-output.ts` | Parses TaskOutput results: blocks on non-zero exits with actionable error context; on successful git push, injects the CI run ID and watch commands so the agent can verify CI without extra plumbing. |

### SessionStart (2)

| Hook | What it does |
|------|-------------|
| `sessionstart-health-snapshot.ts` | Captures a baseline of project health (lint state, test state, git state) at session start so the agent knows what it's walking into. |
| `sessionstart-compact-context.ts` | Re-injects core project conventions after context compaction events. The agent keeps its bearings even in long sessions. |

### UserPromptSubmit (2)

| Hook | What it does |
|------|-------------|
| `userpromptsubmit-git-context.ts` | Injects current git branch and status into every prompt. The agent always knows where it is in the repo. |
| `userpromptsubmit-task-advisor.ts` | Surfaces active tasks before each prompt so the agent stays focused on what it was supposed to be doing. |

## Plugin Marketplace

swiz ships a Claude Code plugin with a marketplace catalog:

```bash
# Install from the public marketplace
/plugin marketplace add mherod/swiz
/plugin install swiz-core@swiz-marketplace

# Or test locally during development
/plugin marketplace add .
/plugin install swiz-core@swiz-marketplace
```

The `swiz-core` plugin provides:

- **Command**: `install` — runs `swiz install` with optional flags
- **Skills**: `swiz-skill`, `swiz-hooks`, `swiz-install`, `swiz-uninstall`, `swiz-status`, `swiz-settings`, `swiz-tasks`, `swiz-shim`, `swiz-dispatch`, `swiz-transcript`, `swiz-continue`, `swiz-cleanup`, `swiz-session`
- **Skills**: `enable-auto-continue`, `disable-auto-continue` — toggle the autonomous work loop per-session or globally

## Commands

### `swiz install`

Deploy all 44 hooks to agent settings from the canonical manifest. **Merge-based** — swiz hooks are added alongside your existing hooks, never replacing them.

```bash
swiz install              # all agents with configurable hooks
swiz install --claude     # Claude Code only
swiz install --cursor     # Cursor only
swiz install --gemini     # Gemini CLI only
swiz install --codex      # shows Codex status (not yet configurable)
swiz install --dry-run    # line-by-line unified diff, no writes
```

- **Merge, not replace** — user-defined hooks (sound effects, agent hooks, inline scripts, etc.) are preserved. Only swiz-managed hooks are touched.
- **Legacy replacement** — if you previously had hooks at `~/.claude/hooks/`, swiz detects and replaces them with the portable versions from the swiz project.
- **Idempotent** — running install twice produces the same result. Old swiz hooks are stripped before new ones are added.
- Dry run shows an LCS-based unified diff of exactly what would change, plus counts of hooks added/replaced/preserved.
- Creates a `.bak` backup before writing.
- If a running agent process (e.g. Claude Code) reverts the write within 1.5s, swiz detects and warns you to close sessions first.

### `swiz uninstall`

Remove only swiz-managed hooks from agent settings while preserving any user-defined hooks.

```bash
swiz uninstall              # all agents
swiz uninstall --cursor     # Cursor only
swiz uninstall --dry-run    # preview removals
```

### `swiz status`

Show installation state for every agent — binary location, settings file, hook counts (swiz vs other), and active event names.

```bash
swiz status
```

### `swiz settings [show | enable | disable]`

View and modify global swiz behavior flags stored at `~/.swiz/settings.json`.

```bash
swiz settings                         # show effective settings
swiz settings disable auto-continue  # disable stop auto-continue blocker
swiz settings enable auto-continue   # re-enable it
swiz settings show --session --dir <path>                    # show effective setting for latest session in dir
swiz settings disable auto-continue --session --dir <path>   # set override for latest session in dir
swiz settings enable auto-continue --session <id> --dir <path> # set override for matching session
```

Session overrides are keyed by session ID. If no override exists, that session inherits the global setting.

### `swiz hooks [event] [script]`

Inspect hook configurations across all agents.

```bash
swiz hooks                         # list all events from all agents
swiz hooks Stop                    # show hooks registered for Stop
swiz hooks Stop secret-scanner     # print the full source of a hook script
```

### `swiz skill [name]`

Read and expand skill definitions used by Claude Code, Codex, and other AI agents.

```bash
swiz skill              # list all available skills
swiz skill commit       # print skill with inline commands expanded
swiz skill --raw commit # raw SKILL.md without expansion
```

Skills are discovered from `.skills/` (project-local) and `~/.claude/skills/` (global). The `` !`command` `` inline syntax is expanded by default — shell commands inside skill content are executed and their output is inlined.

### `swiz shim`

Shell-level command interception that works with **any** agent — no hook event support required. Installs wrapper functions into your shell profile that intercept commands like `grep`, `npm`, `sed`, `node`, and `rm` before they execute.

```bash
swiz shim                 # show installation status
swiz shim install         # add to ~/.zshenv (default for zsh)
swiz shim install .zshrc  # add to ~/.zshrc instead
swiz shim install --dry-run
swiz shim uninstall       # remove from all profiles
```

**How it works:**

- In **non-interactive shells** (agent context): commands are **blocked** with a clear error message explaining the correct alternative. The agent sees exit code 1 and adapts.
- In **interactive shells** (human typing): a yellow **warning** is printed but the command proceeds normally.
- **Bypass**: `SWIZ_BYPASS=1 grep ...` or `command grep ...` to skip the shim.
- **Force strict mode**: `SWIZ_SHIM=strict` to block even in interactive shells.

Shimmed commands: `grep`, `egrep`, `fgrep`, `find`, `sed`, `awk`, `npm`, `npx`, `yarn`, `pnpm`, `node`, `ts-node`, `python`, `python3`, `rm`.

This is the primary workaround for **Cursor CLI**, where only `beforeShellExecution`/`afterShellExecution` events fire — the shim catches everything else at the shell layer.

### `swiz continue`

Resume the most recent Claude Code session with an AI-generated next step. Reads the session transcript, asks an AI backend "what should the assistant do next?", then launches `claude --continue "<suggestion>"` so the agent picks up immediately.

```bash
swiz continue             # generate suggestion and resume most recent session
swiz continue --print     # dry run — print the suggestion without resuming
swiz continue --session <id>  # resume a specific session (by ID prefix)
```

Uses the same AI backend detection as `stop-auto-continue` (`agent` → `claude` → `gemini`). Exits gracefully if no backend is available.

**The autonomous loop**: `stop-auto-continue` blocks the agent from stopping, injecting an AI-generated next step suggestion → user runs `swiz continue` → session resumes with that suggestion as the opening prompt → agent works → loop repeats. The agent keeps going until the work is actually done.

### `swiz tasks [subcommand]`

Session-scoped task management with audit logging.

```bash
swiz tasks                                  # list tasks for current project
swiz tasks --all-projects                   # list across all projects
swiz tasks create "subject" "description"   # create a task
swiz tasks complete <id> --evidence "text"  # complete with evidence (required)
swiz tasks status <id> in_progress          # update status
swiz tasks complete-all                     # bulk-complete remaining
```

## Architecture

```
swiz/
├── index.ts                  # CLI entry point
├── src/
│   ├── cli.ts                # Command registration and dispatch
│   ├── types.ts              # Command interface
│   ├── manifest.ts           # Canonical hook manifest (events, matchers, scripts)
│   ├── agents.ts             # Agent definitions, tool/event translation
│   ├── agent.ts              # AI backend detection and prompting (agent/claude/gemini)
│   └── commands/
│       ├── install.ts        # Deploy hooks with per-agent config generation
│       ├── uninstall.ts      # Remove swiz hooks, preserve others
│       ├── status.ts         # Installation state overview
│       ├── hooks.ts          # Inspect hook configs across agents
│       ├── skill.ts          # Read and expand skill definitions
│       ├── tasks.ts          # Session-scoped task management
│       ├── shim.ts           # Shell shim install/uninstall/status
│       ├── transcript.ts     # Display session chat history with head/tail/auto-reply
│       ├── continue.ts       # Resume session with AI-generated next step
│       └── help.ts           # Usage information
└── hooks/
    ├── hook-utils.ts         # Shared utilities: tool equivalence, polyglot output, git/gh, skill checking
    ├── shim.sh               # Shell wrapper functions (sourced from profile)
    ├── task-subject-validation.ts  # Shared validation logic
    └── *.ts                  # 43 hook scripts (all TypeScript)
```

The canonical hook manifest lives in `src/manifest.ts`. Each hook group specifies an event, an optional tool matcher, and a list of scripts. At install time, `agents.ts` translates matchers (`Bash` → `Shell` for Cursor, `Bash` → `run_shell_command` for Gemini) and events (`Stop` → `stop` for Cursor, `Stop` → `AfterAgent` for Gemini), then generates the correct config structure per agent.

Hook scripts use the equivalence sets from `hook-utils.ts` (e.g. `isShellTool("run_shell_command")` returns `true`) so they work regardless of which agent's tool name is in the payload.

## Known Limitations

**Cursor CLI** — only `beforeShellExecution` and `afterShellExecution` events fire. All other hook events (`preToolUse`, `postToolUse`, `stop`, `sessionStart`, `beforeSubmitPrompt`, etc.) are silently ignored. This means swiz event hooks only work in the **Cursor IDE**, not when running `cursor` in the terminal. **Workaround**: `swiz shim install` adds shell-level interception that catches banned commands regardless of which agent runs them. Full CLI hook parity is on Cursor's roadmap with no ETA. [Forum thread](https://forum.cursor.com/t/cursor-cli-doesnt-send-all-events-defined-in-hooks/148316).

**Codex CLI** — has `AfterAgent` and `AfterToolUse` hook events in its Rust crate, but no user-facing config file for hooks yet. Tool name mappings are tracked and ready for when user-configurable hooks ship.

**Claude Code settings revert** — a running Claude Code process watches `~/.claude/settings.json` and may revert writes within ~1.5 seconds. Close all Claude Code sessions before running `swiz install`, or the changes won't persist.
