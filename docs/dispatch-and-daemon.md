# Dispatch & Daemon: System Map

How a hook event travels from an agent (Claude Code, Cursor, Gemini, Codex, Antigravity) through swiz and back. This is the end-to-end map; for engine internals (hook matching, per-hook execution, strategy merge semantics) see [`dispatch-engine.md`](./dispatch-engine.md).

---

## Big Picture

```
┌─────────────┐  hook event   ┌──────────────────┐  HTTP POST /dispatch   ┌─────────────────┐
│ Agent       │ ────────────▶ │ swiz dispatch    │ ─────────────────────▶ │ Daemon          │
│ (Claude,    │  JSON stdin   │ (CLI, short-     │   (preferred path)     │ Bun.serve :7943 │
│  Cursor, …) │               │  lived process)  │ ◀───────────────────── │ warm caches     │
└─────────────┘ ◀──────────── └──────────────────┘   JSON response        └─────────────────┘
                JSON stdout          │                                            │
                                     │ fallback when daemon                       │
                                     │ is down / times out                        ▼
                                     ▼                                   executeDispatch()
                              executeDispatch()                          (same shared core)
                              (in-process, cold)
┌─────────────┐  git hook
│ lefthook    │ ────────────▶  SWIZ_DIRECT=1 swiz dispatch preCommit|commitMsg|prePush
└─────────────┘
```

Three entry points converge on one shared execution core, `executeDispatch()` in `src/dispatch/execute.ts`:

1. **Agent hooks** — `swiz install` writes `swiz dispatch --agent <id> <canonicalEvent> <agentEventName>` into each agent's settings file. The agent pipes its hook payload to that command's stdin.
2. **Scheduled (git) hooks** — `lefthook.yml` pipes a synthetic payload into `SWIZ_DIRECT=1 swiz dispatch preCommit|commitMsg|prePush`. These events are marked `scheduled: true` in the manifest and are *excluded* from agent settings, so they never double-fire.
3. **Daemon-internal** — the daemon's transcript/session monitor can emit pseudo-hook dispatches (`postToolUse`, `notification`) for agents without native hook support (gated by the `swizNotifyHooks` setting).

`SWIZ_DIRECT=1` does **not** change dispatch behaviour — it only bypasses the interactive global-link guard in `index.ts` so a checkout copy can be invoked directly.

---

## CLI Path: `swiz dispatch` (`src/commands/dispatch.ts`)

The CLI process is intentionally thin and short-lived:

1. **Read stdin** — JSON payload, 2s timeout.
2. **Normalize** — `normalizeAgentHookPayload()` (`src/dispatch/payload-normalize.ts`) maps agent-specific shapes to the canonical one (Cursor `conversation_id` → `session_id`, `workspace_roots` → `cwd`, Cursor shell events → Claude-style `{tool_name: "Bash", tool_input: {command}}`).
3. **Backfill** — `backfillPayloadDefaults()` (`src/dispatch/payload-backfill.ts`) fills missing `cwd` (payload → `$GEMINI_CWD`/`$GEMINI_PROJECT_DIR`/`$CLAUDE_PROJECT_DIR` → `process.cwd()`) and `session_id` (payload → `$GEMINI_SESSION_ID` → newest transcript `.jsonl` mtime → `"unknown-session"`). Inferred fields are recorded in `payload._inferredFields`.
4. **Enrich** — the CLI injects context the daemon cannot see:
   - `_env` — allowlisted caller environment (`PATH`, `HOME`, `TERM*`, `SWIZ_*`, agent vars). Hooks run by the daemon get the origin environment from here, never from launchd's.
   - `_terminal` — detected terminal app. The daemon must read this from the payload, never call `detectTerminal()` itself.
   - `_agent` — agent id baked in at install time via the `--agent` flag.
5. **Fast paths** — before any network hop: stop/subagentStop events check the task list in-process (`tryStopFastPath`), and non-git directories skip hooks entirely (`tryNonGitFastPath`).
6. **Capture** — payloads are written to `/tmp/swiz-incoming/` (raw + normalized + per-event `.jsonl`, ~10 min retention, `_env` stripped). Disable with `SWIZ_CAPTURE_INCOMING=0`.
7. **Try daemon** — POST to `http://127.0.0.1:<port>/dispatch?event=…&hookEventName=…`. Port is `SWIZ_DAEMON_PORT` or `7943` (`src/commands/daemon/daemon-admin.ts`).
8. **Fallback** — on daemon failure or timeout, run `executeDispatch()` in-process. A failure starts a 30s backoff (`BACKOFF_MS`) during which the daemon is not retried, avoiding burning the timeout budget on every event.
9. **Respond** — write a single JSON object to stdout and `process.exit(0)`.

