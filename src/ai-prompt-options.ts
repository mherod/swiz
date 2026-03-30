/**
 * Shared option fields for AI provider prompt calls.
 * Breaks circular dependency between ai-providers.ts and gemini.ts.
 */

/** Common knobs for text / stream / object generation across providers. */
export interface BaseAiPromptOptions {
  /** Per-call timeout in milliseconds. */
  timeout?: number
  /** External AbortSignal — takes precedence over timeout when both apply. */
  signal?: AbortSignal
  /** Model identifier; provider-specific defaults apply when omitted. */
  model?: string
}
