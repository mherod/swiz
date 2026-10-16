# AI Providers

How `idea`, `reflect`, `continue`, auto-reply, and steering resolve and call AI backends.

---

## Provider Layer (`src/ai-providers.ts`)

All AI-powered commands import from `src/ai-providers.ts` instead of calling provider SDKs directly. The module provides three unified functions:

| Function | Description |
|----------|-------------|
| `promptText(prompt, options?)` | Single-turn prompt → trimmed string |
| `promptStreamText(prompt, options?)` | Streamed prompt → trimmed string (calls `onTextPart` for each delta) |
| `promptObject<T>(prompt, schema, options?)` | Structured generation → Zod-validated object |
| `withProviderModel(operation, options?)` | Message/tool operations with the same provider priority and fallbacks |

All three share the same provider resolution logic. They throw if no provider is available.

---

## Provider Resolution

Resolution runs in priority order on every call:

```
1. options.provider (explicit per-call override)
2. AI_PROVIDER env var ("gemini" | "claude" | "openrouter" | "codex" | "agy")
3. options.preferredProvider (first automatic choice, when available)
4. Remaining providers: Codex CLI → OpenRouter → Claude Code → Gemini → agy
```

The generation APIs in `src/ai-providers.ts` apply this order. They throw an error (with a descriptive message) if an explicit override requests a provider that is not currently available.

Generation calls use these command defaults, skipping unavailable providers and trying the remaining providers on failure within the shared 15-second budget:

| Command | Automatic provider order |
|---------|--------------------------|
| Idea | agy → Codex → OpenRouter → Claude → Gemini |
| Auto-reply | Codex → OpenRouter → Claude → Gemini → agy |
| Steering | Claude → Codex → OpenRouter → Gemini → agy |

Explicit `--provider`/`options.provider` or `AI_PROVIDER` overrides still select only one provider. Other commands retain the general Codex-first order; `activeProvider()` reports that general order without a command preference.

### Available providers

| Provider ID | Availability check | Default model |
|-------------|-------------------|---------------|
| `gemini` | `GEMINI_API_KEY` env var OR `gemini` CLI in PATH | `gemini-flash-latest` |
| `codex` | `codex` CLI in PATH | `CODEX_MODEL` or `gpt-6-sol` |
| `claude` | `claude` CLI in PATH | `sonnet` |
| `openrouter` | `OPENROUTER_API_KEY` env var | `openrouter/auto` |
| `agy` | `agy` CLI in PATH | `AGY_MODEL` or `gemini-3.8-flash-low` |

`hasAiProvider()` returns true if any one of these is available.

### Codex CLI provider

