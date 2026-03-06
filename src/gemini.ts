// Utility for invoking the Gemini API via the AI SDK (ai-sdk-provider-gemini-cli).
// Supports API key authentication from GEMINI_API_KEY env var.
//
// promptGemini(prompt, options)           — plain text generation.
// promptGeminiObject(prompt, schema, ...) — structured object generation via Output.object().
// hasGeminiApiKey()                       — synchronous check (env var only) for early-exit gates.

import { generateText, Output } from "ai"
import { createGeminiProvider } from "ai-sdk-provider-gemini-cli"
import type { ZodType } from "zod"

const DEFAULT_MODEL = "gemini-2.5-flash"

/**
 * Synchronous check: returns true when GEMINI_API_KEY is set in the environment.
 * Use this for early-exit gates before the async prompt call.
 */
export function hasGeminiApiKey(): boolean {
  return Boolean(process.env.GEMINI_API_KEY)
}

export interface PromptGeminiOptions {
  /**
   * Per-call timeout in milliseconds. Creates an internal AbortController
   * that cancels the request after this many ms.
   * Ignored if `signal` is also provided.
   */
  timeout?: number
  /** External AbortSignal — takes precedence over timeout. */
  signal?: AbortSignal
  /** Gemini model to use. Defaults to gemini-2.5-flash. */
  model?: string
}

function createProvider() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("No Gemini API key found. Set GEMINI_API_KEY env var.")
  }
  return createGeminiProvider({
    authType: "api-key",
    apiKey: process.env.GEMINI_API_KEY,
  })
}

function resolveSignal(options?: PromptGeminiOptions): {
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

/**
 * Send a single-turn prompt to the Gemini API and return the trimmed text response.
 * Throws if the API key is unavailable or the request fails.
 */
export async function promptGemini(prompt: string, options?: PromptGeminiOptions): Promise<string> {
  const gemini = createProvider()
  const { signal, cleanup } = resolveSignal(options)
  try {
    const { text } = await generateText({
      model: gemini(options?.model ?? DEFAULT_MODEL),
      prompt,
      abortSignal: signal,
    })
    return text.trim()
  } finally {
    cleanup()
  }
}

/**
 * Send a single-turn prompt to the Gemini API and return a structured object
 * validated against the provided Zod schema.
 * Uses Output.object() for schema-enforced generation — no manual JSON parsing needed.
 * Throws if the API key is unavailable, the request fails, or validation fails.
 */
export async function promptGeminiObject<T>(
  prompt: string,
  schema: ZodType<T>,
  options?: PromptGeminiOptions
): Promise<T> {
  const gemini = createProvider()
  const { signal, cleanup } = resolveSignal(options)
  try {
    const { output } = await generateText({
      model: gemini(options?.model ?? DEFAULT_MODEL),
      output: Output.object({ schema }),
      prompt,
      abortSignal: signal,
    })
    return output
  } finally {
    cleanup()
  }
}
