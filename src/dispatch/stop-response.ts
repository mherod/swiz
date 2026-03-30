/**
 * Stop / SubagentStop dispatch responses are normalized and validated against
 * {@link stopHookOutputSchema} in hooks/schemas.ts. After normalization the merged envelope always
 * sets `continue: true` and mirrors `reason` / `stopReason`; see `normalizeStopDispatchResponseInPlace`.
 */

import { stopHookOutputSchema } from "../../hooks/schemas.ts"
import { debugLog } from "../debug.ts"
import { isBlock } from "./engine.ts"

/** Default context when stop hooks emit no agent-visible fields (after merge). */
export const DEFAULT_STOP_DISPATCH_ALLOW_CONTEXT = "Stop hooks completed with no findings."

export function isStopLikeDispatchEvent(canonicalEvent: string): boolean {
  return canonicalEvent === "stop" || canonicalEvent === "subagentStop"
}

function mergeHookEventName(
  response: Record<string, unknown>,
  hookEventName: string
): Record<string, unknown> {
  const existingHso =
    response.hookSpecificOutput !== null &&
    typeof response.hookSpecificOutput === "object" &&
    !Array.isArray(response.hookSpecificOutput)
      ? ({ ...(response.hookSpecificOutput as Record<string, unknown>) } as Record<string, unknown>)
      : {}
  if (typeof existingHso.hookEventName !== "string" || !existingHso.hookEventName.trim()) {
    existingHso.hookEventName = hookEventName
  }
  return existingHso
}

function hasNonEmptyContext(response: Record<string, unknown>): boolean {
  if (typeof response.systemMessage === "string" && response.systemMessage.trim()) return true
  if (typeof response.reason === "string" && response.reason.trim()) return true
  if (typeof response.stopReason === "string" && response.stopReason.trim()) return true
  const hso = response.hookSpecificOutput
  if (hso && typeof hso === "object" && !Array.isArray(hso)) {
    const ac = (hso as { additionalContext?: string }).additionalContext
    return typeof ac === "string" && ac.trim().length > 0
  }
  return false
}

/**
 * `stopHookOutputSchema` requires non-empty `reason` and/or `stopReason`. Mirror one into the
 * other, or derive both from `systemMessage` / `hookSpecificOutput.additionalContext`, else default.
 */
function backfillStopDispatchReasonFields(response: Record<string, unknown>): void {
  const reason = typeof response.reason === "string" ? response.reason.trim() : ""
  const stopReason = typeof response.stopReason === "string" ? response.stopReason.trim() : ""

  if (reason && stopReason) {
    response.reason = reason
    response.stopReason = stopReason
    return
  }
  if (reason && !stopReason) {
    response.reason = reason
    response.stopReason = reason
    return
  }
  if (stopReason && !reason) {
    response.reason = stopReason
    response.stopReason = stopReason
    return
  }

  const sm = typeof response.systemMessage === "string" ? response.systemMessage.trim() : ""
  // Do not promote `hookSpecificOutput.additionalContext` into reason/stopReason — schema
  // rejects additionalContext-only; merged `systemMessage` from hooks is the supported path.
  const filler = sm || DEFAULT_STOP_DISPATCH_ALLOW_CONTEXT
  response.reason = filler
  response.stopReason = filler
}

/**
 * Ensures merged stop/subagentStop dispatch JSON satisfies {@link stopHookOutputSchema}.
 * Mutates `response` in place.
 */
export function normalizeStopDispatchResponseInPlace(
  response: Record<string, unknown>,
  hookEventName: string
): void {
  // `isBlock` treats `continue === false` as a block. Coercing `continue` to true first would
  // erase that signal and route real stops into the generic allow path — must snapshot first.
  const dispatchBlocked = isBlock(response)

  if (response.continue === false) {
    delete response.continue
  }
  response.continue = true

  if (dispatchBlocked) {
    if (
      (typeof response.reason !== "string" || !response.reason.trim()) &&
      typeof response.stopReason === "string" &&
      response.stopReason.trim()
    ) {
      response.reason = response.stopReason.trim()
    }
  } else if (!hasNonEmptyContext(response)) {
    const hso = mergeHookEventName(response, hookEventName)
    if (!hso.additionalContext || !String(hso.additionalContext).trim()) {
      hso.additionalContext = DEFAULT_STOP_DISPATCH_ALLOW_CONTEXT
    }
    response.hookSpecificOutput = hso
  } else {
    response.hookSpecificOutput = mergeHookEventName(response, hookEventName)
  }

  backfillStopDispatchReasonFields(response)

  const validated = stopHookOutputSchema.safeParse(response)
  if (!validated.success) {
    debugLog("[stop-dispatch] response failed stopHookOutputSchema:", validated.error.flatten())
    if (!dispatchBlocked) {
      response.continue = true
      response.reason = DEFAULT_STOP_DISPATCH_ALLOW_CONTEXT
      response.stopReason = DEFAULT_STOP_DISPATCH_ALLOW_CONTEXT
      response.hookSpecificOutput = {
        ...mergeHookEventName(response, hookEventName),
        additionalContext: DEFAULT_STOP_DISPATCH_ALLOW_CONTEXT,
      }
    } else {
      const fallback =
        (typeof response.stopReason === "string" && response.stopReason.trim()
          ? response.stopReason.trim()
          : null) ??
        (typeof response.reason === "string" && response.reason.trim()
          ? response.reason.trim()
          : null) ??
        (typeof response.systemMessage === "string" && response.systemMessage.trim()
          ? response.systemMessage.trim()
          : null) ??
        "Session stop was blocked."
      response.reason = fallback
      response.stopReason = fallback
      response.continue = true
    }
  }
}

/** Parse-only check for tests and diagnostics. */
export function safeParseStopDispatchResponse(
  response: unknown
): ReturnType<typeof stopHookOutputSchema.safeParse> {
  return stopHookOutputSchema.safeParse(response)
}
