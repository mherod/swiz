/**
 * Shared signal handling for AI provider cancellation.
 *
 * Provides a global AbortController that fires on process shutdown (SIGTERM/SIGINT),
 * and a composable resolveSignal() utility that combines caller signals, timeouts,
 * and global shutdown into a single AbortSignal.
 *
 * Imported by: ai-providers.ts, gemini.ts
 * Breaks circular dependency: ai-providers.ts ↔ gemini.ts
 */

// ─── Process shutdown abort ──────────────────────────────────────────────────

/**
 * Global AbortController that fires when the process receives SIGTERM or SIGINT.
 * All in-flight AI provider requests are wired to this signal so network
 * connections close cleanly on shutdown instead of dangling until TCP timeout.
 */
let shutdownController = new AbortController()

/** Exposed for tests — resets the global shutdown controller. */
export function resetShutdownController(): void {
  shutdownController = new AbortController()
}

function onShutdownSignal() {
  shutdownController.abort()
}

process.on("SIGTERM", onShutdownSignal)
process.on("SIGINT", onShutdownSignal)

// ─── Signal composition ──────────────────────────────────────────────────────

/**
 * Compose an AbortSignal from multiple sources: caller signal, timeout, and global shutdown.
 * Returns a signal that fires when ANY source aborts, plus a cleanup function.
 */
export function resolveSignal(options?: { signal?: AbortSignal; timeout?: number }): {
  signal: AbortSignal
  cleanup: () => void
} {
  const callerSignal = options?.signal
  const timeoutMs = options?.timeout

  // No caller signal and no timeout — just use the global shutdown signal.
  if (!callerSignal && !timeoutMs) {
    return { signal: shutdownController.signal, cleanup: () => {} }
  }

  // Compose: abort when ANY of the sources fire (caller signal, timeout, or shutdown).
  const composed = new AbortController()

  const propagate = () => composed.abort()

  // Wire shutdown signal.
  if (!shutdownController.signal.aborted) {
    shutdownController.signal.addEventListener("abort", propagate, { once: true })
  } else {
    composed.abort()
  }

  // Wire caller-provided signal.
  if (callerSignal) {
    if (callerSignal.aborted) {
      composed.abort()
    } else {
      callerSignal.addEventListener("abort", propagate, { once: true })
    }
  }

  // Wire timeout.
  const handle = timeoutMs ? setTimeout(propagate, timeoutMs).unref() : undefined

  const cleanup = () => {
    if (handle !== undefined) clearTimeout(handle)
    shutdownController.signal.removeEventListener("abort", propagate)
    callerSignal?.removeEventListener("abort", propagate)
  }

  return { signal: composed.signal, cleanup }
}
