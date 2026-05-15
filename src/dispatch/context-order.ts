/**
 * Time-windowed ordering for merged hook contexts.
 *
 * When several hooks emit context in one response, keep the order stable for a
 * short time window while varying it across windows so the output does not feel
 * mechanically identical every time.
 */

const CONTEXT_ORDER_WINDOW_MS = 5 * 60 * 1000

function stableOrderScore(text: string): number {
  let hash = 5381
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i)
  }
  return hash >>> 0
}

function contextOrderScore(context: string, windowKey: number, hookEventName: string): number {
  return stableOrderScore(`${windowKey}\0${hookEventName}\0${context}`)
}

function contextDedupeKey(context: string): string {
  return context.trim().replace(/\s+/g, " ")
}

function dedupeHookContexts(contexts: readonly string[]): string[] {
  const seen = new Set<string>()
  const deduped: string[] = []
  for (const context of contexts) {
    const key = contextDedupeKey(context)
    if (!key || seen.has(key)) continue
    seen.add(key)
    deduped.push(context)
  }
  return deduped
}

/**
 * Reorder context strings deterministically inside a 5-minute time bucket.
 * Keeps the original order for small outputs where shuffling would only add
 * noise instead of reducing clutter.
 */
export function orderHookContexts(
  contexts: readonly string[],
  hookEventName: string,
  nowMs: number = Date.now()
): string[] {
  const deduped = dedupeHookContexts(contexts)
  if (deduped.length < 3) return deduped

  const windowKey = Math.floor(nowMs / CONTEXT_ORDER_WINDOW_MS)
  return deduped
    .map((context, index) => ({
      context,
      index,
      score: contextOrderScore(context, windowKey, hookEventName),
    }))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map(({ context }) => context)
}