---

## Shared Core: `executeDispatch()` (`src/dispatch/execute.ts`)

Both CLI fallback and daemon call the same function with a `DispatchRequest`:

```ts
{
  canonicalEvent, hookEventName, payloadStr,
  daemonContext: boolean,        // true in daemon: no process.env mutation
  signal?: AbortSignal,          // request-level timeout propagation
  manifestProvider?, currentSessionToolUsageProvider?,
  lastUserMessageAtProvider?,    // daemon-supplied warm caches
  onDispatchLifecycle?,          // daemon metrics callback
}
```

Sequence:

1. **Build context** — parse/normalize/backfill payload, detect agent, resolve tool name and trigger.
2. **Resolve hook groups** — load manifest (daemon: cached; CLI: fresh), match groups by event + tool/trigger, then apply setting filters (disabled hooks, PR-merge mode, stacks, project state, required settings — see [`dispatch-engine.md`](./dispatch-engine.md#hook-filtering)).
3. **Short-circuits** — non-git cwd, MCP tools when `ignoreMcpTools` is on, and **subagent sessions**: when the payload carries `agent_type`/`agent_id` (`src/dispatch/subagent-detect.ts`) and `relaxSubagentHooks` is not disabled (default on), dispatch is skipped entirely — except `preCommit`/`commitMsg`/`prePush`, which form the safety floor and always run.
4. **Inject settings** — merged global + project + session settings land on the payload as `_effectiveSettings`; project state as `_projectState`.
5. **Enrich for hooks** — transcript summary, current-session tool/skill usage, last-user-message timestamp (drives the humanisation grace window), Codex `update_plan` sync.
6. **Run strategy with timeout** — `DISPATCH_TIMEOUTS[event] + 5s` grace; on expiry the dispatch `AbortController` fires and all in-flight hooks receive SIGTERM.
7. **Validate + coerce response** — against the agent wire schema; stop responses are normalized by `src/dispatch/stop-response.ts` (always `continue: true`, mirrored `reason`/`stopReason`).

### Routing and strategies

`DISPATCH_ROUTES` (`src/dispatch/index.ts`) maps each canonical event to one of three strategies; `validateDispatchRoutes()` enforces that manifest events, routes, and agent `eventMap`s stay in sync (run from both `swiz dispatch` and `swiz install`).

| Strategy | Events | Semantics |
|----------|--------|-----------|
| `preToolUse` | `preToolUse` | Concurrent fan-out; first deny short-circuits; allow-hints merged and deduplicated |
| `blocking` | `stop`, `postToolUse`, `subagentStop`, `sessionEnd`, `preCommit`, `commitMsg`, `prePush` | Stop runs *all* hooks within a 10s collection window and aggregates every block into one checklist; other events short-circuit on first block |
| `context` | `sessionStart`, `userPromptSubmit`, `preCompact`, `notification`, `subagentStart` | Runs all hooks, merges `additionalContext` |

All strategies share `runStrategyPipeline()` (`src/dispatch/strategy-base.ts`): async (`fire-and-forget`) hooks launch unawaited, sync hooks fan out concurrently, abort signals propagate, and a per-strategy `processResults()` merges output. Stop and context output may be humanised via LLM, skipped within `USER_MESSAGE_GRACE_MS` of the last user message. On session stop, queued auto-steer messages are delivered instead of normal hook output.

Per-hook execution (subprocess spawn, inline `SwizHook`s, worker pool, timeouts, cooldowns, output classification via `hookOutputSchema`) is covered in [`dispatch-engine.md`](./dispatch-engine.md).

### Dispatch timeouts (`DISPATCH_TIMEOUTS`, `src/manifest.ts`)

| Event | Budget |
|-------|--------|
| `stop` | 180s (AI auto-continue + CI polling dominate) |
| `sessionStart` | 20s |
| `preCommit` / `prePush` | 30s |
| `preToolUse` / `postToolUse` / `userPromptSubmit` / `preCompact` | 15s |
| `commitMsg` | 10s |

---

## The Daemon (`src/commands/daemon.ts`, `src/commands/daemon/`)

A long-lived `Bun.serve` process on port 7943. Its job is to make dispatch fast: warm manifest/settings/git/transcript caches replace the CLI's cold start. It is **multi-project** — all state is scoped by `cwd`, with at most 2 actively-watched projects (LRU eviction by last-seen, idle eviction after 3 min).

### Daemon-side dispatch (`src/commands/daemon/web-server.ts`)

`POST /dispatch` parses the payload once via `buildSpawnContext()` (cwd + merged `_env`), seeds the task state cache (`watchSession()` + disk seed on first sight of a session), schedules payload capture, then calls `executeDispatch()` with `daemonContext: true` and daemon-provided cache callbacks. Key differences from the CLI path:

- **No `process.env` mutation** — hooks get the caller's environment from `payload._env` / spawn env only (`applyDispatchEnv()` is CLI-only).
- **Request timeout** — `DISPATCH_TIMEOUTS[event] + 10s` grace (60s fallback); expiry returns HTTP 504 and aborts in-flight hooks.
- **Metrics** — every dispatch updates global and per-project counters, session activity, and captured tool calls.
- **Allow-message dedup** — repeated identical allow/permission hints for the same `(event, cwd, session, tool)` are suppressed.

### Endpoint surface

| Area | Endpoints |
|------|-----------|
| Dispatch | `POST /dispatch`, `GET /dispatch/active` |
| Health/metrics | `GET /health`, `GET /metrics`, `GET /cache/status`, `GET /api/hook-logs`, `GET /api/gh-rate-limit` |
| Caches for hooks | `POST /gh-query`, `/hooks/eligible`, `/hooks/cooldown`, `/hooks/cooldown/mark`, `/transcript/index`, `/git/state`, `/sessions/last-user-message`, `/session-edits/list` |
| CI watching | `POST /ci-watch`, `POST /ci-watch/webhook` (HMAC-verified), `GET /ci-watches` |
| Issues/PRs | `POST /projects/issues`, `/projects/prs`, `/projects/sync-now` |
| Sessions/tasks | `POST /sessions/projects`, `/sessions/messages`, `/sessions/tasks`, `/projects/tasks`, `/tasks/create`, `/sessions/delete` |
| Settings | `GET /settings/global`, `POST /settings/global/update`, `/settings/project`, `/settings/project/update` |
| Status line | `POST /status-line/snapshot`, `POST /compliance/record`, `GET /compliance/current` |
| Processes | `GET /process/agents`, `POST /process/agents/kill` |
| Web UI | `GET /`, `/web/*` (transpiled on demand from `src/web/**` — browser-resolvable imports only), `/public/*` |

Hooks should consume these via the helpers in `src/utils/daemon-git-state.ts` (`fetchGitStatusFromDaemon`, `fetchLastUserMessageFromDaemon`, `fetchSessionTasksFromDaemon`) rather than raw fetches; all return `null` quickly when the daemon is down so callers fall back to direct computation.

### Daemon-resident state and caches

Created once at startup (`createDaemonState` / `createDaemonCaches` in `daemon.ts`); all bounded (`CappedMap`/LRU) and pruned on timers:

- **Metrics** — global + per-project dispatch counts/durations, memory sampled every 30s.
- **Session state** — activity, captured tool calls (persisted to `~/.swiz/projects/<projectKey>/sessions/<id>/.tool-calls.jsonl`), tool/skill usage (hydrated from the transcript index on startup), compliance state machine.
- **`FileWatcherRegistry`** — watches `src/manifest.ts`, `hooks/`, global and per-project settings, `.git/`, transcript paths; invalidates the manifest cache and status-line snapshots on change.
- **`GhQueryCache`** — `gh` CLI results, 10 min TTL.
- **`GitStateCache`** — branch/staged/unstaged/untracked/upstream/ahead/behind per cwd, served from `POST /git/state`.
- **`TaskStateCache`** (`src/tasks/task-state-cache.ts`) — LRU + `fs.watch` + write-through. Stop hooks must use `readSessionTasksFresh()`, not this cache.
- **`UpstreamSyncRegistry`** — syncs GitHub issue/PR/CI state into the **IssueStore** (`~/.swiz/issues.db`, 5 min TTL) every 2 min per registered repo; restored across restarts. `posttooluse-upstream-sync-on-push` POSTs `/projects/sync-now` after mutating `git push`/`gh` commands so the store never serves stale state after a write.
- **`PrReviewMonitor`** — inspects sync results and schedules auto-steer messages (e.g. "review arrived") for active sessions.
- **`CiWatchRegistry`** — active CI watches, 30s poll, 1h timeout.
- **Snapshot resolver** — status-line snapshots, LRU 200, invalidated by fingerprint (manifest, branch, issue/PR counts, review state); coalesces concurrent requests.

### Lifecycle

- **Run**: `swiz daemon [--port 7943]`. **Status**: `swiz daemon status` (fetches `/metrics`). **Restart** after editing `src/` modules consumed by hooks: `lsof -ti tcp:7943 | xargs -r kill && swiz daemon --port 7943`.
- **LaunchAgent**: `swiz daemon --install` writes `~/Library/LaunchAgents/com.swiz.daemon.plist` (`src/commands/install/daemon-helpers.ts`): `bun run --watch index.ts daemon --port 7943`, `RunAtLoad` + `KeepAlive`, `WatchPaths` on `daemon.ts`/`index.ts`/`hooks/`, logs to `/tmp/swiz-daemon.log`. `--uninstall` removes it.
- **Shutdown** cleanly closes watchers, the transcript monitor, CI watches, upstream sync, the worker runtime, and the task state cache.
- **If the daemon is down, nothing breaks** — every consumer (CLI dispatch, hook cache fetches, status line) falls back to direct in-process computation; the only cost is latency.

---

## Agent Integration Layer

### The manifest (`src/manifest.ts`)

`bundledHookManifest: HookGroup[]` is the canonical hook registry. Each group: `{ event, matcher?, hooks[], scheduled? }`; each hook is either a `FileHookDef` (`file`, `timeout`, `async`, `asyncMode`, `condition`, `cooldownSeconds`, `cooldownMode`, `stacks`, `requiredSettings`) or an `InlineHookDef` (`{ hook: SwizHook }`) that runs in-process. `buildManifest()` strips the `TASK_HOOK_IDENTIFIERS` set and `Task*`/`TodoWrite`/`update_plan` matchers for agents with `tasksEnabled: false`.

### Agent definitions (`src/agents.ts`)

`AGENTS` declares per-agent metadata: settings path, config style, tool/event aliases, env-var fingerprints, and capability flags.

| Agent | Settings | Config style | Tasks | Event names (sample) |
|-------|----------|--------------|-------|----------------------|
| claude | `~/.claude/settings.json` | nested matcher groups | ✓ | `Stop`, `PreToolUse` |
| cursor | `~/.cursor/hooks.json` | flat list, wrapped `{version: 1, hooks}` | ✗ | `stop`, `preToolUse` |
| gemini | `~/.gemini/settings.json` | nested; timeouts in **ms** (×1000) | ✗ | `AfterAgent`, `BeforeTool` |
| codex | `~/.codex/hooks.json` | nested; 5-event public API | ✓ (`update_plan`) | `Stop`, `PreToolUse` |
| antigravity | `~/.gemini/antigravity-cli/hooks.json` | flat-lifecycle | ✗ | `Stop`, `PreInvocation` |

Translation is metadata-driven (`translateEvent`, `translateMatcher`, `toolNameForCurrentAgent`); nothing hard-codes agent tool/event names. Runtime agent detection (`src/agent-paths.ts`, re-exported by `src/detect.ts`) resolves in precedence order: explicit `--agent`/`_agent` field → env vars (`detectCurrentAgentFromEnv`) → parent `processPattern` → Codex payload fingerprinting.

### Installation (`src/commands/install/`)

`swiz install` reads each agent's settings file, strips previously swiz-managed entries, and writes one dispatch entry per non-scheduled manifest event:

```json
{ "type": "command",
  "command": "command -v swiz >/dev/null 2>&1 || exit 0; swiz dispatch --agent claude stop Stop",
  "timeout": 180 }
```

The `command -v` guard makes hooks no-ops if swiz is uninstalled. Writes are verified after a 1.5s delay to detect agents reverting the file. `sessionstart-self-heal` re-installs missing entries; `swiz doctor` verifies sync, callability, and permissions. `installProjectHooks` keeps `.swiz/config.json` carrying the scheduled (`preCommit`/`commitMsg`/`prePush`) groups wired through `lefthook.yml`.

---

## Debugging

- **Captures**: `/tmp/swiz-incoming/` — recent raw + normalized payloads per event (10 min window). Inspect with `src/dispatch/incoming-inspect.ts` tooling.
- **Dispatch log**: `/tmp/swiz-dispatch.log` — per-hook timing/status; slow hooks (>3s) flagged.
- **Daemon log**: `/tmp/swiz-daemon.log`.
- **Replay**: `swiz dispatch <event> --replay [--json]` runs the chain without emitting a live response ([details](./dispatch-engine.md#replay-mode--swiz-dispatch-event---replay)).
- **Diagnosing dispatch failures**: first determine which path ran (daemon vs CLI fallback — check the dispatch log and daemon health); the two paths differ in env handling, caching, and timeout budgets.

## See also

- [`dispatch-engine.md`](./dispatch-engine.md) — engine internals: matching, execution, strategies, filtering, output contract
- [`commands.md`](./commands.md) — CLI command reference
- [`auto-steer-cases.md`](./auto-steer-cases.md) — auto-steer message queue behaviour
- [`humanisation.md`](./humanisation.md) — LLM rewriting of hook output
