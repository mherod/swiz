// Unified AI provider layer built on AI SDK v6.
//
// Dispatches text/stream/object generation to whichever provider is available:
//   1. Gemini (via GEMINI_API_KEY or gemini CLI OAuth)
//   2. Codex CLI (via codex CLI in PATH)
//
// Provider override (highest to lowest precedence):
//   1. options.provider passed to each prompt function
//   2. AI_PROVIDER env var ("gemini" | "codex")
//   3. Auto-select: Gemini preferred, Codex CLI fallback
//
// Usage:
//   import { hasAiProvider, promptText, promptStreamText, promptObject } from "./ai-providers.ts"
//
// Commands should import from this module instead of directly from gemini.ts.
// Gemini-specific helpers (ensureGeminiApiKey, hasGeminiApiKey, promptGemini*, etc.)
// remain in gemini.ts for backward compatibility and direct use when needed.

import type { ZodType } from "zod"
import {
  ensureGeminiApiKey,
  hasGeminiApiKey,
  type PromptGeminiOptions,
  type PromptGeminiStreamOptions,
  promptGemini,
  promptGeminiObject,
  promptGeminiStreamText,
} from "./gemini.ts"

// ─── Provider types ───────────────────────────────────────────────────────────

export type AiProviderId = "gemini" | "codex"

// ─── Codex provider ──────────────────────────────────────────────────────────

