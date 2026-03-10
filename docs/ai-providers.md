# AI Providers

How `idea`, `reflect`, and `continue` resolve and call AI backends.

---

## Provider Layer (`src/ai-providers.ts`)

All AI-powered commands import from `src/ai-providers.ts` instead of calling provider SDKs directly. The module provides three unified functions:

| Function | Description |
|----------|-------------|
| `promptText(prompt, options?)` | Single-turn prompt → trimmed string |
| `promptStreamText(prompt, options?)` | Streamed prompt → trimmed string (calls `onTextPart` for each delta) |
| `promptObject<T>(prompt, schema, options?)` | Structured generation → Zod-validated object |

All three share the same provider resolution logic. They throw if no provider is available.

---

## Provider Resolution

Resolution runs in priority order on every call:

```
1. options.provider (explicit per-call override)
2. AI_PROVIDER env var ("gemini" | "codex" | "claude")
3. Auto-select: Gemini → Codex CLI → Claude Code
```

`activeProvider(override?)` in `src/ai-providers.ts` implements this. It throws an error (with a descriptive message) if an explicit override requests a provider that is not currently available.

### Available providers

| Provider ID | Availability check | Default model |
|-------------|-------------------|---------------|
| `gemini` | `GEMINI_API_KEY` env var OR `gemini` CLI in PATH | `gemini-flash-latest` |
| `codex` | `codex` CLI in PATH | `codex-mini-latest` |
| `claude` | `claude` CLI in PATH | `sonnet` |

`hasAiProvider()` returns true if any one of these is available.

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

Default timeout for all AI commands: **90 000 ms** (90 seconds).

---

## CLI Flags

`idea`, `reflect`, and `continue` all accept:

| Flag | Short | Description |
|------|-------|-------------|
| `--provider <id>` | `-p` | Force a specific provider (`gemini`, `codex`, `claude`) |
| `--model <id>` | | Override the model identifier for the selected provider |
| `--timeout <ms>` | | Override the 90 000 ms default |

`--provider` is validated at parse time: values other than `"gemini"`, `"codex"`, or `"claude"` throw `'must be "gemini", "codex", or "claude"'`.

---

## Command Behaviour

### `swiz idea`

Proposes a creative GitHub issue for the current project.

**Inputs:**
- `README.md` (up to 24 000 chars) from `--dir` or `process.cwd()`
- Last 8 commit messages from `git log --oneline -8`

**AI call:** `promptObject(prompt, IssueIdeaSchema, { provider, model, timeout })` — structured generation returning a validated `IssueIdea` object.

**Output:** formatted Markdown with title, summary, implementation tasks, acceptance criteria, and labels printed to stdout.

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

See also:
- [`commands.md`](./commands.md) — full command reference including `idea`, `reflect`, and `continue`
- [`dispatch-engine.md`](./dispatch-engine.md) — how hook events are dispatched at runtime
