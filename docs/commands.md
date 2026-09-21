# Swiz CLI — Command Reference

All commands are registered in `index.ts` via `registerCommand()` and dispatched by `src/cli.ts`.

## CLI Runtime (`src/cli.ts`)

`run()` is the entry point:

1. Validates manifest/route/agent symmetry via `validateDispatchRoutes()` before any command executes.
2. Injects a synthetic `help` command into the registry (not registered via `registerCommand`).
3. Parses `process.argv.slice(2)` — first token is the command name, remainder are args.
4. On unknown command: fuzzy-suggests the closest registered command via `suggest()` from `src/fuzzy.ts`.
5. On unknown flags: warns with fuzzy suggestions derived from the command's declared `options` array.
6. Drains offline issue mutations via `tryReplayPendingMutations()` before executing.
7. Throws from `command.run()` are caught, printed to stderr, and set `process.exitCode = 1`.

### Command Interface (`src/types.ts`)

```ts
interface Command {
  name: string
  description: string
  usage?: string
  options?: Array<{ flags: string; description: string }>
  run(args: string[]): Promise<void> | void
}
```

Commands throw errors on failure instead of calling `process.exit(1)` directly — the CLI runtime handles exit codes.

---

## Command Registry

Commands are registered in this order in `index.ts`:

### Hook & Installation

| Command | Source | Description |
|---------|--------|-------------|
| `skill` | `src/commands/skill.ts` | Read, list, sync, and convert skills. Subcommands: `read`, `list`, `sync`, `convert`, `to-command`. `to-command` transforms skills into agent commands. |
| `hooks` | `src/commands/hooks.ts` | Inspect agent hooks (Claude Code, Cursor, Gemini CLI) |
| `install` | `src/commands/install.ts` | Install swiz hooks into agent settings |
| `uninstall` | `src/commands/uninstall.ts` | Remove swiz hooks from agent settings |
| `shim` | `src/commands/shim.ts` | Install shell-level command interception for agents |

On macOS, default `swiz install` also installs and loads
`~/Library/LaunchAgents/com.swiz.doctor-clean.plist`. It runs `swiz doctor clean`
immediately when loaded (including login), then every 24 hours while logged in.
Reinstalling an unchanged, loaded agent does not restart it. Changes to an existing
plist are backed up to `.plist.bak` before replacement.

The scheduled cleanup uses Trash and the normal retention defaults below. It never
forces Codex to quit. Output is appended to `~/Library/Logs/Swiz/doctor-clean.log`
and errors to `~/Library/Logs/Swiz/doctor-clean.error.log`.

`swiz install --dry-run` previews the job without writing or loading it.
`--json` and scoped installs such as `--codex`, `--daemon`, `--merge-tool`, `--mcp`, and
`--status-line` leave this user-wide job unchanged. Full `swiz install --uninstall`
unloads the job and moves its plist to Trash; logs are retained. Other platforms
skip the LaunchAgent integration.

### Status & Configuration

| Command | Source | Description |
|---------|--------|-------------|
| `status` | `src/commands/status.ts` | Show swiz installation status across agents |
| `status-line` | `src/commands/status-line.ts` | Output a rich ANSI status bar for Claude Code's statusLine hook |
| `settings` | `src/commands/settings.ts` | View and modify swiz global and per-session settings |
| `manage` | `src/commands/manage.ts` | Manage MCP configurations across supported agents |
| `state` | `src/commands/state.ts` | Show or set the persistent project state |
| `memory` | `src/commands/memory.ts` | Show hierarchical rule/memory files for one or all agents |

### Task Management

| Command | Source | Description |
|---------|--------|-------------|
| `tasks` | `src/commands/tasks.ts` | View and manage agent tasks |

### Hook Dispatch & Transcript

| Command | Source | Description |
|---------|--------|-------------|
| `dispatch` | `src/commands/dispatch.ts` | Fan out a hook event to all matching scripts (used by agent configs) |
| `transcript` | `src/commands/transcript.ts` | Display Agent-User chat history for the current project |

### Session & Continuation

| Command | Source | Description |
|---------|--------|-------------|
| `continue` | `src/commands/continue.ts` | Resume the most recent session with an AI-generated next step |
| `session` | `src/commands/session.ts` | Show the current session ID |

### Issue Management

