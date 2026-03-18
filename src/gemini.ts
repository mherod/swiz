// Utility for invoking the Gemini API via the AI SDK (ai-sdk-provider-gemini-cli).
// Supports API key authentication from GEMINI_API_KEY env var.
//
// promptGemini(prompt, options)           — plain text generation.
// promptGeminiObject(prompt, schema, ...) — structured object generation via Output.object().
// promptGeminiStreamText(prompt, ...)     — streamed text generation via streamText().
// hasGeminiApiKey()                       — synchronous check (env var only) for early-exit gates.

import { generateText, Output, streamText } from "ai"
import { createGeminiProvider } from "ai-sdk-provider-gemini-cli"
import type { ZodType } from "zod"
import { resolveSignal } from "./ai-providers.ts"

const DEFAULT_MODEL = "gemini-flash-latest"

/**
 * Attempts to resolve a GEMINI_API_KEY and inject it into process.env if not
 * already present. Tries the macOS Keychain (via Bun.secrets) as a fallback.
 *
 * Keychain lookup: `security add-generic-password -s GEMINI_API_KEY -a default -w <key>`
 *
 * Call this once at startup before hasGeminiApiKey().
 * Safe to call multiple times — no-ops when the key is already in the environment.
 */
export async function ensureGeminiApiKey(): Promise<void> {
  if (process.env.GEMINI_API_KEY) return
  try {
    // Bun.secrets reads from the system keychain (macOS Keychain, Linux libsecret, etc.)
    const secret = await Bun.secrets.get({ service: "GEMINI_API_KEY", name: "default" })
    if (secret) {
      process.env.GEMINI_API_KEY = secret
    }
  } catch {
    // Keychain unavailable or entry missing — env var path remains the only option
  }
}

/**
 * Synchronous check: returns true when Gemini access is available —
 * either via GEMINI_API_KEY env var or the gemini CLI (OAuth credentials).
 * Call ensureGeminiApiKey() first to populate the env var from Keychain if needed.
 *
 * Set GEMINI_TEST_NO_BACKEND=1 in tests to simulate "no backend available".
 */
export function hasGeminiApiKey(): boolean {
  if (process.env.GEMINI_TEST_NO_BACKEND === "1") return false
  return Boolean(process.env.GEMINI_API_KEY) || Boolean(Bun.which("gemini"))
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
  /** Gemini model to use. Defaults to gemini-flash-latest. */
  model?: string
}

export interface PromptGeminiStreamOptions extends PromptGeminiOptions {
  /**
   * Called for each streamed text delta.
   */
  onTextPart?: (textPart: string) => void
}

function createProvider() {
  if (process.env.GEMINI_API_KEY) {
    return createGeminiProvider({
      authType: "api-key",
      apiKey: process.env.GEMINI_API_KEY,
    })
  }
  // Fall back to OAuth (cached ~/.gemini/ credentials from the gemini CLI)
  return createGeminiProvider({ authType: "oauth-personal" })
}

// resolveSignal imported from ai-providers.ts

function getGeminiTestResponseForText(): string | undefined {
  return (
    process.env.GEMINI_TEST_STREAM_RESPONSE ??
    process.env.GEMINI_TEST_TEXT_RESPONSE ??
    process.env.GEMINI_TEST_RESPONSE
  )
}

async function maybeCapturePrompt(prompt: string): Promise<void> {
  if (process.env.GEMINI_TEST_CAPTURE_FILE) {
    await Bun.write(process.env.GEMINI_TEST_CAPTURE_FILE, prompt)
  }
}

/**
 * Send a single-turn prompt to the Gemini API and return the trimmed text response.
 * Throws if the API key is unavailable or the request fails.
 */
export async function promptGemini(prompt: string, options?: PromptGeminiOptions): Promise<string> {
  // ── Test seams ──────────────────────────────────────────────────────────
  // These env vars are checked before creating the real provider so tests can
  // inject fixture responses without network calls.
  if (process.env.GEMINI_TEST_THROW === "1") {
    throw new Error("Simulated Gemini API error (GEMINI_TEST_THROW=1)")
  }
  if (process.env.GEMINI_TEST_TEXT_RESPONSE !== undefined) {
    await maybeCapturePrompt(prompt)
    return process.env.GEMINI_TEST_TEXT_RESPONSE.trim()
  }

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
 * Send a single-turn prompt to Gemini and return the final text while exposing
 * streamed deltas through `onTextPart`.
 */
export async function promptGeminiStreamText(
  prompt: string,
  options?: PromptGeminiStreamOptions
): Promise<string> {
  if (process.env.GEMINI_TEST_THROW === "1") {
    throw new Error("Simulated Gemini API error (GEMINI_TEST_THROW=1)")
  }

  const testResponse = getGeminiTestResponseForText()
  if (testResponse !== undefined) {
    await maybeCapturePrompt(prompt)
    options?.onTextPart?.(testResponse)
    return testResponse.trim()
  }

  const gemini = createProvider()
  const { signal, cleanup } = resolveSignal(options)
  try {
    const result = streamText({
      model: gemini(options?.model ?? DEFAULT_MODEL),
      prompt,
      abortSignal: signal,
    })

    let text = ""
    for await (const textPart of result.textStream) {
      text += textPart
      options?.onTextPart?.(textPart)
    }
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
  // ── Test seams ──────────────────────────────────────────────────────────
  // These env vars are checked before creating the real provider so that
  // subprocess-based integration tests can inject fixture responses without
  // hitting the network.  They are never set in production.
  if (process.env.GEMINI_TEST_THROW === "1") {
    throw new Error("Simulated Gemini API error (GEMINI_TEST_THROW=1)")
  }
  if (process.env.GEMINI_TEST_RESPONSE !== undefined) {
    await maybeCapturePrompt(prompt)
    if (process.env.GEMINI_TEST_DELAY_MS) {
      const { signal: delaySignal } = resolveSignal(options)
      const delay = Number.parseInt(process.env.GEMINI_TEST_DELAY_MS, 10)
      await new Promise<void>((resolve, reject) => {
        // Do NOT .unref() this timer — it must keep the event loop alive so the
        // abort signal (which fires when the hook's own timeout expires) can land.
        const id = setTimeout(resolve, delay)
        delaySignal?.addEventListener(
          "abort",
          () => {
            clearTimeout(id)
            reject(new Error("Aborted"))
          },
          { once: true }
        )
      })
    }
    return JSON.parse(process.env.GEMINI_TEST_RESPONSE) as T
  }
  // ── Real implementation ──────────────────────────────────────────────────
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
