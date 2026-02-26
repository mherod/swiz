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
| Claude Code | `~/.claude/settings.json` | nested matcher groups | install / uninstall / status |
| Cursor | `~/.cursor/hooks.json` | flat list (`version: 1`) | install / uninstall / status |
| Gemini CLI | `~/.gemini/settings.json` | nested matcher groups | install / uninstall / status |
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

Deploy all 35 hooks to agent settings from the canonical manifest.

```bash
swiz install              # all agents with configurable hooks
swiz install --claude     # Claude Code only
swiz install --cursor     # Cursor only
swiz install --gemini     # Gemini CLI only
swiz install --codex      # shows Codex status (not yet configurable)
swiz install --dry-run    # line-by-line unified diff, no writes
```

- Dry run shows an LCS-based unified diff of exactly what would change, plus counts of hooks added/removed/kept.
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

35 hook scripts across 5 event types, all using shared cross-agent tool equivalence from `hooks/hook-utils.ts`:

### Stop (15)

| Hook | What it does |
|------|-------------|
| `stop-secret-scanner.sh` | Blocks stop if secrets/API keys detected in staged changes |
| `stop-debug-statements.sh` | Blocks stop if `console.log`, `debugger`, etc. left in code |
| `stop-large-files.sh` | Blocks stop if uncommitted files exceed size threshold |
| `stop-git-status.sh` | Blocks stop if working tree has uncommitted changes |
| `stop-lockfile-drift.sh` | Blocks stop if lockfile is out of sync with manifest |
| `stop-lint-staged.sh` | Runs lint-staged on staged files before allowing stop |
| `stop-git-push.sh` | Warns if commits exist that haven't been pushed |
| `stop-branch-conflicts.sh` | Checks for merge conflicts with the base branch |
| `stop-pr-description.sh` | Validates PR description exists and isn't empty |
| `stop-pr-changes-requested.sh` | Blocks stop if PR has unresolved change requests |
| `stop-github-ci.sh` | Blocks stop if GitHub Actions CI is failing |
| `stop-todo-tracker.sh` | Blocks stop if new TODO/FIXME/HACK comments were introduced |
| `stop-changelog-staleness.sh` | Warns if changelog hasn't been updated alongside code changes |
| `stop-completion-auditor.sh` | Verifies tasks have completion evidence before allowing stop |
| `stop-personal-repo-issues.ts` | Checks for open issues assigned to the user |

### PreToolUse (10)

| Hook | What it does |
|------|-------------|
| `pretooluse-banned-commands.ts` | Blocks `grep` (use `rg`), `sed`/`awk` (use Edit), `rm` (use trash), `cd`, `touch`, raw `python` |
| `pretooluse-no-npm.ts` | Redirects `npm`/`yarn` to the project's preferred package manager |
| `pretooluse-long-sleep.ts` | Blocks `sleep` commands over a threshold |
| `pretooluse-no-as-any.ts` | Blocks code edits that introduce `as any` type assertions |
| `pretooluse-no-eslint-disable.ts` | Blocks edits adding `eslint-disable` comments |
| `pretooluse-eslint-config-strength.ts` | Prevents weakening eslint rule severity |
| `pretooluse-json-validation.ts` | Validates JSON syntax before write |
| `pretooluse-require-tasks.ts` | Blocks Edit/Write/Shell tools until tasks exist for the session |
| `pretooluse-no-task-delegation.ts` | Prevents agents from delegating work to sub-tasks instead of doing it |
| `pretooluse-task-subject-validation.ts` | Validates task subjects meet quality standards |

### PostToolUse (7)

| Hook | What it does |
|------|-------------|
| `posttooluse-git-status.sh` | Injects git status context after any tool use |
| `posttooluse-json-validation.sh` | Validates JSON files are still valid after edits |
| `posttooluse-test-pairing.sh` | Reminds agent to write/update tests after code edits |
| `posttooluse-task-advisor.sh` | Countdown warning — task enforcement is coming |
| `posttooluse-pr-context.ts` | Injects PR context when checking out branches |
| `posttooluse-prettier-ts.ts` | Auto-formats TypeScript files after edits (async) |
| `posttooluse-task-subject-validation.ts` | Validates task subjects after creation |

### SessionStart (1)

| Hook | What it does |
|------|-------------|
| `sessionstart-health-snapshot.sh` | Captures project health baseline at session start |

### UserPromptSubmit (2)

| Hook | What it does |
|------|-------------|
| `userpromptsubmit-git-context.sh` | Injects current git branch/status into every prompt |
| `userpromptsubmit-task-advisor.sh` | Reminds agent about active tasks before each prompt |

## Architecture

```
swiz/
├── index.ts                  # CLI entry point
├── src/
│   ├── cli.ts                # Command registration and dispatch
│   ├── types.ts              # Command interface
│   ├── agents.ts             # Agent definitions, tool/event translation
│   └── commands/
│       ├── install.ts        # Deploy hooks with per-agent config generation
│       ├── uninstall.ts      # Remove swiz hooks, preserve others
│       ├── status.ts         # Installation state overview
│       ├── hooks.ts          # Inspect hook configs across agents
│       ├── skill.ts          # Read and expand skill definitions
│       ├── tasks.ts          # Session-scoped task management
│       └── help.ts           # Usage information
└── hooks/
    ├── hook-utils.ts         # Shared cross-agent tool equivalence sets + polyglot output helpers
    ├── task-subject-validation.ts  # Shared validation logic
    └── *.sh / *.ts           # 35 hook scripts
```

The canonical hook manifest lives in `install.ts`. Each hook group specifies an event, an optional tool matcher, and a list of scripts. At install time, `agents.ts` translates matchers (`Bash` → `Shell` for Cursor, `Bash` → `run_shell_command` for Gemini) and events (`Stop` → `stop` for Cursor, `Stop` → `AfterAgent` for Gemini), then generates the correct config structure per agent.

Hook scripts themselves use the equivalence sets from `hook-utils.ts` (e.g. `isShellTool("run_shell_command")` returns `true`) so they work regardless of which agent's tool name is in the payload.