Uses [`ai-sdk-provider-codex-cli`](https://github.com/ben-vargas/ai-sdk-provider-codex-cli) 2.3.0, the AI SDK v7 provider, through `createCodexExec`. Install a current Codex CLI (the provider targets 0.156.x), make `codex` available in PATH, and authenticate with `codex login` or `OPENAI_API_KEY`.

```sh
swiz idea --provider codex --model gpt-6-sol
swiz reflect --provider codex
AI_PROVIDER=codex swiz continue --print
```

Per-call `model` / supported `--model` flags take precedence over `CODEX_MODEL`, then `gpt-6-sol`. Codex is the default when installed. If unavailable or generation fails, automatic selection falls back to OpenRouter, Claude Code, Gemini, then agy, skipping unavailable providers. An explicit selection does not fall back to another provider.

Each prompt runs the resolved PATH executable in read-only mode with approval policy `never`. Generation disables shell execution, agents, apps, plugins, browser/computer/image tools, web search, hooks, memories, and skill discovery. A Bun launcher runs in a temporary directory with `--ignore-user-config --ephemeral`, preventing inherited project/user MCP configuration while retaining CLI authentication. These flags require a current CLI (verified with 0.162.1); unsupported flags fail rather than silently dropping the controls. Package-manager fallback is disabled. The launcher forwards cancellation to the child and removes its temporary directory afterward.

The adapter uses the existing timeout/abort handling and supplies native JSON Schema for `promptObject`, followed by Zod validation. Exec-mode streaming delivers completed messages rather than incremental tokens. `continue --provider codex` selects the suggestion backend; it does not change the command's Claude session-resumption behavior.

The provider documents Node.js >=22; Swiz runs its adapter under Bun and tests the actual subprocess protocol with a fake executable, including text, streaming, structured output, errors and cancellation. Authentication and model availability still depend on the installed Codex CLI and account.

### Claude Code provider

Uses [`ai-sdk-provider-claude-code`](https://github.com/ben-vargas/ai-sdk-provider-claude-code) 4.3.3 through the Claude Agent SDK, compatible with AI SDK v7. Claude is available as a fallback after Codex and OpenRouter, or explicitly via `--provider claude` / `AI_PROVIDER=claude`. The default model is `sonnet`.

Text, streaming, and structured generation use the shared provider layer. Structured requests pass the Zod schema as native JSON Schema to Claude and validate the returned object; schema-less JSON mode is not supported by this provider. The adapter runs with Bun, noninteractive permissions, and the existing authenticated Claude installation.

Generation sets native `tools: []`, `settingSources: []`, `strictMcpConfig: true`, and an empty MCP server map. This removes built-in tools and inherited MCP servers. AI SDK `toolChoice` and step limits alone do not constrain either CLI provider's internal agent loop.

### Antigravity CLI (`agy`) provider

`src/agy-provider.ts` implements the AI SDK v4 language-model contract used by AI SDK v7. It invokes the authenticated `agy` executable directly with `--print` and validates its JSON completion envelope. Select it with `swiz idea --provider agy` or `AI_PROVIDER=agy`; `--model` / per-call `model` overrides `AGY_MODEL`, then `gemini-3.8-flash-low`.

Each request uses a temporary working directory and a custom primary agent whose native allowlist contains only `finish`, with command execution off and no declared MCP servers, skills, or plugins. Slash-command expansion is disabled and terminal sandboxing is enabled. Authentication remains with the installed CLI. The shared abort signal sends SIGINT, escalates to SIGKILL after 250ms, awaits process exit, and removes the temporary directory. No separate CLI timeout overrides the caller's budget.

Text and structured generation use the same SDK path; JSON schemas are included in the prompt and returned objects are validated locally with Zod. Streaming is buffered: one delta is emitted only after successful completion. Non-text messages and SDK tool declarations are rejected.

Native controls follow the [custom-agent documentation](https://www.antigravity.google/docs/subagents/); response parsing follows the [headless protocol](https://www.antigravity.google/docs/cli/headless/). Live nonce-read probes returned `UNAVAILABLE`, including without a no-tools instruction in the agent prompt. The CLI's init event still lists its broad tool inventory, so that inventory is not evidence of the effective allowlist. These probes are limited verification, not a full sandbox audit or a claim that global lifecycle hooks cannot run.

### Gemini key bootstrap

Gemini supports two auth paths:
1. **API key**: `GEMINI_API_KEY` env var (or macOS Keychain entry with service `GEMINI_API_KEY`, account `default`).
2. **OAuth**: `gemini` CLI in PATH with cached `~/.gemini/` credentials.

Call `ensureGeminiApiKey()` at command startup to populate `GEMINI_API_KEY` from the Keychain before calling `hasGeminiApiKey()`. It is a no-op when the env var is already set.

```ts
// Startup pattern used by idea, reflect, continue
await ensureGeminiApiKey()
if (!hasAiProvider()) throw new Error("No AI provider available")
```

### Gemini provider internals (`src/gemini.ts`)

`createProvider()` selects auth type:
- `GEMINI_API_KEY` set → `authType: "api-key"`
- Otherwise → `authType: "oauth-personal"` (uses cached `~/.gemini/` credentials)

Built on `ai-sdk-provider-gemini-cli` from the AI SDK ecosystem.

---

## Timeout and Abort

Every prompt function accepts `options.timeout` (milliseconds) or `options.signal` (AbortSignal). When `timeout` is set, an internal `AbortController` is created and the timer is cleared in the `finally` block. `signal` takes precedence over `timeout` when both are provided.

`idea`, each auto-reply generation pass, and the complete steering humanisation fallback chain default to **15 000 ms** (15 seconds). Other AI callers retain their existing defaults. Explicit timeout overrides remain supported. Provider cancellation cleanup may add shutdown time beyond the generation deadline.

---

## CLI Flags

`idea`, `reflect`, and `continue` all accept:

| Flag | Short | Description |
|------|-------|-------------|
| `--provider <id>` | `-p` for `idea`/`continue` | Force a specific provider (`gemini`, `claude`, `openrouter`, `codex`, `agy`) |
| `--model <id>` | | Override the model identifier for the selected provider |
| `--timeout <ms>` | | Override the default (15 000 ms for `idea`, 90 000 ms for `reflect`) |

`--provider` is validated at parse time by the shared `parseAiProvider()` helper. `mergetool` also accepts `--provider`. `reflect -p` remains its print-prompt flag; use `reflect --provider codex` for provider selection. `--model` and `--timeout` apply to `idea` and `reflect`; `continue` accepts `--provider` only.

---

## Command Behaviour

### `swiz idea`

Proposes a creative GitHub issue for the current project.

**Inputs:**
- `README.md` (up to 8 000 chars) from `--dir` or `process.cwd()`
- Last 8 commit messages from `git log --oneline -8`

**AI call:** `promptObject(prompt, IssueIdeaSchema, { provider, model, timeout, reasoning: "low", structuredOutput: "prompt" })`. The shared SDK runner includes the schema in the prompt and requests JSON in one text response, avoiding Claude's additional native structured-output loop. It parses JSON and validates every required field with Zod before returning. Native schema mode remains the default for other callers; Gemini retains its existing native object runner. The prompt asks for a compact brief with four implementation tasks and three acceptance criteria.

**Output:** formatted Markdown with title, summary, implementation tasks, acceptance criteria, and labels printed to stdout. `--json` prints exactly one validated JSON object; failed generation or validation prints no partial JSON. Both modes use the same validated generation result. Prompt JSON mode trades provider-side schema enforcement for lower latency; malformed output fails visibly rather than being repaired or fabricated locally.

**Fallback:** throws `"No AI provider available"` when `hasAiProvider()` is false after startup.

### `swiz reflect [count]`

Identifies mistakes in a recent session transcript.

**Inputs:**
- Session transcript JSONL (last session for `--dir` unless `--session` selects a specific one)
- Up to 48 000 chars of transcript content
- `count` (default: 5) — exact number of mistakes to identify

**AI call:** `promptObject(prompt, SessionReflectionSchema(count), { provider, model, timeout })` for structured output, or `promptStreamText` when `--json` is not set (streams text to stderr with a `Buffering streamed response:` progress indicator).

**Output:**
- Default: numbered list of mistakes with label, what happened, why wrong, and what to do instead
- `--json`: raw structured JSON to stdout
- `--print-prompt`: prints the generated prompt to stdout and exits without calling the AI

**Fallback:** throws `"No AI provider available"` when `hasAiProvider()` is false.

### `swiz continue`

Resumes the most recent session with an AI-generated next-step suggestion.

**Inputs:**
- Session transcript JSONL (last session for `--dir` unless `--session` selects one)
- Last 20 conversation turns

**AI call:** `promptText(prompt, { provider })` via the ai-providers layer.

**Unique fallback:** when no AI SDK provider is configured (`!hasAiProvider()` and no explicit `--provider`), `continue` falls back to `promptAgent()` from `src/agent.ts`, which spawns the Cursor agent CLI or the `claude` CLI. This fallback is not available in `idea` or `reflect`.

**Output:** the AI-generated next step is passed as the `--continue` argument to a new `claude` session (or printed when `--print-only` is set).

### Auto-reply and steering previews

`swiz transcript --auto-reply` generates follow-up messages using Codex first, then the usual available fallbacks. `AI_PROVIDER` selects one provider explicitly. Both CLI providers use the generation controls above; API fallbacks receive no function tools. Replies use the supplied conversation as evidence. Stream errors, cancellations, and empty responses fail visibly instead of producing an empty reply list.

Use `swiz transcript --auto-reply --print` to print generated replies without scheduling or sending them. Transcript selection flags such as `--codex` select the source transcript, not the generation provider.

Steering humanisation prefers Claude, then uses the remaining shared provider priority, and respects `AI_PROVIDER`. Its complete fallback chain has a 15-second budget before using a deterministic local rewrite. A bare `Continue` stays `Please continue, thanks.` without a model request. Rewrites must preserve the input scope, not invent extra tasks, checks, commits, or pushes. `bun scripts/debug-humanise-autosteer.ts` previews rewrites without scheduling them.

The defaults can be overridden with `humaniseAutoSteerMessage(text, { timeoutMs })`, `streamAutoReply(..., { timeout })`, or `idea --timeout <ms>`. Abort cleanup can add process shutdown time after the generation deadline.

#### Live comparison (2026-10-15)

One sequential sample per operation/provider, fresh prompt caches, explicit provider selection, default models (`sonnet` and `gpt-6-sol`), and a 15-second generation deadline. These are preview calls: no replies or steering messages were scheduled. Times below include process startup/shutdown and are not latency percentiles.

| Operation | Claude | Codex |
|---|---|---|
| Idea from Swiz README/recent commits | Timed out; 17.789s including abort cleanup | Timed out; 15.263s including abort cleanup |
| Auto-reply for unfinished deduplication tests | 4.882s; verbose directive, added full-suite/edge-case scope | 5.861s; concise directive to add and run the requested tests |
| Steering rewrite requesting deduplication tests | 2.717s; added “real quick” | 3.845s; preserved scope with clean wording |

Both steering outputs were found in the fresh model-response cache, confirming model generation rather than the deterministic local fallback. Both providers returned `UNAVAILABLE` when asked to read an unpredictable nonce from a temporary file; Codex also returned `UNAVAILABLE` when asked to execute a shell command. These probes supplement configuration regression tests, not a comprehensive sandbox audit. Neither provider produced a valid idea within the deadline. Claude's 2.8-second cancellation cleanup means this is not a hard 15-second wall-clock guarantee.

After the idea latency fix (same day, same models and 15-second deadlines):

| Operation | Claude | Codex |
|---|---|---|
| Idea | 12.348s, validated JSON | 11.936s, validated JSON |
| Auto-reply | 4.138s | 4.180s |
| Steering | 2.757s, model response | 3.879s, model response |

All six finished successfully, including process startup/shutdown. A second fresh idea sample also passed: Claude 11.926s, Codex 13.591s. This is a small live sample, not a latency guarantee. Codex's idea proposed visible provider fallback attribution; Claude proposed hook health diagnostics. The shorter README excerpt limits project coverage, so proposals still need review against existing features.

After the defaults shipped in `17d80edb`, a fresh comparison omitted all CLI/API timeout overrides and the outer subprocess timeout:

| Operation | Claude | Codex |
|---|---|---|
| Idea | 12.757s, validated JSON | 14.671s, validated JSON |
| Auto-reply | 4.953s | 4.123s |
| Steering | 2.688s, model response | 4.212s, model response |

All six succeeded with empty stderr. Fresh steering cache entries confirmed model generation. No messages were scheduled or sent. Codex idea had only 0.329s of wall-clock margin; these results verify the defaults on this sample without establishing a latency guarantee.

#### Three-provider comparison (2026-10-16)

Sequential preview calls with matching inputs, fresh caches, explicit provider selection, and no CLI/API/outer-process timeout overrides. Models: agy `gemini-3.8-flash-low`, Claude `sonnet`, Codex `gpt-6-sol`. Times include process startup and shutdown; one sample per cell.

| Operation | agy | Claude | Codex |
|---|---|---|---|
| Idea | 10.243s | 11.331s | 9.914s |
| Auto-reply | 6.861s | 5.508s | 5.075s |
| Steering | 7.842s | 3.536s | 4.405s |

All nine finished within 15 seconds, with exit zero and empty stderr. All ideas passed the full schema; all steering outputs matched fresh model-response cache entries. No messages were scheduled or sent. Ideas proposed session discovery (agy/Claude) and cross-agent task resumption (Codex); these are suggestions, not verified feature gaps. agy and Codex auto-replies stayed focused on the requested tests; Claude expanded into optional edge cases. agy and Claude steering added “real quick”; Codex preserved the request most directly. This sample does not establish latency guarantees or overall model quality.

---

## Test Seams

Commands use env vars to inject test responses without calling real AI backends:

| Env var | Scope | Effect |
|---------|-------|--------|
| `GEMINI_API_KEY=test-key` | Gemini | Enables Gemini path; combine with `GEMINI_TEST_RESPONSE` for fixture response |
| `GEMINI_TEST_RESPONSE=<json>` | Gemini | Returns the JSON string as the model response (bypasses real API call) |
| `GEMINI_TEST_CAPTURE_FILE=<path>` | Gemini | Writes the generated prompt to the given file for inspection |
| `GEMINI_TEST_THROW=1` | Gemini | Makes the Gemini call throw (simulates API error) |
| `AI_TEST_RESPONSE=<json>` | All providers | Returns parsed JSON as `promptObject` response (cross-provider fixture) |
| `AI_TEST_TEXT_RESPONSE=<text>` | All providers | Returns trimmed string as `promptText`/`promptStreamText` response |
| `AI_TEST_NO_BACKEND=1` | All providers | Forces `hasAiProvider()` → false; simulates no-backend environment |

---

## Agent CLI Fallback (`src/agent.ts`)

`promptAgent(prompt, options?)` is used by `continue` when no AI SDK provider is available.

Detection order (`detectAgentCli()`):
1. `agent` CLI (Cursor) — if `Bun.which("agent")` is truthy
2. `claude` CLI — skipped when `CLAUDECODE=1` env var is set (prevents self-recursion)
3. `gemini` CLI — if `Bun.which("gemini")` is truthy

`promptAgent` spawns the detected CLI, writes the prompt to stdin, and returns trimmed stdout. Throws if no backend is found or the CLI exits non-zero.

---

---

## Self-Directed Loop

A **self-directed loop** is the pattern where a swiz-enabled agent consumes its own outputs to generate its next requirements and implementation direction — without waiting for an external spec or human prompt.

### Definition

| Term | Meaning |
|------|---------|
| **self-directed loop** | The closed-loop state where `swiz idea` or `swiz continue` output feeds directly back into the agent as the next instruction, causing the system to expand under its own momentum. |
| **self-specifying** | A feature or change whose requirements are derived entirely from the system's own prior outputs (e.g. a roadmap item generated by `swiz idea` that is then implemented by the same session). |

These are the canonical terms for internal docs, PRs, and stand-ups. They replace informal candidates (`auto-vibed`, `vibe-specced`) that were considered but rejected for being too slang-like for engineering documentation.

### When each term applies

- Use **self-directed loop** to describe the runtime pattern: the overall cycle where output becomes input.
- Use **self-specifying** as an adjective to describe a specific change whose spec was AI-generated (e.g. "this PR is self-specifying — the issue was created by `swiz idea`").
- Fall back to plainer language ("agent loop", "AI-generated next step", "self-directed") in contexts where the full term would require explanation.

### How it relates to `idea` and `continue`

```
swiz idea          →  proposes a GitHub issue from README + recent commits
                               ↓
agent implements it  →  commits and pushes the change
                               ↓
swiz continue      →  reads the transcript, proposes the next step
                               ↓
agent implements it  →  the loop continues without external input
```

This cycle is the self-directed loop in practice. Each invocation of `swiz idea` or `swiz continue` is a single turn; the loop emerges when they chain without a human issuing new instructions.

### Usage examples

**In a PR description:**
> This change is self-specifying: the issue was generated by `swiz idea` from the project README, and the implementation followed directly from the acceptance criteria it produced.

**In a commit message or standup:**
> Ran a self-directed loop for ~4 sessions: `swiz idea` proposed the hook, `swiz continue` drove implementation through to CI green, no manual prompts after the first session start.

### Rejected terms

| Term | Why rejected |
|------|--------------|
| `auto-vibed` | Informal; unclear in engineering contexts without explanation |
| `vibe-specced` | Same; sounds like slang and would require a definition footnote every time |

---

## Reflective Mode Loop

When `ambitionMode` is set to `"reflective"`, the stop-auto-continue hook runs a self-reinforcing critique cycle rather than a forward-progress cycle.

### How it works

Each stop attempt triggers the following sequence:

```
1. stop-auto-continue fires on Stop event
          ↓
2. AI extracts concrete DO/DON'T directives from the transcript ("reflections")
          ↓
3. normalizeReflectiveNextStep() converts the top reflection into a blocking next directive
          ↓
4. writeReflections() appends new directives to MEMORY.md (deduplicated)
          ↓
5. blockStopRaw() blocks stop — next session's transcript contains the new directives
          ↓
6. Next session reads directives, generates new critique → repeat
```

### `normalizeReflectiveNextStep(reflections)`

Located in `hooks/stop-auto-continue.ts`. Takes the first reflection from the AI response and maps it to a blocking `next` directive:

| Reflection prefix | Blocking directive |
|-------------------|--------------------|
| `DO: X` | `"Apply this confirmed reflection immediately in code: X"` |
| `DON'T: X` | `"Avoid this confirmed anti-pattern in the next code change: X"` |
| Other | `"Apply this confirmed reflection immediately in code: <text>"` |

This override replaces any `next` value the AI produced — the top reflection always drives the next block reason in reflective mode.

### `writeReflections(cwd, reflections)`

Appends new directives to `MEMORY.md` under `## Confirmed Patterns`, with:

- **Deduplication**: Checks first ~60 chars of each reflection (after stripping `DO:`/`DON'T:` prefix) against existing content. Already-present directives are skipped.
- **Line cap**: Stops appending once `MEMORY.md` approaches ~200 lines.
- **Format**: Each entry is written as a bold `**DO**` or `**DON'T**` directive.

This call is **unconditional** when reflections are non-empty — it fires regardless of whether the stop is blocked.

### When the loop is expected behavior

The reflective mode loop is intentional. When all real work is committed and pushed, the cycle shifts to meta-improvement: the AI critiques its own prior session behavior, writes the strongest directives to `MEMORY.md`, and blocks stop until the directives are acted on.

The loop terminates naturally when the AI runs out of high-signal directives to extract. It is not an error to be fixed.

### When to investigate

Investigate if:
- The same directive appears repeatedly across many sessions (dedup should prevent this — check `writeReflections` dedup logic)
- Stop is blocked with an empty or nonsensical `next` value (check `normalizeReflectiveNextStep` edge cases)
- `MEMORY.md` grows past the 200-line cap (compaction via `/compact-memory` is needed)

---

---

## Codex and Task Storage

Codex sessions have `tasksEnabled: false` in `src/agents.ts`. This means task-governance hooks skip Codex sessions entirely — `pretooluse-task-governance.ts` does not enforce task buffers, and `stop-incomplete-tasks` does not block Codex stop events.

### Canonical task root

Stop hooks that read task state (including `stop-incomplete-tasks`) always resolve task files through `getSessionTasksDir()` in `src/tasks/task-recovery.ts`, which points to `~/.claude/tasks/<session_id>/`. This is true regardless of which agent triggered the hook.

The provider adapters expose their own `tasksDir` (e.g., `~/.codex/tasks/` for Codex), but that path is used only by `createDefaultTaskStore()` / `getProviderTaskRoots()` for runtime task I/O — it is **not** the path stop hooks read.

| Context | Path used |
|---------|-----------|
| Stop hook task reads | `~/.claude/tasks/<session_id>/` |
| Codex runtime task I/O | `~/.codex/tasks/<session_id>/` |

### Troubleshooting a stop block

When `stop-incomplete-tasks` blocks and shows a `session_id`, locate the task files at:

```
~/.claude/tasks/<session_id>/
```

List task state with `swiz tasks --session <session_id>` rather than reading JSON files directly. To resolve incomplete tasks, use `TaskUpdate` (not direct file edits) — direct edits bypass validation and may leave the task store in an inconsistent state.

If you are running a Codex session and still hit a task block, the session may have been partially attributed to a prior Claude session. Check `~/.claude/tasks/` for a session directory whose ID matches the one in the block message.

See also:
- [`commands.md`](./commands.md) — full command reference including `idea`, `reflect`, and `continue`
- [`dispatch-engine.md`](./dispatch-engine.md) — how hook events are dispatched at runtime
