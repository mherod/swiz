# swiz

A cross-agent hooks framework that bullies AI coding agents into disciplined, accountable autonomous behaviour. One manifest of hook scripts gets installed across Claude Code, Cursor, Gemini CLI, and Codex CLI — translating tool names, event names, and config formats automatically so every agent plays by the same rules.

Hooks block dangerous patterns, enforce task tracking, gate completions on evidence, redirect agents to safe tool alternatives, and inject contextual awareness at every stage of the agent loop.

## Install

```bash
bun install
bun link
```

Then use `swiz` from anywhere.

## Supported Agents

| Agent | Config Path | Hooks | Status |
|-------|------------|-------|--------|
| Claude Code | `~/.claude/settings.json` | nested matcher groups | full support |
| Cursor IDE | `~/.cursor/hooks.json` | flat list (`version: 1`) | full support |
| Cursor CLI | `~/.cursor/hooks.json` | flat list (`version: 1`) | **limited** — only `beforeShellExecution` / `afterShellExecution` fire ([tracking](https://forum.cursor.com/t/cursor-cli-doesnt-send-all-events-defined-in-hooks/148316)) |
| Gemini CLI | `~/.gemini/settings.json` | nested matcher groups | full support |
| Codex CLI | `~/.codex/config.toml` | Rust-only (no user config) | tool mappings tracked, ready when hooks ship |

### Cross-Agent Translation

Tool names, event names, and config structures are translated per-agent from a single canonical manifest. A hook script works identically regardless of which agent triggers it.

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

**Hook Output**

Hook scripts emit polyglot JSON that all agents understand — `decision`/`reason` at the top level (Gemini/Codex format) alongside nested `hookSpecificOutput` (Claude/Cursor format) in a single payload.

## Commands

### `swiz install`

Deploy all 39 hooks to agent settings from the canonical manifest. **Merge-based** — swiz hooks are added alongside your existing hooks, never replacing them.

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
- Non-configurable agents (Codex) are skipped gracefully with an explanation.

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

Skills are discovered from `.skills/` (project-local) and `~/.claude/skills/` (global). The `!`command`` inline syntax is expanded by default — shell commands inside skill content are executed and their output is inlined.

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

**The loop**: `stop-auto-continue` blocks stop with a suggestion → user runs `swiz continue` → session resumes with that suggestion as the first user prompt.

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

## Bundled Hooks

39 hook scripts across 5 event types, all TypeScript, using shared utilities from `hooks/hook-utils.ts` (cross-agent tool equivalence, polyglot output, git/gh helpers, portable skill checking):

### Stop (17)

| Hook | What it does |
|------|-------------|
| `stop-secret-scanner.ts` | Blocks stop if secrets/API keys detected in staged changes |
| `stop-debug-statements.ts` | Blocks stop if `console.log`, `debugger`, etc. left in code |
| `stop-large-files.ts` | Blocks stop if uncommitted files exceed size threshold |
| `stop-git-status.ts` | Blocks stop if working tree has uncommitted changes |
| `stop-lockfile-drift.ts` | Blocks stop if lockfile is out of sync with manifest |
| `stop-lint-staged.ts` | Runs lint-staged on staged files before allowing stop |
| `stop-git-push.ts` | Warns if commits exist that haven't been pushed |
| `stop-branch-conflicts.ts` | Checks for merge conflicts with the base branch |
| `stop-pr-description.ts` | Validates PR description exists and isn't empty |
| `stop-pr-changes-requested.ts` | Blocks stop if PR has unresolved change requests |
| `stop-github-ci.ts` | Blocks stop if GitHub Actions CI is failing |
| `stop-todo-tracker.ts` | Blocks stop if new TODO/FIXME/HACK comments were introduced |
| `stop-changelog-staleness.ts` | Warns if changelog hasn't been updated alongside code changes |
| `stop-completion-auditor.ts` | Verifies tasks have completion evidence before allowing stop |
| `stop-personal-repo-issues.ts` | Checks for actionable open issues (skips blocked/upstream) |
| `stop-auto-continue.ts` | Blocks stop once with an AI-generated "next step" suggestion; respects `stop_hook_active` to allow stop on second attempt |
| `stop-memory-updater.ts` | Extracts confirmed patterns from transcript to project memory (async, never blocks) |

### PreToolUse (11)

| Hook | What it does |
|------|-------------|
| `pretooluse-banned-commands.ts` | Blocks `grep` (use `rg`), `sed`/`awk` (use Edit), `rm` (use trash), `cd`, `touch`, raw `python` |
| `pretooluse-no-npm.ts` | Redirects `npm`/`yarn` to the project's preferred package manager |
| `pretooluse-long-sleep.ts` | Blocks `sleep` commands over a threshold |
| `pretooluse-no-as-any.ts` | Blocks code edits that introduce `as any` type assertions |
| `pretooluse-no-eslint-disable.ts` | Blocks edits adding `eslint-disable` comments |
| `pretooluse-eslint-config-strength.ts` | Prevents weakening eslint rule severity |
| `pretooluse-json-validation.ts` | Validates JSON syntax before write |
| `pretooluse-no-direct-deps.ts` | Blocks direct edits to dependency blocks in package.json — use the package manager |
| `pretooluse-require-tasks.ts` | Blocks Edit/Write/Shell tools unless at least one task is pending or in progress |
| `pretooluse-no-task-delegation.ts` | Prevents agents from delegating work to sub-tasks instead of doing it |
| `pretooluse-task-subject-validation.ts` | Validates task subjects meet quality standards |

### PostToolUse (7)

| Hook | What it does |
|------|-------------|
| `posttooluse-git-status.ts` | Injects git status context after any tool use |
| `posttooluse-json-validation.ts` | Validates JSON files are still valid after edits |
| `posttooluse-test-pairing.ts` | Reminds agent to write/update tests after code edits |
| `posttooluse-task-advisor.ts` | Countdown warning — task enforcement is coming |
| `posttooluse-pr-context.ts` | Injects PR context when checking out branches |
| `posttooluse-prettier-ts.ts` | Auto-formats TypeScript files after edits (async) |
| `posttooluse-task-subject-validation.ts` | Validates task subjects after creation |

### SessionStart (2)

| Hook | What it does |
|------|-------------|
| `sessionstart-health-snapshot.ts` | Captures project health baseline at session start |
| `sessionstart-compact-context.ts` | Re-injects core conventions after context compaction |

### UserPromptSubmit (2)

| Hook | What it does |
|------|-------------|
| `userpromptsubmit-git-context.ts` | Injects current git branch/status into every prompt |
| `userpromptsubmit-task-advisor.ts` | Reminds agent about active tasks before each prompt |

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
    └── *.ts                  # 39 hook scripts (all TypeScript)
```

The canonical hook manifest lives in `src/manifest.ts`. Each hook group specifies an event, an optional tool matcher, and a list of scripts. At install time, `agents.ts` translates matchers (`Bash` → `Shell` for Cursor, `Bash` → `run_shell_command` for Gemini) and events (`Stop` → `stop` for Cursor, `Stop` → `AfterAgent` for Gemini), then generates the correct config structure per agent.

Hook scripts themselves use the equivalence sets from `hook-utils.ts` (e.g. `isShellTool("run_shell_command")` returns `true`) so they work regardless of which agent's tool name is in the payload.

## Known Limitations

**Cursor CLI** — only `beforeShellExecution` and `afterShellExecution` events fire. All other hook events (`preToolUse`, `postToolUse`, `stop`, `sessionStart`, `beforeSubmitPrompt`, etc.) are silently ignored. This means swiz event hooks only work in the **Cursor IDE**, not when running `cursor` in the terminal. **Workaround**: `swiz shim install` adds shell-level interception that catches banned commands regardless of which agent runs them. Full CLI hook parity is on Cursor's roadmap with no ETA. [Forum thread](https://forum.cursor.com/t/cursor-cli-doesnt-send-all-events-defined-in-hooks/148316).

**Codex CLI** — has `AfterAgent` and `AfterToolUse` hook events in its Rust crate, but no user-facing config file for hooks yet. Tool name mappings are tracked and ready for when user-configurable hooks ship.

**Claude Code settings revert** — a running Claude Code process watches `~/.claude/settings.json` and may revert writes within ~1.5 seconds. Close all Claude Code sessions before running `swiz install`, or the changes won't persist.
