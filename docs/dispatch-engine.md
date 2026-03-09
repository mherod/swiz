# Swiz Dispatch Engine

`swiz dispatch <event>` fans out a hook event to all matching hook scripts. This document covers the engine internals: how hooks are matched, executed, filtered, and how results are merged back to the agent.

---

## Entry Point

`swiz dispatch <event> [--json] [--replay]` is handled by `src/commands/dispatch.ts`.

1. Reads JSON from stdin (the agent hook payload).
2. Looks up the canonical event in `DISPATCH_ROUTES` to determine which strategy to use.
3. Applies hook filters (disabled hooks, PR-merge mode, stack, state).
4. Runs the appropriate strategy (`runPreToolUse`, `runBlocking`, or `runContext`).
5. Writes a single JSON response to stdout that the agent interprets.

### `DISPATCH_ROUTES`

Defined in `src/dispatch/index.ts`. Maps canonical event names to dispatch strategies:

| Canonical event | Strategy |
|-----------------|----------|
| `preToolUse` | `preToolUse` |
| `stop` | `blocking` |
| `postToolUse` | `blocking` |
| `sessionStart` | `context` |
| `userPromptSubmit` | `context` |
| `preCompact` | `context` |
| `notification` | `context` |
| `subagentStart` | `context` |
| `subagentStop` | `blocking` |
| `sessionEnd` | `blocking` |
| `prPoll` | `blocking` |

---

## Hook Matching — `groupMatches()`

Before running, the engine evaluates whether each `HookGroup` applies to the current invocation.

```ts
// src/dispatch/engine.ts
export function groupMatches(group: HookGroup, toolName: string, trigger: string): boolean
```

A group matches when:
- **No matcher**: always matches.
- **Tool matcher** (e.g. `"Bash"`, `"Edit"`): matched via `toolMatchesToken()`, which handles cross-agent aliases (`Bash`/`Shell`, `Edit`/`Write`, task families).
- **Trigger matcher** (e.g. `"startup"`, `"compact"`): matched against the `trigger` field in the payload (used for `SessionStart`).

---

## Hook Execution — `runHook()`

Each hook is spawned as a subprocess:

```ts
export async function runHook(
  file: string,
  payloadStr: string,
  timeoutSec?: number
): Promise<{ parsed: Record<string, unknown> | null; execution: HookExecution }>
```

- **Spawn**: `bun hooks/<file>.ts` (TypeScript) or `hooks/<file>` (executable). Payload is written to stdin.
- **Timeout**: `DEFAULT_TIMEOUT = 10s`. Override per hook via `HookDef.timeout`. On timeout, the process is killed and status is set to `"timeout"`.
- **Output**: stdout is captured and parsed as JSON. stderr is captured for logging. Up to 500 chars of each are stored in the `HookExecution` as `stdoutSnippet`/`stderrSnippet`.
- **Logging**: each run is appended to `/tmp/swiz-dispatch.log` with timing and status.
- **Slow hook threshold**: hooks taking > `SLOW_HOOK_THRESHOLD_MS = 3000ms` are logged with a warning and their status is set to `"slow"`.

### `HookExecution` record

Attached to every `HookRunResult`:

```ts
interface HookExecution {
  file: string
  matcher?: string
  startTime: number
  endTime?: number
  durationMs?: number
  configuredTimeoutSec?: number
  status: HookStatus
  skipReason?: SkipReason
  exitCode?: number
  stdoutSnippet?: string
  stderrSnippet?: string
}
```

### `HookStatus` values

| Status | Meaning |
|--------|---------|
| `ok` | Ran successfully, no special decision |
| `no-output` | Exited 0 but produced no stdout |
| `allow-with-reason` | PreToolUse: allow with a hint injected into the agent |
| `deny` | PreToolUse: deny this tool call |
| `block` | Stop/PostToolUse: block the action |
| `slow` | Completed but exceeded 3000ms threshold |
| `timeout` | Killed after exceeding timeout |
| `invalid-json` | Produced non-JSON stdout |
| `error` | Subprocess spawn or I/O error |
| `skipped` | Skipped (see `SkipReason`) |

### `SkipReason` values

