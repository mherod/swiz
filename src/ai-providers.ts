// Unified AI provider layer built on AI SDK v7.
//
// Dispatches text/stream/object generation to whichever provider is available:
//   1. Codex (via codex CLI in PATH)
//   2. OpenRouter (via OPENROUTER_API_KEY)
//   3. Claude Code (via claude CLI in PATH)
//   4. Gemini (via GEMINI_API_KEY or gemini CLI OAuth)
//   5. Antigravity (via agy CLI in PATH)
//
// Provider override (highest to lowest precedence):
//   1. options.provider passed to each prompt function
//   2. AI_PROVIDER env var ("gemini" | "claude" | "openrouter" | "codex" | "agy")
//   3. Auto-select: Codex, OpenRouter, Claude Code, Gemini, then agy
//
// Usage:
//   import { hasAiProvider, promptText, promptStreamText, promptObject } from "./ai-providers.ts"
//
// Commands should import from this module instead of directly from gemini.ts.
// Gemini-specific helpers (ensureGeminiApiKey, hasGeminiApiKey, promptGemini*, etc.)
// remain in gemini.ts for backward compatibility and direct use when needed.

import { dirname, join } from "node:path"
import type { LanguageModel } from "ai"
import { memoize } from "lodash-es"
import { type ZodType, z } from "zod"
import { createAgyModel } from "./agy-provider.ts"
import type { BaseAiPromptOptions } from "./ai-prompt-options.ts"
import { resetShutdownController, resolveSignal } from "./ai-signal.ts"
import { readAiTextStream } from "./ai-stream.ts"
import {
  ensureGeminiApiKey,
  getGeminiModel,
  hasGeminiApiKey,
  type PromptGeminiOptions,
  type PromptGeminiStreamOptions,
  promptGemini,
  promptGeminiObject,
  promptGeminiStreamText,
} from "./gemini.ts"

// Re-export for backward compatibility
export { resolveSignal, resetShutdownController }

// ─── Provider types ───────────────────────────────────────────────────────────

export type AiProviderId = "gemini" | "claude" | "openrouter" | "codex" | "agy"

/** Shared by commands so CLI flags and runtime selection accept the same IDs. */
export function parseAiProvider(value: string): AiProviderId {
  if (
    value === "gemini" ||
    value === "claude" ||
    value === "openrouter" ||
    value === "codex" ||
    value === "agy"
  ) {
    return value
  }
  throw new Error(
    `--provider must be "gemini", "claude", "openrouter", "codex", or "agy", got: ${value}`
  )
}

// Shutdown signal handling moved to ai-signal.ts (breaking circular dependency)

// ─── Provider options ─────────────────────────────────────────────────────────

export interface PromptOptions extends BaseAiPromptOptions {
  /**
   * Force a specific provider. Overrides AI_PROVIDER env var and auto-selection.
   * Throws if the requested provider is not available.
   */
  provider?: AiProviderId
  /** Reasoning budget for SDK text generation when supported by the provider. */
  reasoning?: "low" | "medium" | "high"
  /** Generate JSON directly instead of a provider's structured-output agent loop; still validate. */
  structuredOutput?: "native" | "prompt"
}

export interface PromptStreamOptions extends PromptOptions {
  /** Called for each streamed text delta. */
  onTextPart?: (textPart: string) => void
}

const CLAUDE_DEFAULT_MODEL = "sonnet"
const OPENROUTER_DEFAULT_MODEL = "openrouter/auto"
const CODEX_DEFAULT_MODEL = "gpt-6-sol"
const GEMINI_KNOWN_MODELS = [
  "gemini-flash-latest",
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
] as const

function buildGeminiModelValidationError(model: string, source: string): Error {
  const valid = GEMINI_KNOWN_MODELS.join(", ")
  return new Error(
    `Invalid Gemini model "${model}" from ${source}. Valid Gemini models: ${valid}. ` +
      "Fix the configured model name and restart."
  )
}

function validateGeminiModelName(model: string | undefined, source: string): void {
  if (!model) return
  if (GEMINI_KNOWN_MODELS.includes(model as (typeof GEMINI_KNOWN_MODELS)[number])) return
  throw buildGeminiModelValidationError(model, source)
}

function validateConfiguredModelAtStartup(): void {
  // Fail fast on boot when a global Gemini model override is invalid.
  // This prevents repeated backend failures inside hooks/loops.
  const startupModel = process.env.GEMINI_MODEL
  validateGeminiModelName(startupModel, "GEMINI_MODEL")
}