export interface PromptOptions {
  /** Per-call timeout in milliseconds. */
  timeout?: number
  /** External AbortSignal — takes precedence over timeout. */
  signal?: AbortSignal
  /** Model identifier. Provider-specific defaults apply when omitted. */
  model?: string
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

const CODEX_DEFAULT_MODEL = "codex-mini-latest"

function hasCodexCli(): boolean {
  if (process.env.AI_TEST_NO_BACKEND === "1") return false
  return Boolean(Bun.which("codex"))
}

function resolveSignal(options?: PromptOptions): {
  signal: AbortSignal | undefined
  cleanup: () => void
} {
  if (options?.signal) return { signal: options.signal, cleanup: () => {} }
  if (options?.timeout) {
    const controller = new AbortController()
    const handle = setTimeout(() => controller.abort(), options.timeout).unref()
    return { signal: controller.signal, cleanup: () => clearTimeout(handle) }
  }
  return { signal: undefined, cleanup: () => {} }
}

async function promptCodexText(prompt: string, options?: PromptOptions): Promise<string> {
  const { generateText } = await import("ai")
  const { createCodexCli } = await import("ai-sdk-provider-codex-cli")
  const provider = createCodexCli()
  const model = provider.languageModel(options?.model ?? CODEX_DEFAULT_MODEL)
  const { signal, cleanup } = resolveSignal(options)
  try {
    const { text } = await generateText({ model, prompt, abortSignal: signal })
    return text.trim()
  } finally {
    cleanup()
  }
}

async function promptCodexStreamText(
  prompt: string,
  options?: PromptStreamOptions
): Promise<string> {
  const { streamText } = await import("ai")
  const { createCodexCli } = await import("ai-sdk-provider-codex-cli")
  const provider = createCodexCli()
  const model = provider.languageModel(options?.model ?? CODEX_DEFAULT_MODEL)
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

async function promptCodexObject<T>(
  prompt: string,
  schema: ZodType<T>,
  options?: PromptOptions
): Promise<T> {
  const { generateText, Output } = await import("ai")
  const { createCodexCli } = await import("ai-sdk-provider-codex-cli")
  const provider = createCodexCli()
  const model = provider.languageModel(options?.model ?? CODEX_DEFAULT_MODEL)
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

// ─── Provider selection ───────────────────────────────────────────────────────

/**
 * Returns true when at least one AI provider (Gemini or Codex CLI) is available.
 * Call `ensureGeminiApiKey()` before this to populate Gemini key from Keychain.
 *
 * Set AI_TEST_NO_BACKEND=1 to simulate "no backend" in tests.
 */
export function hasAiProvider(): boolean {
  if (process.env.AI_TEST_NO_BACKEND === "1") return false
  return hasGeminiApiKey() || hasCodexCli()
}

/**
 * Returns the resolved provider ID, or null if none is available.
 *
 * Resolution order (highest to lowest precedence):
 *   1. `override` argument (from options.provider or CLI --provider flag)
 *   2. AI_PROVIDER env var ("gemini" | "codex")
 *   3. Auto-select: Gemini preferred when both are available
 *
 * Throws if an explicit override requests a provider that is not available.
 */
export function activeProvider(override?: AiProviderId): AiProviderId | null {
  if (process.env.AI_TEST_NO_BACKEND === "1") return null

  const requested = override ?? (process.env.AI_PROVIDER as AiProviderId | undefined)

  if (requested === "gemini") {
    if (!hasGeminiApiKey()) {
      throw new Error(
        "AI_PROVIDER=gemini requested but Gemini is not available. Set GEMINI_API_KEY or authenticate via `gemini` CLI."
      )
    }
    return "gemini"
  }
  if (requested === "codex") {
    if (!hasCodexCli()) {
      throw new Error(
        "AI_PROVIDER=codex requested but the codex CLI is not installed or not in PATH."
      )
    }
    return "codex"
  }
  if (requested !== undefined) {
    throw new Error(`Unknown AI provider "${requested}". Valid values: gemini, codex.`)
  }

  // Auto-select
  if (hasGeminiApiKey()) return "gemini"
  if (hasCodexCli()) return "codex"
  return null
}

// ─── Unified generation API ───────────────────────────────────────────────────

/**
 * Send a single-turn prompt and return the trimmed text response.
 * Dispatches to Gemini (preferred) or Codex CLI based on availability.
 * Throws if no provider is available or the request fails.
 */
export async function promptText(prompt: string, options?: PromptOptions): Promise<string> {
  // Test seam: AI_TEST_TEXT_RESPONSE is a cross-provider fixture
  if (process.env.AI_TEST_TEXT_RESPONSE !== undefined) {
    return process.env.AI_TEST_TEXT_RESPONSE.trim()
  }

  const provider = activeProvider(options?.provider)
  if (provider === "gemini") {
    return promptGemini(prompt, options as PromptGeminiOptions)
  }
  if (provider === "codex") {
    return promptCodexText(prompt, options)
  }
  throw new Error("No AI provider available. Set GEMINI_API_KEY or install the codex CLI.")
}

/**
 * Send a single-turn prompt and stream text deltas through `onTextPart`.
 * Returns the complete trimmed text when the stream ends.
 * Dispatches to Gemini (preferred) or Codex CLI based on availability.
 */
export async function promptStreamText(
  prompt: string,
  options?: PromptStreamOptions
): Promise<string> {
  // Test seam
  if (process.env.AI_TEST_TEXT_RESPONSE !== undefined) {
    const text = process.env.AI_TEST_TEXT_RESPONSE.trim()
    options?.onTextPart?.(text)
    return text
  }

  const provider = activeProvider(options?.provider)
  if (provider === "gemini") {
    return promptGeminiStreamText(prompt, options as PromptGeminiStreamOptions)
  }
  if (provider === "codex") {
    return promptCodexStreamText(prompt, options)
  }
  throw new Error("No AI provider available. Set GEMINI_API_KEY or install the codex CLI.")
}

/**
 * Send a single-turn prompt and return a structured object validated against the Zod schema.
 * Dispatches to Gemini (preferred) or Codex CLI based on availability.
 * Throws if no provider is available, the request fails, or validation fails.
 */
export async function promptObject<T>(
  prompt: string,
  schema: ZodType<T>,
  options?: PromptOptions
): Promise<T> {
  // Test seam: AI_TEST_RESPONSE is a cross-provider fixture (superset of GEMINI_TEST_RESPONSE)
  if (process.env.AI_TEST_RESPONSE !== undefined) {
    return JSON.parse(process.env.AI_TEST_RESPONSE) as T
  }

  const provider = activeProvider(options?.provider)
  if (provider === "gemini") {
    return promptGeminiObject(prompt, schema, options as PromptGeminiOptions)
  }
  if (provider === "codex") {
    return promptCodexObject(prompt, schema, options)
  }
  throw new Error("No AI provider available. Set GEMINI_API_KEY or install the codex CLI.")
}

// Re-export ensureGeminiApiKey so callers only need this module for startup setup.
export { ensureGeminiApiKey }