| Reason | Trigger |
|--------|---------|
| `condition-false` | `HookDef.condition` evaluated to false |
| `cooldown-active` | Within `HookDef.cooldownSeconds` for this `(file, cwd)` pair |

---

## Dispatch Strategies

### `launchAsyncHooks()` (shared across all strategies)

Called first in every strategy. Fires all hooks marked `async: true` immediately without awaiting their results. These hooks cannot block the agent — they are fire-and-forget side effects (e.g. notifications, analytics).

### `runPreToolUse` — Short-circuit on deny, merge hints

Used for `preToolUse` events (before a tool call executes).

**Behavior:**
1. Fire async hooks immediately.
2. For each sync hook in order:
   - Skip if condition false or cooldown active.
   - Run hook and get response.
   - If the response is a **deny**: record it, short-circuit (stop processing remaining hooks), write the deny response.
   - If the response is an **allow-with-reason**: collect the `permissionDecisionReason` hint, continue to the next hook.
   - Otherwise: pass silently.
3. If no deny occurred and hints were collected: write a merged `allow` response with all hints joined by `\n\n`.
4. Attach `hookExecutions` array to the final response for agent diagnostics.

**Output fields used by agent:**
- `hookSpecificOutput.permissionDecision`: `"allow"` | `"deny"`
- `hookSpecificOutput.permissionDecisionReason`: merged hints (when `"allow"`) or deny reason (when `"deny"`)
- `hookExecutions[]`: execution trace for all hooks run

### `runBlocking` — Block forwarding for stop/postToolUse

Used for `stop`, `postToolUse`, `subagentStop`, `sessionEnd`, `prPoll`.

**Key difference between `stop` and `postToolUse`:**
- **`stop`**: runs ALL hooks even after the first block (`runAllHooks = true`). This collects all violations. Only the first block response is forwarded to the agent, but every hook runs.
- **`postToolUse`**: short-circuits on the first block (`runAllHooks = false`).

**Behavior:**
1. Fire async hooks immediately.
2. For each sync hook in order:
   - Skip if condition false or cooldown active.
   - Run hook and get response.
   - If the response is a **block**: record it. If `runAllHooks = false`, short-circuit.
3. Write the first block response if any blocked; otherwise write `{}`.
4. Attach `hookExecutions` to the response.

**Output fields used by agent:**
- `decision: "block"` + `reason`: the block message (from the first blocking hook)
- `hookExecutions[]`: execution trace

### `runContext` — Merge additional context

Used for `sessionStart`, `userPromptSubmit`, `preCompact`, `notification`, `subagentStart`.

**Behavior:**
1. Fire async hooks immediately.
2. For each sync hook in order:
   - Skip if condition false or cooldown active.
   - Run hook. Extract `hookSpecificOutput.additionalContext` or `systemMessage` from the response.
   - Collect all non-empty context strings.
3. If any contexts collected: write merged response with all contexts joined by `\n\n`.
4. Attach `hookExecutions` to the response.

**Output fields used by agent:**
- `hookSpecificOutput.hookEventName`: the canonical event name
- `hookSpecificOutput.additionalContext`: merged context from all hooks

---

## Hook Filtering

Before dispatching, `applyHookSettingFilters()` (`src/dispatch/filters.ts`) applies up to four filters in sequence:

### 1. PR-merge mode filter

`filterPrMergeModeHooks()` removes PR-related hooks when PR-merge mode is inactive:

```
collaborationMode = "team"   → always keep PR hooks
collaborationMode = "solo"   → always remove PR hooks
collaborationMode = "auto"   → use prMergeMode boolean
```

Hooks disabled in non-PR-merge mode: `posttooluse-pr-context.ts`, `pretooluse-pr-age-gate.ts`, `stop-branch-conflicts.ts`, `stop-pr-description.ts`, `stop-pr-changes-requested.ts`, `stop-github-ci.ts`.

Exception: `pretooluse-pr-age-gate.ts` is preserved when `prAgeGateMinutes > 0` even if PR-merge mode is otherwise off.

### 2. Stack filter

