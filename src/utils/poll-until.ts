/**
 * Shared fetch → check → sleep loop for polling external state (CI runs).
 *
 * Each iteration fetches first, so the caller always gets a final reading at
 * the budget boundary. The loop stops when `isDone` accepts a value, when the
 * time budget (`timeoutMs`) is spent, or after `maxAttempts` fetches —
 * whichever comes first. Sleeps never overshoot the remaining time budget.
 */

export interface PollWaitInfo {
  /** 1-based number of fetches made so far. */
  attempt: number
  /** Milliseconds since polling started. */
  elapsedMs: number
}

export interface PollUntilOptions<T> {
  fetch: () => Promise<T>
  isDone: (value: T) => boolean
  intervalMs: number
  /** Total time budget, measured from `startTime`. */
  timeoutMs?: number
  /** Maximum number of fetches. */
  maxAttempts?: number
  /** Defaults to `now()` when polling begins. */
  startTime?: number
  /** Called before each sleep with the value that was not done yet. */
  onWaiting?: (value: T, info: PollWaitInfo) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export type PollUntilResult<T> = { done: boolean; value: T }

type PollBudget = Pick<PollUntilOptions<unknown>, "intervalMs" | "timeoutMs" | "maxAttempts">

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function budgetSpent(options: PollBudget, info: PollWaitInfo): boolean {
  const { timeoutMs, maxAttempts } = options
  if (timeoutMs !== undefined && info.elapsedMs >= timeoutMs) return true
  return maxAttempts !== undefined && info.attempt >= maxAttempts
}

function nextSleepMs(options: PollBudget, elapsedMs: number): number {
  if (options.timeoutMs === undefined) return options.intervalMs
  return Math.min(options.intervalMs, options.timeoutMs - elapsedMs)
}

export async function pollUntil<T>(options: PollUntilOptions<T>): Promise<PollUntilResult<T>> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const startTime = options.startTime ?? now()

  for (let attempt = 1; ; attempt++) {
    const value = await options.fetch()
    if (options.isDone(value)) return { done: true, value }

    const info = { attempt, elapsedMs: now() - startTime }
    if (budgetSpent(options, info)) return { done: false, value }

    options.onWaiting?.(value, info)
    await sleep(nextSleepMs(options, info.elapsedMs))
  }
}
