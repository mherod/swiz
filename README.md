# swiz

A swiss-army-knife CLI for AI-assisted development — part toolkit, part swizzle.

## Install

```bash
bun install
bun link
```

Then use `swiz` from anywhere.

## Commands

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

```bash
swiz help          # list all commands
swiz help skill    # show usage for a specific command
```
