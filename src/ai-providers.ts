// Unified AI provider layer built on AI SDK v6.
//
// Dispatches text/stream/object generation to whichever provider is available:
//   1. OpenRouter (via OPENROUTER_API_KEY)
//   2. Claude Code (via claude CLI in PATH)
//   3. Gemini (via GEMINI_API_KEY or gemini CLI OAuth)
//
// Provider override (highest to lowest precedence):
//   1. options.provider passed to each prompt function
//   2. AI_PROVIDER env var ("gemini" | "claude" | "openrouter")
//   3. Auto-select: OpenRouter preferred, then Claude Code, then Gemini
//
// Usage:
//   import { hasAiProvider, promptText, promptStreamText, promptObject } from "./ai-providers.ts"
//
// Commands should import from this module instead of directly from gemini.ts.
// Gemini-specific helpers (ensureGeminiApiKey, hasGeminiApiKey, promptGemini*, etc.)
// remain in gemini.ts for backward compatibility and direct use when needed.

import type { LanguageModel } from "ai"
import type { ZodType } from "zod"
import type { BaseAiPromptOptions } from "./ai-prompt-options.ts"
import { resetShutdownController, resolveSignal } from "./ai-signal.ts"
import {
  ensureGeminiApiKey,
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

export type AiProviderId = "gemini" | "claude" | "openrouter"

// Shutdown signal handling moved to ai-signal.ts (breaking circular dependency)

// ─── Provider options ─────────────────────────────────────────────────────────

export interface PromptOptions extends BaseAiPromptOptions {
  /**
   * Force a specific provider. Overrides AI_PROVIDER env var and auto-selection.
   * Throws if the requested provider is not available.
   */
  provider?: AiProviderId
}

export interface PromptStreamOptions extends PromptOptions {
  /** Called for each streamed text delta. */
  onTextPart?: (textPart: string) => void
}

const CLAUDE_DEFAULT_MODEL = "sonnet"
const OPENROUTER_DEFAULT_MODEL = "stepfun/step-3.5-flash:free"
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

function hasClaudeCode(): boolean {
  if (process.env.AI_TEST_NO_BACKEND === "1") return false
  return Boolean(Bun.which("claude"))
}

function hasOpenRouterApiKey(): boolean {
  if (process.env.AI_TEST_NO_BACKEND === "1") return false
  return Boolean(process.env.OPENROUTER_API_KEY)
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
    const { text } = await generateText({ model, prompt, abortSignal: signal })
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
    let text = ""
    for await (const part of result.textStream) {
      text += part
      options?.onTextPart?.(part)
    }
    return text.trim()
  } finally {
    cleanup()
  }
}

async function runObject<T>(
  model: LanguageModel,
  prompt: string,
  schema: ZodType<T>,
  options?: PromptOptions
): Promise<T> {
  const { generateText, Output } = await import("ai")
  const { signal, cleanup } = resolveSignal(options)
  try {
    const { output } = await generateText({
      model,
      output: Output.object({ schema }),
      prompt,
      abortSignal: signal,
    })
    return output
  } finally {
    cleanup()
  }
}

// ─── Per-provider model factories ────────────────────────────────────────────

async function getClaudeModel(modelId?: string): Promise<LanguageModel> {
  const { createClaudeCode } = await import("ai-sdk-provider-claude-code")
  return createClaudeCode().languageModel(modelId ?? CLAUDE_DEFAULT_MODEL)
}

async function getOpenRouterModel(modelId?: string): Promise<LanguageModel> {
  const { createOpenRouter } = await import("@openrouter/ai-sdk-provider")
  return createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY }).chat(
    modelId ?? OPENROUTER_DEFAULT_MODEL
  )
}

// ─── Provider capability registry ────────────────────────────────────────────

interface ProviderCapabilities {
  text: (prompt: string, options?: PromptOptions) => Promise<string>
  streamText: (prompt: string, options?: PromptStreamOptions) => Promise<string>
  // ZodType<unknown> is intentional: generic T is erased at registry level; callers cast via promptObject<T>
  object: (prompt: string, schema: ZodType<unknown>, options?: PromptOptions) => Promise<unknown>
}

function makeProviderCapabilities(
  getModel: (modelId?: string) => Promise<LanguageModel>
): ProviderCapabilities {
  return {
    text: (prompt, options) => getModel(options?.model).then((m) => runText(m, prompt, options)),
    streamText: (prompt, options) =>
      getModel(options?.model).then((m) => runStreamText(m, prompt, options)),
    object: (prompt, schema, options) =>
      getModel(options?.model).then((m) => runObject(m, prompt, schema, options)),
  }
}

/**
 * Maps each provider ID to its generation capability functions.
 * Adding a new provider only requires adding an entry here.
 */
const PROVIDER_REGISTRY: Record<AiProviderId, ProviderCapabilities> = {
  gemini: {
    text: (prompt, options) => promptGemini(prompt, options as PromptGeminiOptions),
    streamText: (prompt, options) =>
      promptGeminiStreamText(prompt, options as PromptGeminiStreamOptions),
    object: (prompt, schema, options) =>
      promptGeminiObject(prompt, schema, options as PromptGeminiOptions),
  },
  claude: makeProviderCapabilities(getClaudeModel),
  openrouter: makeProviderCapabilities(getOpenRouterModel),
}

