/**
 * Shared `hookSpecificOutput` builders and accessors.
 *
 * Keeps lodash only — no `hook-utils` / `SwizHook` — so manifest-backed hooks can import
 * builders via `SwizHook.ts` or this module without circular deps.
 */

import { merge } from "lodash-es"

/** Non-array plain object `hookSpecificOutput` from a hook or dispatch envelope. */
export function getHookSpecificOutput(
  resp: Record<string, unknown>
): Record<string, unknown> | undefined {
  const hso = resp.hookSpecificOutput
  return hso && typeof hso === "object" && !Array.isArray(hso)
    ? (hso as Record<string, unknown>)
    : undefined
}

/**
 * PreToolUse-style `permissionDecision` / `permissionDecisionReason` merged with top-level
 * `decision` / `reason` (used by tests and trace parsing).
 */
export function extractPreToolSurfaceDecision(parsed: Record<string, unknown>): {
  decision?: string
  reason?: string
} {
  const hso = getHookSpecificOutput(parsed)
  return {
    decision: (hso?.permissionDecision ?? parsed.decision) as string | undefined,
    reason: (hso?.permissionDecisionReason ?? parsed.reason) as string | undefined,
  }
}

/**
 * Lodash-merge clone of existing `hookSpecificOutput`; sets `hookEventName` when missing/blank,
 * otherwise normalizes a non-empty existing name with `.trim()`.
 */
export function mergeHookSpecificOutputClone(
  response: Record<string, unknown>,
  hookEventName: string
): Record<string, unknown> {
  const existing = getHookSpecificOutput(response)
  const base = existing ? (merge({}, existing) as Record<string, unknown>) : {}
  const existingName = base.hookEventName
  base.hookEventName =
    typeof existingName === "string" && existingName.trim()
      ? String(existingName).trim()
      : hookEventName
  return base
}

export function hsoPreToolUseAllow(permissionDecisionReason: string): Record<string, unknown> {
  return {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    permissionDecisionReason,
  }
}

export function hsoPreToolUseDeny(permissionDecisionReason: string): Record<string, unknown> {
  return {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason,
  }
}

export function hsoPreToolUseAllowContextual(
  effectiveReason: string | undefined,
  additionalContext: string | undefined
): Record<string, unknown> {
  return {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    ...(effectiveReason ? { permissionDecisionReason: effectiveReason } : {}),
    ...(additionalContext ? { additionalContext } : {}),
  }
}

export function hsoPreToolUseAllowWithUpdatedInput(
  updatedInput: Record<string, unknown>,
  reason?: string
): Record<string, unknown> {
  return {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    ...(reason ? { permissionDecisionReason: reason } : {}),
    updatedInput,
    modifiedInput: updatedInput,
  }
}

export function hsoContextEvent(
  hookEventName: string,
  additionalContext: string
): Record<string, unknown> {
  return { hookEventName, additionalContext }
}

export function hsoPostToolUseDenyBlock(reason: string): Record<string, unknown> {
  return {
    hookEventName: "PostToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
    additionalContext: reason,
  }
}

/** Merged PreToolUse allow envelope from aggregated hints / contexts (dispatch strategy). */
export function hsoPreToolUseMergedAllow(fields: {
  hintsJoined?: string
  contextsJoined?: string
}): Record<string, unknown> {
  return {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    ...(fields.hintsJoined ? { permissionDecisionReason: fields.hintsJoined } : {}),
    ...(fields.contextsJoined ? { additionalContext: fields.contextsJoined } : {}),
  }
}