| Command | Source | Description |
|---------|--------|-------------|
| `issue` | `src/commands/issue.ts` | Interact with GitHub issues and PRs. Subcommands: `close`, `comment`, `resolve`, `sync`, `cache-bust`, `list`. `sync` updates the local store from upstream. |
| `cross-repo-issue` | `src/commands/cross-repo-issue.ts` | File a GitHub issue with exact change details when a sandbox edit is blocked. Auto-infers `--repo` from known sandbox paths |

### AI-Powered Analysis

| Command | Source | Description |
|---------|--------|-------------|
| `idea` | `src/commands/idea.ts` | Use AI to propose a creative next idea for the current project |
| `reflect` | `src/commands/reflect.ts` | Use AI to reflect on mistakes in a session transcript |
| `sentiment` | `src/commands/sentiment.ts` | Score text for approval/rejection sentiment using heuristic regex clusters |
| `mergetool` | `src/commands/mergetool.ts` | AI-powered Git merge conflict resolver |

### CI & Push

| Command | Source | Description |
|---------|--------|-------------|
| `ci-wait` | `src/commands/ci-wait.ts` | Poll GitHub Actions run status for a commit until completion |
| `push-wait` | `src/commands/push-wait.ts` | Wait for push cooldown to expire, then push |
| `push-ci` | `src/commands/push-ci.ts` | Push to remote and wait for CI to pass (combines push-wait + ci-wait) |

### Maintenance

| Command | Source | Description |
|---------|--------|-------------|
| `doctor clean` | `src/commands/doctor/cleanup.ts` | Remove old Claude Code, Codex, and Antigravity session data plus backup artifacts |
| `doctor` | `src/commands/doctor.ts` | Run diagnostic checks on the swiz installation |
| `usage` | `src/commands/usage.ts` | Summarize Claude usage data from `~/.claude.json` |

`swiz doctor clean --dry-run` previews cleanup with a 30-day default for other
providers. Codex cleanup selects all rollouts under `~/.codex/archived_sessions/`.
Unarchived rollouts under `~/.codex/sessions/` are always retained, including their
associated task files, even with `--force`, `--skip-trash`, or `--task-older-than`.
Other providers respect explicit `--older-than` values. `doctor --fix` uses the same
Codex policy while keeping its 24-hour automatic cleanup window for other providers.

Omit `--dry-run` to move selected files to Trash; `--skip-trash` permanently deletes
them instead. Retained Codex rollouts and their task files are left intact,
including older metadata and history. Codex and Antigravity stores are excluded
when `--project` is supplied.

Codex cleanup is skipped while the macOS app or any Codex process is running,
or when the process list cannot be inspected. Other providers still clean up.
Use `swiz doctor clean --older-than 48h --force` from a separate terminal to quit
the Codex app and stop its remaining processes before cleanup. On macOS this uses
`osascript`, requesting a normal quit before sending TERM and then KILL if needed.
Cleanup proceeds only after Codex has exited, with a final check before deletion.
`--force --dry-run` previews the shutdown and cleanup without stopping anything.
Automatic cleanup through `doctor --fix` never forces Codex to stop.

`swiz doctor` checks the cleanup LaunchAgent's configuration and loaded state on
macOS. `swiz doctor --fix` installs or repairs missing, outdated, or unloaded jobs
after its automatic cleanup completes. Repairs use the same installer and backups.

---

## Help System

- `swiz help` — lists all registered commands with descriptions
- `swiz help <command>` — shows usage and option flags for a specific command
- `swiz <command> --help` / `swiz <command> -h` — equivalent to `swiz help <command>`
- `swiz --help` / `swiz -h` — equivalent to `swiz help`

The `help` command is created dynamically in `src/commands/help.ts` with access to the full commands map.

---

## Error Handling Conventions

- Commands in `src/commands/` throw `Error` instances; `src/cli.ts` catches and sets `process.exitCode = 1`.
- Hook scripts (`hooks/*.ts`) are the exception: they call `process.exit(0)` intentionally and use output helpers (`denyPreToolUse`, `blockStop`, etc.) from `hooks/hook-utils.ts`.
- Diagnostic output goes to `console.error`; structured machine-consumed output goes to `console.log`.
- Debug logging is gated behind `SWIZ_DEBUG`: `const debugLog = process.env.SWIZ_DEBUG ? console.error.bind(console) : () => {}`.

See also:
- [`dispatch-and-daemon.md`](./dispatch-and-daemon.md) — end-to-end map of the dispatch + daemon system
- [`dispatch-engine.md`](./dispatch-engine.md) — how `dispatch` fans out hook events
- [`ai-providers.md`](./ai-providers.md) — how `idea`, `reflect`, and `continue` resolve AI backends