validateConfiguredModelAtStartup()

/** One priority order for selection and fallback; checks stay live as PATH/env change. */
const PROVIDER_PRIORITY: readonly AiProviderId[] = [
  "codex",
  "openrouter",
  "claude",
  "gemini",
  "agy",
]

const PROVIDER_AVAILABILITY: Record<AiProviderId, { check: () => boolean; reason: string }> = {
  codex: {
    check: () => Boolean(Bun.which("codex")),
    reason: "the codex CLI is not installed or not in PATH. Install Codex and run `codex login`.",
  },
  openrouter: {
    check: () => Boolean(process.env.OPENROUTER_API_KEY),
    reason: "OPENROUTER_API_KEY is not set.",
  },
  claude: {
    check: () => Boolean(Bun.which("claude")),
    reason: "the claude CLI is not installed or not in PATH.",
  },
  gemini: {
    check: hasGeminiApiKey,
    reason: "Gemini is not available. Set GEMINI_API_KEY or authenticate via `gemini` CLI.",
  },
  agy: {
    check: () => Boolean(Bun.which("agy")),
    reason: "the agy CLI is not installed or not in PATH.",
  },
}

function isProviderAvailable(provider: AiProviderId): boolean {
  return PROVIDER_AVAILABILITY[provider].check()
}

// resolveSignal moved to ai-signal.ts

// ─── Shared generation runners ────────────────────────────────────────────────

async function runText(
  model: LanguageModel,
  prompt: string,
  options?: PromptOptions
): Promise<string> {
  const { generateText } = await import("ai")
  const { signal, cleanup } = resolveSignal(options)
  try {
    const { text } = await generateText({
      model,
      prompt,
      abortSignal: signal,
      reasoning: options?.reasoning,
    })
    signal.throwIfAborted()
    if (!text.trim()) throw new Error("AI provider returned no text.")
    return text.trim()
  } finally {
    cleanup()
  }
}

async function runStreamText(
  model: LanguageModel,
  prompt: string,
  options?: PromptStreamOptions
): Promise<string> {
  const { streamText } = await import("ai")
  const { signal, cleanup } = resolveSignal(options)
  try {
    const result = streamText({ model, prompt, abortSignal: signal })
    return await readAiTextStream(result.fullStream, signal, options?.onTextPart)
  } finally {
    cleanup()
  }
}

async function runObject<T>(
  model: LanguageModel,
  prompt: string,
  schema: ZodType<T>,
  options?: PromptOptions,
  nativeSchema = false
): Promise<T> {
  const { generateText, Output } = await import("ai")
  const { signal, cleanup } = resolveSignal(options)
  try {
    const { text } = await generateText({
      model,
      output:
        options?.structuredOutput === "prompt"
          ? undefined
          : nativeSchema
            ? Output.object({ schema })
            : Output.json(),
      prompt:
        options?.structuredOutput === "prompt"
          ? `${prompt}\nReturn only a JSON object matching this schema, without Markdown or code fences:\n${JSON.stringify(z.toJSONSchema(schema))}`
          : prompt,
      abortSignal: signal,
      reasoning: options?.reasoning,
    })
    signal.throwIfAborted()
    const parsed = JSON.parse(text)
    return schema.parse(parsed) as T
  } finally {
    cleanup()
  }
}

// ─── Per-provider model factories ────────────────────────────────────────────

async function getClaudeModel(modelId?: string): Promise<LanguageModel> {
  const { createClaudeCode } = await import("ai-sdk-provider-claude-code")
  return createClaudeCode({
    defaultSettings: {
      executable: "bun",
      permissionMode: "dontAsk",
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
    },
  }).languageModel(modelId ?? CLAUDE_DEFAULT_MODEL)
}

async function getCodexModel(modelId?: string): Promise<LanguageModel> {
  const { createCodexExec } = await import("ai-sdk-provider-codex-cli")
  const codexPath = Bun.which("codex")
  if (!codexPath) throw new Error("The codex CLI is not installed or not in PATH.")
  return createCodexExec({
    defaultSettings: {
      codexPath: join(import.meta.dir, "utils/codex-generation-cli.ts"),
      env: {
        ...process.env,
        PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
        SWIZ_CODEX_EXECUTABLE: codexPath,
      },
      allowNpx: false,
      approvalMode: "never",
      sandboxMode: "read-only",
      skipGitRepoCheck: true,
      logger: false,
      configOverrides: {
        "features.shell_tool": false,
        "features.multi_agent": false,
        "features.multi_agent_v2": false,
        "features.apps": false,
        "features.plugins": false,
        "features.remote_plugin": false,
        "features.browser_use": false,
        "features.computer_use": false,
        "features.code_mode_host": false,
        "features.code_mode": false,
        "features.view_image": false,
        "features.workspace_dependencies": false,
        "features.tool_suggest": false,
        "features.hooks": false,
        "features.memories": false,
        "features.goals": false,
        "features.image_generation": false,
        "features.skill_search": false,
        "features.skip_host_skill_discovery": true,
        "features.sleep_tool": false,
        "tools.view_image": false,
        web_search: "disabled",
        project_doc_max_bytes: 0,
      },
    },
  }).languageModel(modelId ?? process.env.CODEX_MODEL ?? CODEX_DEFAULT_MODEL)
}