// ─── Provider selection ───────────────────────────────────────────────────────

/**
 * Returns true when at least one AI provider (OpenRouter, Claude Code, or Gemini) is available.
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
  return hasGeminiApiKey() || hasClaudeCode() || hasOpenRouterApiKey()
}

/**
 * Returns the resolved provider ID, or null if none is available.
 *
 * Resolution order (highest to lowest precedence):
 *   1. `override` argument (from options.provider or CLI --provider flag)
 *   2. AI_PROVIDER env var ("gemini" | "claude" | "openrouter")
 *   3. Auto-select: OpenRouter preferred, then Claude Code, then Gemini
 *
 * Throws if an explicit override requests a provider that is not available.
 */
function handleExplicitlyRequestedProvider(
  requested: AiProviderId | undefined
): AiProviderId | null {
  if (requested === "gemini") {
    if (!hasGeminiApiKey()) {
      throw new Error(
        "AI_PROVIDER=gemini requested but Gemini is not available. Set GEMINI_API_KEY or authenticate via `gemini` CLI."
      )
    }
    return "gemini"
  }
  if (requested === "claude") {
    if (!hasClaudeCode()) {
      throw new Error(
        "AI_PROVIDER=claude requested but the claude CLI is not installed or not in PATH."
      )
    }
    return "claude"
  }
  if (requested === "openrouter") {
    if (!hasOpenRouterApiKey()) {
      throw new Error("AI_PROVIDER=openrouter requested but OPENROUTER_API_KEY is not set.")
    }
    return "openrouter"
  }
  if (requested !== undefined) {
    throw new Error(`Unknown AI provider "${requested}". Valid values: gemini, claude, openrouter.`)
  }
  return null
}

export function activeProvider(override?: AiProviderId): AiProviderId | null {
  if (process.env.AI_TEST_NO_BACKEND === "1") return null

  const requested = override ?? (process.env.AI_PROVIDER as AiProviderId | undefined)

  const explicitProvider = handleExplicitlyRequestedProvider(requested)
  if (explicitProvider) {
    return explicitProvider
  }

  // Auto-select
  if (hasOpenRouterApiKey()) return "openrouter"
  if (hasClaudeCode()) return "claude"
  if (hasGeminiApiKey()) return "gemini"
  return null
}

// ─── Provider fallback ────────────────────────────────────────────────────────

/**
 * Returns all available provider IDs in priority order (OpenRouter → Claude Code → Gemini).
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

  // Auto-select: return all available providers in priority order
  const providers: AiProviderId[] = []
  if (hasOpenRouterApiKey()) providers.push("openrouter")
  if (hasClaudeCode()) providers.push("claude")
  if (hasGeminiApiKey()) providers.push("gemini")
  return providers
}

// ─── Unified generation API ───────────────────────────────────────────────────

/**
 * Send a single-turn prompt and return the trimmed text response.
 * Dispatches to available provider based on priority (OpenRouter → Claude → Gemini).
 * Throws if no provider is available or the request fails.
 */
export async function promptText(prompt: string, options?: PromptOptions): Promise<string> {
  const testFixture = await handleTestFixturesText(prompt, options)
  if (testFixture !== undefined) {
    return testFixture
  }
  const providers = availableProviders(options?.provider)
  if (providers.length === 0) {
    throw new Error(
      "No AI provider available. Set GEMINI_API_KEY or OPENROUTER_API_KEY, or install the claude CLI."
    )
  }
  if (providers.length === 1 && providers[0] === "gemini") {
    validateGeminiModelName(options?.model, "promptText(options.model)")
  }

  let lastError: unknown
  for (const provider of providers) {
    try {
      return await PROVIDER_REGISTRY[provider].text(prompt, options)
    } catch (err) {
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
 * Dispatches to available provider based on priority (OpenRouter → Claude → Gemini).
 */
export async function promptStreamText(
  prompt: string,
  options?: PromptStreamOptions
): Promise<string> {
  const testFixture = await handleTestFixturesStreamText(prompt, options)
  if (testFixture !== undefined) {
    return testFixture
  }

  const providers = availableProviders(options?.provider)
  if (providers.length === 0) {
    throw new Error(
      "No AI provider available. Set GEMINI_API_KEY or OPENROUTER_API_KEY, or install the claude CLI."
    )
  }
  if (providers.length === 1 && providers[0] === "gemini") {
    validateGeminiModelName(options?.model, "promptStreamText(options.model)")
  }

  let lastError: unknown
  for (const provider of providers) {
    try {
      return await PROVIDER_REGISTRY[provider].streamText(prompt, options)
    } catch (err) {
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
 * Dispatches to available provider based on priority (OpenRouter → Claude → Gemini).
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

  const providers = availableProviders(options?.provider)
  if (providers.length === 0) {
    throw new Error(
      "No AI provider available. Set GEMINI_API_KEY or OPENROUTER_API_KEY, or install the claude CLI."
    )
  }
  if (providers.length === 1 && providers[0] === "gemini") {
    validateGeminiModelName(options?.model, "promptObject(options.model)")
  }

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
