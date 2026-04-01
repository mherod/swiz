/**
 * Session lifecycle handlers for auto-steer queue injection and flushing.
 *
 * Integrates PR review auto-steer payloads into the turn execution pipeline
 * and session termination flow.
 */

import type { AutoSteerPayload } from "./pr-review-tracker.ts"

export interface SessionAutoSteerContext {
  /** Queue of pending auto-steer payloads waiting for next turn or stop. */
  autoSteerQueue: AutoSteerPayload[]
  /** System directives to inject before agent reasoning. */
  pendingDirectives: string[]
  /** Optional output stream for stop flush. */
  outputStream?: { write: (text: string) => void }
}

/**
 * Process queued auto-steer payloads on turn boundary.
 *
 * Sorts by priority (high first) then timestamp, then injects as system
 * directives before agent reasoning begins.
 *
 * @param context - Session context with auto-steer queue
 */
export function processAutoSteerDirectives(context: SessionAutoSteerContext): void {
  if (!context.autoSteerQueue || context.autoSteerQueue.length === 0) return

  // Pre-compute numeric timestamps to avoid O(N log N) Date constructions in comparator
  type Keyed = { payload: AutoSteerPayload; ts: number; hi: number }
  const keyed: Keyed[] = context.autoSteerQueue.map((s) => ({
    payload: s,
    ts: new Date(s.timestamp).getTime(),
    hi: s.priority === "high" ? 1 : 0,
  }))
  keyed.sort((a, b) => b.hi - a.hi || a.ts - b.ts)

  // Inject as system-level directives
  for (const { payload: s } of keyed) {
    context.pendingDirectives.push(
      `[AUTO-STEER | ${s.type.replace(/_/g, " ")} | PR #${s.prNumber}] ${s.message}`
    )
  }

  context.autoSteerQueue = []
}

/**
 * Flush remaining auto-steer payloads on session termination.
 *
 * Writes pending payloads to output stream as final summary before session ends.
 *
 * @param context - Session context with auto-steer queue
 */
export function flushPendingAutoSteers(context: SessionAutoSteerContext): void {
  if (!context.autoSteerQueue || context.autoSteerQueue.length === 0) return

  const output =
    `\n[PENDING AUTO-STEERS AT TERMINATION]\n` +
    context.autoSteerQueue
      .map((s) => `• [${s.type.replace(/_/g, " ").toUpperCase()}] PR #${s.prNumber}: ${s.message}`)
      .join("\n") +
    "\n"

  context.outputStream?.write(output)
  context.autoSteerQueue = []
}
