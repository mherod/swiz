/**
 * Stop / SubagentStop dispatch responses are normalized and validated against
 * {@link stopHookOutputSchema} in hooks/schemas.ts. After normalization the merged envelope always
 * sets `continue: true` and mirrors `reason` / `stopReason`; see `normalizeStopDispatchResponseInPlace`.
 */

import { unset } from "lodash-es"
import { stopHookOutputSchema } from "../../hooks/schemas.ts"
import { mergeHookSpecificOutputClone } from "../utils/hook-specific-output.ts"
import { isBlock } from "./engine.ts"

/** Default context when stop hooks emit no agent-visible fields (after merge). */
export const DEFAULT_STOP_DISPATCH_ALLOW_CONTEXT = "Stop hooks completed with no findings."

/** JSON-serializable values for pre-parse dispatch envelopes (avoids eslint `no-restricted-types` on `unknown`). */
export type DispatchJsonValue =
  | string
  | number
  | boolean
  | null
  | DispatchJsonValue[]
  | DispatchJsonRecord

/** Loose object shape for merged hook/dispatch JSON before {@link stopHookOutputSchema.parse}. */
export type DispatchJsonRecord = { [key: string]: DispatchJsonValue }

export function isStopLikeDispatchEvent(canonicalEvent: string): boolean {
  return canonicalEvent === "stop" || canonicalEvent === "subagentStop"
}

function isPlainRecord(value: DispatchJsonValue | undefined): value is DispatchJsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Non-empty string after trim, or `null` if missing/blank. */
function trimmedNonEmpty(value: DispatchJsonValue | undefined): string | null {
  if (typeof value !== "string") return null
  const t = value.trim()
  return t.length > 0 ? t : null
}

function hasNonEmptyContext(response: DispatchJsonRecord): boolean {
  if (trimmedNonEmpty(response.systemMessage)) return true
  if (trimmedNonEmpty(response.reason)) return true
  if (trimmedNonEmpty(response.stopReason)) return true
  const hso = response.hookSpecificOutput
  if (!isPlainRecord(hso)) return false
  return trimmedNonEmpty(hso.additionalContext) !== null
}

/**
 * `stopHookOutputSchema` requires non-empty `reason` and/or `stopReason`. Mirror one into the
 * other, or derive both from `systemMessage` / `hookSpecificOutput.additionalContext`, else default.
 */
function backfillStopDispatchReasonFields(response: DispatchJsonRecord): void {
  const reason = trimmedNonEmpty(response.reason) ?? ""
  const stopReason = trimmedNonEmpty(response.stopReason) ?? ""

  let resolvedReason: string
  let resolvedStopReason: string
  if (reason && stopReason) {
    resolvedReason = reason
    resolvedStopReason = stopReason
  } else if (reason) {
    resolvedReason = reason
    resolvedStopReason = reason
  } else if (stopReason) {
    resolvedReason = stopReason
    resolvedStopReason = stopReason
  } else {
    const sm = trimmedNonEmpty(response.systemMessage) ?? ""
    // Do not promote `hookSpecificOutput.additionalContext` into reason/stopReason — schema
    // rejects additionalContext-only; merged `systemMessage` from hooks is the supported path.
    const filler = sm || DEFAULT_STOP_DISPATCH_ALLOW_CONTEXT
    resolvedReason = filler
    resolvedStopReason = filler
  }

  response.reason = resolvedReason
  response.stopReason = resolvedStopReason
}

/**
 * Ensures merged stop/subagentStop dispatch JSON satisfies {@link stopHookOutputSchema}.
 * Mutates `response` in place.
 *
 * Parameter is `object` so callers may pass `Record<string, any>` without a cast; internally
 * treated as {@link DispatchJsonRecord} until Zod validates.
 */
export function normalizeStopDispatchResponseInPlace(
  response: object,
  hookEventName: string
): void {
  const envelope = response as DispatchJsonRecord
  // `isBlock` treats `continue === false` as a block. Coercing `continue` to true first would
  // erase that signal and route real stops into the generic allow path — must snapshot first.
  const dispatchBlocked = isBlock(envelope)

  if (envelope.continue === false) {
    unset(envelope, "continue")
  }
  envelope.continue = true

  if (dispatchBlocked) {
    const reasonMissing = trimmedNonEmpty(envelope.reason) === null
    const stopReasonText = trimmedNonEmpty(envelope.stopReason)
    if (reasonMissing && stopReasonText !== null) {
      envelope.reason = stopReasonText
    }
  } else if (!hasNonEmptyContext(envelope)) {
    const hso = mergeHookSpecificOutputClone(
      envelope as Record<string, any>,
      hookEventName
    ) as DispatchJsonRecord
    // Match prior coercion: non-strings (e.g. numbers) stringify before trim.
    if (!hso.additionalContext || !String(hso.additionalContext).trim()) {
      hso.additionalContext = DEFAULT_STOP_DISPATCH_ALLOW_CONTEXT
    }
    envelope.hookSpecificOutput = hso
  } else {
    envelope.hookSpecificOutput = mergeHookSpecificOutputClone(
      envelope as Record<string, any>,
      hookEventName
    ) as DispatchJsonRecord
  }

  backfillStopDispatchReasonFields(envelope)

  // Claude Code rejects hookSpecificOutput unless hookEventName is PreToolUse, UserPromptSubmit,
  // or PostToolUse. Normalization may merge { hookEventName: "Stop" | "SubagentStop", ... } —
  // strip it; reason / stopReason / systemMessage carry the narrative.
  const hsoAfter = envelope.hookSpecificOutput
  if (isPlainRecord(hsoAfter)) {
    const name = typeof hsoAfter.hookEventName === "string" ? hsoAfter.hookEventName.trim() : ""
    if (name === "Stop" || name === "SubagentStop") {
      unset(envelope, "hookSpecificOutput")
    }
  }

  stopHookOutputSchema.parse(envelope)
}

/** Parse-only check for tests and diagnostics. */
export function safeParseStopDispatchResponse(
  response: DispatchJsonValue
): ReturnType<typeof stopHookOutputSchema.safeParse> {
  return stopHookOutputSchema.safeParse(response)
}
