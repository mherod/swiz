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

Hooks live in `hooks/` at the project root. The authoritative manifest is the `manifest` array in `src/commands/install.ts` — it is agent-agnostic and uses camelCase event names (`stop`, `preToolUse`, `postToolUse`, `sessionStart`, `userPromptSubmit`).

Translation to agent-specific formats happens at config generation time:
- **Event names**: `EVENT_MAP` maps canonical names to Claude Code (PascalCase) and Cursor (camelCase/custom) equivalents. `UserPromptSubmit` becomes `beforeSubmitPrompt` in Cursor.
- **Tool matchers**: `TOOL_ALIASES` translates tool names per agent. Claude uses `Bash`, Cursor uses `Shell`.
- **Config structure**: Claude Code uses nested matcher groups in `~/.claude/settings.json`. Cursor uses a flat hook list with `version: 1` in `~/.cursor/hooks.json`.

When adding a hook:
1. Add the script to `hooks/`
2. Make shell scripts executable (`chmod +x`)
3. Add the entry to `manifest` in `src/commands/install.ts`
4. Run `swiz install --dry-run` to verify

DO NOT hard-code agent-specific event names or tool names in hook scripts. The translation layer handles this.

## Task Data

Tasks are stored per-session in `~/.claude/tasks/<session-id>/`. Each task is a JSON file named `<id>.json`. Audit logs go in `.audit-log.jsonl` within the session directory.

Session-to-project mapping is resolved by scanning `~/.claude/projects/` transcript files for `cwd` fields.

## Conventions

- ANSI escape codes for terminal output — no chalk or color libraries
- Prefer `Bun.spawn(["sh", "-c", cmd])` for shell execution in skills/hooks
- `.ts` hooks are invoked with `bun hooks/<file>.ts`, `.sh` hooks are invoked directly
- All settings file writes create a `.bak` backup first