const getOpenRouter = memoize(async () => {
  const { createOpenRouter } = await import("@openrouter/ai-sdk-provider")
  return createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })
})

async function getOpenRouterChatModel(modelId?: string): Promise<LanguageModel> {
  const openRouterProvider = await getOpenRouter()
  return openRouterProvider.chat(modelId ?? OPENROUTER_DEFAULT_MODEL)
}

// ─── Provider capability registry ────────────────────────────────────────────

interface ProviderCapabilities {
  model: (modelId?: string) => Promise<LanguageModel>
  text: (prompt: string, options?: PromptOptions) => Promise<string>
  streamText: (prompt: string, options?: PromptStreamOptions) => Promise<string>
  // ZodType<unknown> is intentional: generic T is erased at registry level; callers cast via promptObject<T>
  object: (prompt: string, schema: ZodType<unknown>, options?: PromptOptions) => Promise<unknown>
}

/**
 * Wire an SDK model factory to the shared runners without caching request models.
 * Example: createSdkCapabilities(getCodexModel, true) enables native JSON schemas.
 */
function createSdkCapabilities(
  createModel: (modelId?: string) => LanguageModel | Promise<LanguageModel>,
  nativeSchema = false
): ProviderCapabilities {
  return {
    model: async (modelId) => createModel(modelId),
    text: async (prompt, options) => runText(await createModel(options?.model), prompt, options),
    streamText: async (prompt, options) =>
      runStreamText(await createModel(options?.model), prompt, options),
    object: async (prompt, schema, options) =>
      runObject(await createModel(options?.model), prompt, schema, options, nativeSchema),
  }
}

/** SDK providers share wiring; Gemini retains its API-key/CLI-specific generation path. */
const PROVIDER_REGISTRY: Record<AiProviderId, ProviderCapabilities> = {
  agy: createSdkCapabilities(createAgyModel, true),
  codex: createSdkCapabilities(getCodexModel, true),
  gemini: {
    model: getGeminiModel,
    text: (prompt, options) => promptGemini(prompt, options as PromptGeminiOptions),
    streamText: (prompt, options) =>
      promptGeminiStreamText(prompt, options as PromptGeminiStreamOptions),
    object: (prompt, schema, options) =>
      promptGeminiObject(prompt, schema, options as PromptGeminiOptions),
  },
  claude: createSdkCapabilities(getClaudeModel, true),
  openrouter: createSdkCapabilities(getOpenRouterChatModel),
}

// ─── Provider selection ───────────────────────────────────────────────────────

/**
 * Returns true when at least one AI provider is available.
 * Call `ensureGeminiApiKey()` before this to populate Gemini key from Keychain.
 *
 * Set AI_TEST_NO_BACKEND=1 to simulate "no backend" in tests.
 */
export function hasAiProvider(): boolean {
  if (process.env.AI_TEST_NO_BACKEND === "1") return false
  // Test fixtures act as mock providers — treat as available
  if (
    process.env.AI_TEST_RESPONSE !== undefined ||
    process.env.AI_TEST_TEXT_RESPONSE !== undefined ||
    process.env.GEMINI_TEST_RESPONSE !== undefined ||
    process.env.GEMINI_TEST_TEXT_RESPONSE !== undefined ||
    process.env.GEMINI_TEST_STREAM_RESPONSE !== undefined
  ) {
    return true
  }
  return PROVIDER_PRIORITY.some(isProviderAvailable)
}

/**
 * Returns the resolved provider ID, or null if none is available.
 *
 * Resolution order (highest to lowest precedence):
 *   1. `override` argument (from options.provider or CLI --provider flag)
 *   2. AI_PROVIDER env var ("gemini" | "claude" | "openrouter" | "codex" | "agy")
 *   3. Auto-select: Codex, OpenRouter, Claude Code, Gemini, then agy
 *
 * Throws if an explicit override requests a provider that is not available.
 */
