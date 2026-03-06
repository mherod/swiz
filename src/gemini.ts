// Utility for invoking the Gemini API via the AI SDK (ai-sdk-provider-gemini-cli).
// Supports API key authentication from GEMINI_API_KEY env var.
//
// promptGemini(prompt, options) — sends a single-turn prompt and returns trimmed text.
// hasGeminiApiKey()             — synchronous check (env var only) for early-exit gates.

import { generateText } from "ai"
import { createGeminiProvider } from "ai-sdk-provider-gemini-cli"

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
   * Per-call timeout in milliseconds. Passed as abortSignal to generateText.
   * Ignored if `signal` is also provided.
   */
  timeout?: number
  /** External AbortSignal — takes precedence over timeout. */
  signal?: AbortSignal
  /** Gemini model to use. Defaults to gemini-2.5-flash. */
  model?: string
}

/**
 * Send a single-turn prompt to the Gemini API via the AI SDK and return
 * the trimmed text response.
 * Throws if the API key is unavailable or the request fails.
 */
export async function promptGemini(prompt: string, options?: PromptGeminiOptions): Promise<string> {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("No Gemini API key found. Set GEMINI_API_KEY env var.")
  }

  const gemini = createGeminiProvider({
    authType: "api-key",
    apiKey: process.env.GEMINI_API_KEY,
  })

  const modelId = options?.model ?? DEFAULT_MODEL

  // Resolve abort signal — caller-supplied takes precedence; otherwise create
  // an internal one from timeout if provided.
  let abortSignal = options?.signal
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  if (!abortSignal && options?.timeout) {
    const controller = new AbortController()
    timeoutHandle = setTimeout(() => controller.abort(), options.timeout).unref()
    abortSignal = controller.signal
  }

  try {
    const { text } = await generateText({
      model: gemini(modelId),
      prompt,
      abortSignal,
    })
    return text.trim()
  } finally {
    clearTimeout(timeoutHandle)
  }
}
