# swiz

A cross-agent hooks framework that enforces autonomous discipline. Swiz installs hook scripts across AI coding agents — Claude Code, Cursor, and Gemini CLI — ensuring consistent, accountable behaviour regardless of which agent is running.

Hooks block bad patterns, enforce task tracking, gate completions on evidence, and redirect agents to safe alternatives. One manifest, every agent.

## Install

```bash
bun install
bun link
```

Then use `swiz` from anywhere.

## Supported Agents

| Agent | Config Path | Status |
|-------|------------|--------|
| Claude Code | `~/.claude/settings.json` | ✓ |
| Cursor | `~/.cursor/hooks.json` | ✓ |
| Gemini CLI | `~/.gemini/settings.json` | ✓ |

Tool names, event names, and config structures are automatically translated between agents. A hook written once works everywhere:

| Concept | Claude Code | Cursor | Gemini CLI |
|---------|------------|--------|------------|
| Shell | `Bash` | `Shell` | `run_shell_command` |
| Edit | `Edit` | `StrReplace` | `replace` |
| Write | `Write` | `Write` | `write_file` |
| Before tool | `PreToolUse` | `preToolUse` | `BeforeTool` |
| After tool | `PostToolUse` | `postToolUse` | `AfterTool` |
| Stop | `Stop` | `stop` | `AfterAgent` |
| Tasks | `TaskCreate` | `TodoWrite` | `write_todos` |

## Commands

### `swiz install`

Deploy hooks to all detected agents from a single manifest.

```bash
swiz install              # all agents
swiz install --claude     # Claude Code only
swiz install --cursor     # Cursor only
swiz install --gemini     # Gemini CLI only
swiz install --dry-run    # full diff preview, no writes
```

Dry run shows a line-by-line unified diff of exactly what would change, plus a summary of hooks added/removed/kept.

If a running agent process (e.g. Claude Code) reverts the write, swiz detects this and tells you to close sessions first.

### `swiz uninstall`

Cleanly remove all swiz-managed hooks from agent settings, preserving any non-swiz hooks.

```bash
swiz uninstall              # all agents
swiz uninstall --cursor     # Cursor only
swiz uninstall --dry-run    # preview what would be removed
```

### `swiz status`

Show installation state across all agents — binary location, settings path, and hook counts.

```bash
swiz status
```

### `swiz hooks [event] [script]`

Inspect hook configurations across all agents.

```bash
swiz hooks                    # list all events from all agents
swiz hooks Stop               # show hooks for an event
swiz hooks Stop secret-scanner # print full source of a hook script
```

### `swiz skill [name]`

Read skills used by Claude Code, Codex, and other AI coding tools.

```bash
swiz skill              # list all available skills
swiz skill commit       # print a skill with inline commands expanded
swiz skill --raw commit # print the raw SKILL.md without expansion
```

Skills are discovered from `.skills/` (project-local) and `~/.claude/skills/` (global). Inline `!`command`` directives are expanded by default.

### `swiz tasks [subcommand]`

Session-scoped task management with audit logging.

```bash
swiz tasks                                  # list tasks for current project
swiz tasks --all-projects                   # list across all projects
swiz tasks create "subject" "description"   # create a new task
swiz tasks complete <id> --evidence "text"  # complete with evidence (required)
swiz tasks status <id> in_progress          # update status
swiz tasks complete-all                     # bulk-complete remaining
```

## Bundled Hooks

35 hooks across 5 event types:

**Stop** (15) — Secret scanning, debug statements, large files, uncommitted changes, lockfile drift, lint-staged, unpushed commits, branch conflicts, PR description, changes requested, CI status, TODO tracking, changelog staleness, completion auditing, open issues.

**PreToolUse** (10) — Banned commands (grep→rg, sed→Edit, rm→trash, cd, touch, python), npm/yarn→pnpm redirects, long sleep detection, `as any` blocking, eslint-disable blocking, eslint config strength enforcement, JSON validation, task enforcement (blocks tools until tasks exist), task delegation prevention, task subject validation.

**PostToolUse** (7) — Git status context, JSON validation, test pairing reminders, task advisor (countdown to enforcement), PR context on checkout, prettier formatting, task subject validation.

**SessionStart** (1) — Project health snapshot.

**UserPromptSubmit** (2) — Git context injection, task advisor.

All hook scripts use shared cross-agent tool equivalence sets from `hooks/hook-utils.ts`, so they respond correctly regardless of whether the tool is called `Bash`, `Shell`, or `run_shell_command`.
