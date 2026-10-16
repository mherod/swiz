import type { BaseAiPromptOptions } from "./ai-prompt-options.ts"
import { resolveSignal } from "./ai-signal.ts"

/** Try providers in order under one deadline, rejecting results received after cancellation. */
export async function withProviderFallback<P, T>(
  providers: readonly P[],
  operation: (provider: P, signal: AbortSignal) => Promise<T>,
  options?: BaseAiPromptOptions
): Promise<T> {
  const { signal, cleanup } = resolveSignal(options)
  try {
    let throwLastError = (): never => {
      throw undefined
    }
    for (const provider of providers) {
      signal.throwIfAborted()
      try {
        const result = await operation(provider, signal)
        signal.throwIfAborted()
        return result
      } catch (error) {
        signal.throwIfAborted()
        throwLastError = () => {
          throw error
        }
      }
    }
    return throwLastError()
  } finally {
    cleanup()
  }
}
