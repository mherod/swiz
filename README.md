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
swiz skill commit       # print a skill's full content
```

Skills are discovered from:

- `.skills/` — project-local skills (relative to cwd)
- `~/.claude/skills/` — global skills

### `swiz help [command]`

Show available commands or details for a specific one.