function handleExplicitlyRequestedProvider(
  requested: AiProviderId | undefined
): AiProviderId | null {
  if (requested === undefined) return null
  if (!Object.hasOwn(PROVIDER_AVAILABILITY, requested)) {
    throw new Error(
      `Unknown AI provider "${requested}". Valid values: gemini, claude, openrouter, codex, agy.`
    )
  }
  const { check, reason } = PROVIDER_AVAILABILITY[requested]
  if (!check()) throw new Error(`AI_PROVIDER=${requested} requested but ${reason}`)
  return requested
}

export function activeProvider(override?: AiProviderId): AiProviderId | null {
  if (process.env.AI_TEST_NO_BACKEND === "1") return null

  const requested = override ?? (process.env.AI_PROVIDER as AiProviderId | undefined)

  const explicitProvider = handleExplicitlyRequestedProvider(requested)
  if (explicitProvider) {
    return explicitProvider
  }

  return PROVIDER_PRIORITY.find(isProviderAvailable) ?? null
}

// ─── Provider fallback ────────────────────────────────────────────────────────

/**
 * Returns available provider IDs in priority order (Codex → OpenRouter → Claude Code → Gemini → agy).
 * When an explicit override is set (options.provider or AI_PROVIDER env), returns only that provider.
 */
function availableProviders(override?: AiProviderId): AiProviderId[] {
  if (process.env.AI_TEST_NO_BACKEND === "1") return []

  const requested = override ?? (process.env.AI_PROVIDER as AiProviderId | undefined)
  if (requested) {
    // Explicit override — no fallback, same behavior as activeProvider()
    const primary = activeProvider(requested)
    return primary ? [primary] : []
  }

  return PROVIDER_PRIORITY.filter(isProviderAvailable)
}

/** Shared prompt preflight; keep the calling API in model-validation diagnostics. */
function providersForPrompt(source: string, options?: PromptOptions): AiProviderId[] {
  const providers = availableProviders(options?.provider)
  if (providers.length === 0) {
    throw new Error(
      "No AI provider available. Set GEMINI_API_KEY or OPENROUTER_API_KEY, or install the claude or codex CLI."
    )
  }
  if (providers.length === 1 && providers[0] === "gemini") {
    validateGeminiModelName(options?.model, `${source}(options.model)`)
  }
  return providers
}

// ─── Unified generation API ───────────────────────────────────────────────────

function rethrowNonRetryableError(error: unknown, options?: PromptOptions, emitted = false): void {
  options?.signal?.throwIfAborted()
  if (emitted || (error instanceof Error && error.name === "AbortError")) throw error
}

/** Run a message/tool operation with the same provider priority as simple prompts. */
export async function withProviderModel<T>(
  operation: (model: LanguageModel, provider: AiProviderId, signal: AbortSignal) => Promise<T>,
  options?: PromptOptions
): Promise<T> {
  const providers = availableProviders(options?.provider)
  if (providers.length === 0) throw new Error("No AI provider available.")
  const { signal, cleanup } = resolveSignal(options)
  try {
    let lastError: unknown
    for (const provider of providers) {
      signal.throwIfAborted()
      try {
        if (provider === "gemini") validateGeminiModelName(options?.model, "options.model")
        const model = await PROVIDER_REGISTRY[provider].model(options?.model)
        const result = await operation(model, provider, signal)
        signal.throwIfAborted()
        return result
      } catch (error) {
        signal.throwIfAborted()
        lastError = error
      }
    }
    throw lastError
  } finally {
    cleanup()
  }
}

/**
 * Send a single-turn prompt and return the trimmed text response.
 * Dispatches to available provider based on priority (Codex → OpenRouter → Claude → Gemini).
 * Throws if no provider is available or the request fails.
 */
export async function promptText(prompt: string, options?: PromptOptions): Promise<string> {
  const testFixture = await handleTestFixturesText(prompt, options)
  if (testFixture !== undefined) {
    return testFixture
  }
  const providers = providersForPrompt("promptText", options)

  let lastError: unknown
  for (const provider of providers) {
    try {
      return await PROVIDER_REGISTRY[provider].text(prompt, options)
    } catch (err) {
      rethrowNonRetryableError(err, options)
      lastError = err
    }
  }
  throw lastError
}

