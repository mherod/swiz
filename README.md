# swiz

A swiss-army-knife CLI for AI-assisted development — part toolkit, part swizzle.

Works across agents: Claude Code, Cursor, and more.

## Install

```bash
bun install
bun link
```

Then use `swiz` from anywhere.

## Commands

### `swiz install`

Install swiz-managed hooks into your agent settings. Generates consistent configs for both Claude Code and Cursor from a single hook manifest.

```bash
swiz install              # install hooks for all detected agents
swiz install --claude     # Claude Code only (~/.claude/settings.json)
swiz install --cursor     # Cursor only (~/.cursor/hooks.json)
swiz install --dry-run    # preview what would be written
```

Includes 35 hooks across 5 event types:

- **Stop** (15) — secret scanning, debug statements, large files, uncommitted changes, lockfile drift, lint-staged, unpushed commits, branch conflicts, PR description, changes requested, CI status, TODO tracking, changelog staleness, completion auditing, open issues
- **PreToolUse** (10) — banned commands, npm/yarn redirects, long sleep, `as any` casts, eslint-disable, eslint config strength, JSON validation, task enforcement, task delegation, task subject validation
- **PostToolUse** (7) — git status context, JSON validation, test pairing, task advisor, PR context on checkout, prettier formatting, task subject validation
- **SessionStart** (1) — project health snapshot
- **UserPromptSubmit** (2) — git context, task advisor

Event names and tool matchers are automatically translated between agents (e.g. `Bash`/`Shell`, `Stop`/`stop`, `UserPromptSubmit`/`beforeSubmitPrompt`).

### `swiz hooks [event] [script]`

Inspect hook configurations across all agents.

```bash
swiz hooks                    # list all events from Claude Code + Cursor
swiz hooks Stop               # show hooks for an event (matches both agents)
swiz hooks Stop secret-scanner # print full source of a hook script
```

### `swiz skill [name]`

Read skills used by Claude Code, Codex, and other AI coding tools.

```bash
swiz skill              # list all available skills
swiz skill commit       # print a skill with inline commands expanded
swiz skill --raw commit # print the raw SKILL.md without expansion
```

Skills are discovered from:

- `.skills/` — project-local skills (relative to cwd)
- `~/.claude/skills/` — global skills

#### Inline command expansion

Skills can contain `` !`command` `` directives that inject dynamic context (e.g. `git status`, `pwd`). By default, `swiz skill` executes these and inlines the output — just like Claude Code does at runtime. Use `--raw` to see the unexpanded source.

### `swiz help [command]`

Show available commands or details for a specific one.
