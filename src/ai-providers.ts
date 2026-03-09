// Unified AI provider layer built on AI SDK v6.
//
// Dispatches text/stream/object generation to whichever provider is available:
//   1. Gemini (via GEMINI_API_KEY or gemini CLI OAuth)
//   2. Codex CLI (via codex CLI in PATH)
//   3. Claude Code (via claude CLI in PATH)
//
// Provider override (highest to lowest precedence):
//   1. options.provider passed to each prompt function
//   2. AI_PROVIDER env var ("gemini" | "codex" | "claude")
//   3. Auto-select: Gemini preferred, then Codex CLI, then Claude Code
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

export type AiProviderId = "gemini" | "codex" | "claude"

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
const CLAUDE_DEFAULT_MODEL = "sonnet"

function hasCodexCli(): boolean {
  if (process.env.AI_TEST_NO_BACKEND === "1") return false
  return Boolean(Bun.which("codex"))
}

function hasClaudeCode(): boolean {
  if (process.env.AI_TEST_NO_BACKEND === "1") return false
  return Boolean(Bun.which("claude"))
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

async function promptClaudeText(prompt: string, options?: PromptOptions): Promise<string> {
  const { generateText } = await import("ai")
  const { createClaudeCode } = await import("ai-sdk-provider-claude-code")
  const provider = createClaudeCode()
  const model = provider.languageModel(options?.model ?? CLAUDE_DEFAULT_MODEL)
  const { signal, cleanup } = resolveSignal(options)
  try {
    const { text } = await generateText({ model, prompt, abortSignal: signal })
    return text.trim()
  } finally {
    cleanup()
  }
}

async function promptClaudeStreamText(
  prompt: string,
  options?: PromptStreamOptions
): Promise<string> {
  const { streamText } = await import("ai")
  const { createClaudeCode } = await import("ai-sdk-provider-claude-code")
  const provider = createClaudeCode()
  const model = provider.languageModel(options?.model ?? CLAUDE_DEFAULT_MODEL)
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

async function promptClaudeObject<T>(
  prompt: string,
  schema: ZodType<T>,
  options?: PromptOptions
): Promise<T> {
  const { generateText, Output } = await import("ai")
  const { createClaudeCode } = await import("ai-sdk-provider-claude-code")
  const provider = createClaudeCode()
  const model = provider.languageModel(options?.model ?? CLAUDE_DEFAULT_MODEL)
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

// ─── Provider capability registry ────────────────────────────────────────────

interface ProviderCapabilities {
  text: (prompt: string, options?: PromptOptions) => Promise<string>
  streamText: (prompt: string, options?: PromptStreamOptions) => Promise<string>
  // ZodType<any> is intentional: generic T is erased at registry level; callers cast via promptObject<T>
  object: (prompt: string, schema: ZodType<any>, options?: PromptOptions) => Promise<unknown>
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
  codex: {
    text: promptCodexText,
    streamText: promptCodexStreamText,
    object: promptCodexObject,
  },
  claude: {
    text: promptClaudeText,
    streamText: promptClaudeStreamText,
    object: promptClaudeObject,
  },
}

// ─── Provider selection ───────────────────────────────────────────────────────

/**
 * Returns true when at least one AI provider (Gemini, Codex CLI, or Claude Code) is available.
 * Call `ensureGeminiApiKey()` before this to populate Gemini key from Keychain.
 *
 * Set AI_TEST_NO_BACKEND=1 to simulate "no backend" in tests.
 */
export function hasAiProvider(): boolean {
  if (process.env.AI_TEST_NO_BACKEND === "1") return false
  return hasGeminiApiKey() || hasCodexCli() || hasClaudeCode()
}

/**
 * Returns the resolved provider ID, or null if none is available.
 *
 * Resolution order (highest to lowest precedence):
 *   1. `override` argument (from options.provider or CLI --provider flag)
 *   2. AI_PROVIDER env var ("gemini" | "codex" | "claude")
 *   3. Auto-select: Gemini preferred, then Codex CLI, then Claude Code
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
  if (requested === "claude") {
    if (!hasClaudeCode()) {
      throw new Error(
        "AI_PROVIDER=claude requested but the claude CLI is not installed or not in PATH."
      )
    }
    return "claude"
  }
  if (requested !== undefined) {
    throw new Error(`Unknown AI provider "${requested}". Valid values: gemini, codex, claude.`)
  }

  // Auto-select
  if (hasGeminiApiKey()) return "gemini"
  if (hasCodexCli()) return "codex"
  if (hasClaudeCode()) return "claude"
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
  if (!provider) {
    throw new Error(
      "No AI provider available. Set GEMINI_API_KEY, install the codex CLI, or install the claude CLI."
    )
  }
  return PROVIDER_REGISTRY[provider].text(prompt, options)
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
  if (!provider) {
    throw new Error(
      "No AI provider available. Set GEMINI_API_KEY, install the codex CLI, or install the claude CLI."
    )
  }
  return PROVIDER_REGISTRY[provider].streamText(prompt, options)
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
  if (!provider) {
    throw new Error(
      "No AI provider available. Set GEMINI_API_KEY, install the codex CLI, or install the claude CLI."
    )
  }
  return PROVIDER_REGISTRY[provider].object(prompt, schema, options) as Promise<T>
}

// Re-export ensureGeminiApiKey so callers only need this module for startup setup.
export { ensureGeminiApiKey }