`filterStackHooks()` removes hooks that declare a `stacks` restriction when none of the declared stacks are detected in the project. This allows hooks to target Next.js, Firebase, or other framework-specific projects without running on all projects.

Detection uses `detectProjectStack(cwd)` from `src/detect-frameworks.ts`.

### 3. State filter

`filterStateHooks()` reads `.swiz/state.json` and removes development-only hooks when the project is in `planning-work` or `awaiting-review` states:

- `posttooluse-git-task-autocomplete.ts`
- `pretooluse-state-gate.ts`
- `posttooluse-task-advisor.ts`

### 4. Disabled hooks filter

`filterDisabledHooks()` removes any hook in the combined disabled set from:
- `~/.swiz/settings.json` → `disabledHooks[]`
- `.swiz/config.json` → `disabledHooks[]`
- `swizNotifyHooks: false` → adds all three notification hooks to the disabled set

---

## Hook Conditions and Cooldown

### Conditions

`HookDef.condition` is an optional expression evaluated before each run. Supported operators:

- `"stack:nextjs"`, `"stack:firebase"` — true if the detected project stack includes the named framework
- `"!stack:nextjs"` — negation

If the condition is false the hook is skipped (`SkipReason: "condition-false"`).

### Cooldown

`HookDef.cooldownSeconds` enforces a minimum gap between successive runs of the same hook in the same project directory. The cooldown state is stored as a timestamp in `/tmp/swiz-hook-cooldown-<hash>.timestamp` where `<hash>` is `Bun.hash(file + cwd).toString(16)`.

If the hook was run within the cooldown window it is skipped (`SkipReason: "cooldown-active"`). After a successful run, `markHookCooldown()` writes the current timestamp.

---

## Replay Mode — `swiz dispatch <event> --replay`

`--replay` runs the full hook chain but captures a `TraceEntry[]` instead of writing the live agent response. Used for debugging or dry-run inspection.

### Replay strategies

- **`replayPreToolUse`**: sequential, short-circuits on first deny, mirrors live `runPreToolUse`.
- **`replayBlocking`**: for `stop` events, runs all hooks **in parallel** (`Promise.all`); for others (postToolUse), sequential with short-circuit.
- **`replayContext`**: runs all hooks **in parallel** (`Promise.all`), collects contexts.

### Output formats

**Text** (default): ANSI-coloured table with file, duration, status. Deny/block entries show the first 3 lines of the reason. Ends with a summary line.

**JSON** (`--json`): single object with `event`, `strategy`, `matched_groups`, `hooks[]` (file, matcher, async, duration_ms, status, reason?), and `result` (blocked/by/status or not-blocked).

---

## Hook Output Contract

Hooks must write a single JSON object to stdout and exit 0. The output format depends on event type:

### PreToolUse

```json
// Deny
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Reason shown to agent"
  }
}

// Allow with hint
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "Optional hint injected into agent context"
  }
}
```

Use `denyPreToolUse(reason)` or `allowPreToolUse(reason)` from `hooks/hook-utils.ts` — these call `process.exit(0)` and never return.

### PostToolUse / Stop / Blocking

```json
// Block
{ "decision": "block", "reason": "Reason shown to agent" }

// Pass (no output, or empty object)
{}
```

Use `blockStop(reason)` or `denyPostToolUse(reason)` from `hooks/hook-utils.ts`.

### SessionStart / UserPromptSubmit / Context

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "Context injected into agent system message"
  }
}
```

Use `emitContext(eventName, context, cwd?)` from `hooks/hook-utils.ts`.

---

## Log File

All dispatch activity is logged to `/tmp/swiz-dispatch.log`:

```
[2025-01-01T12:00:00.000Z] dispatch preToolUse (3 hook(s) matched)
   → pretooluse-require-tasks.ts [Bash]
   ✓ pretooluse-require-tasks.ts (allow)
   → pretooluse-no-as-any.ts
   ✓ pretooluse-no-as-any.ts (no output)
   result: all passed
```

Slow hooks (> 3000ms) appear with a `[slow: Xms]` annotation.

---

See also:
- [`commands.md`](./commands.md) — `dispatch` command reference
- [`ai-providers.md`](./ai-providers.md) — how AI-powered commands resolve backends
