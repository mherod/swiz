/** One cancellation/deadline scope spanning the entire daemon request. */
export interface DispatchRequestScope {
  signal: AbortSignal
  remainingMs(): number
}

type ScopedResult<T> = { kind: "completed"; value: T } | { kind: "timeout" | "aborted" }

export async function withDispatchRequestScope<T>(
  parent: AbortSignal,
  timeoutMs: number,
  run: (scope: DispatchRequestScope) => Promise<T>
): Promise<ScopedResult<T>> {
  if (parent.aborted) return { kind: "aborted" }
  const controller = new AbortController()
  const deadline = performance.now() + timeoutMs
  let onAbort!: () => void
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancelled = new Promise<ScopedResult<T>>((resolve) => {
    const cancel = (kind: "timeout" | "aborted") => {
      // Settle the race before notifying work that can reject on cancellation.
      resolve({ kind })
      controller.abort()
    }
    onAbort = () => cancel("aborted")
    parent.addEventListener("abort", onAbort, { once: true })
    timer = setTimeout(() => cancel("timeout"), Math.max(0, timeoutMs))
  })
  try {
    return await Promise.race([
      cancelled,
      run({
        signal: controller.signal,
        remainingMs: () => Math.max(0, deadline - performance.now()),
      }).then((value) => ({ kind: "completed" as const, value })),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    parent.removeEventListener("abort", onAbort)
    controller.abort()
  }
}