async function handleTestFixturesText(
  prompt: string,
  _options?: PromptOptions
): Promise<string | undefined> {
  if (process.env.AI_TEST_THROW === "1" || process.env.GEMINI_TEST_THROW === "1") {
    throw new Error("Simulated AI backend error (AI_TEST_THROW=1)")
  }

  const captureFile = process.env.AI_TEST_CAPTURE_FILE ?? process.env.GEMINI_TEST_CAPTURE_FILE
  if (captureFile) await Bun.write(captureFile, prompt)

  const textFixture =
    process.env.AI_TEST_TEXT_RESPONSE ??
    process.env.GEMINI_TEST_TEXT_RESPONSE ??
    process.env.GEMINI_TEST_RESPONSE
  if (textFixture !== undefined) {
    return textFixture.trim()
  }

  return undefined
}

function resolveStreamTextFixture(): string | undefined {
  if (process.env.AI_TEST_TEXT_RESPONSE !== undefined) return process.env.AI_TEST_TEXT_RESPONSE
  return (
    process.env.GEMINI_TEST_STREAM_RESPONSE ??
    process.env.GEMINI_TEST_TEXT_RESPONSE ??
    process.env.GEMINI_TEST_RESPONSE
  )
}

async function handleTestFixturesStreamText(
  prompt: string,
  options?: PromptStreamOptions
): Promise<string | undefined> {
  const fixture = resolveStreamTextFixture()
  if (fixture === undefined) return undefined

  // Capture prompt if requested (backward-compat for Gemini test fixtures)
  if (process.env.AI_TEST_TEXT_RESPONSE === undefined) {
    const captureFile = process.env.AI_TEST_CAPTURE_FILE ?? process.env.GEMINI_TEST_CAPTURE_FILE
    if (captureFile) await Bun.write(captureFile, prompt)
  }

  const text = fixture.trim()
  options?.onTextPart?.(text)
  return text
}

/**
 * Send a single-turn prompt and stream text deltas through `onTextPart`.
 * Returns the complete trimmed text when the stream ends.
 * Dispatches to available provider based on priority (Codex → OpenRouter → Claude → Gemini).
 */
export async function promptStreamText(
  prompt: string,
  options?: PromptStreamOptions
): Promise<string> {
  const testFixture = await handleTestFixturesStreamText(prompt, options)
  if (testFixture !== undefined) {
    return testFixture
  }

  const providers = providersForPrompt("promptStreamText", options)

  let lastError: unknown
  for (const provider of providers) {
    let emitted = false
    try {
      return await PROVIDER_REGISTRY[provider].streamText(prompt, {
        ...options,
        onTextPart: (part) => {
          emitted = true
          options?.onTextPart?.(part)
        },
      })
    } catch (err) {
      rethrowNonRetryableError(err, options, emitted)
      lastError = err
    }
  }
  throw lastError
}

async function handleTestFixturesObject<T>(
  prompt: string,
  _schema: ZodType<T>,
  _options?: PromptOptions
): Promise<T | undefined> {
  // Test seams (cross-provider fixtures):
  if (process.env.AI_TEST_THROW === "1" || process.env.GEMINI_TEST_THROW === "1") {
    throw new Error("Simulated AI backend error (AI_TEST_THROW=1)")
  }
  const captureFile = process.env.AI_TEST_CAPTURE_FILE ?? process.env.GEMINI_TEST_CAPTURE_FILE
  if (captureFile) {
    await Bun.write(captureFile, prompt)
  }
  const objectFixture = process.env.AI_TEST_RESPONSE ?? process.env.GEMINI_TEST_RESPONSE
  if (objectFixture !== undefined) {
    return JSON.parse(objectFixture) as T
  }
  return undefined
}

/**
 * Send a single-turn prompt and return a structured object validated against the Zod schema.
 * Dispatches to available provider based on priority (Codex → OpenRouter → Claude → Gemini).
 * Throws if no provider is available, the request fails, or validation fails.
 */
export async function promptObject<T>(
  prompt: string,
  schema: ZodType<T>,
  options?: PromptOptions
): Promise<T> {
  const testFixture = await handleTestFixturesObject(prompt, schema, options)
  if (testFixture !== undefined) {
    return testFixture
  }

  const providers = providersForPrompt("promptObject", options)

  let lastError: unknown
  for (const provider of providers) {
    try {
      return (await PROVIDER_REGISTRY[provider].object(prompt, schema, options)) as T
    } catch (err) {
      lastError = err
      // Fall through to next provider
    }
  }
  throw lastError
}

// Re-export ensureGeminiApiKey so callers only need this module for startup setup.
export { ensureGeminiApiKey }
