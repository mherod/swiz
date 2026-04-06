/**
 * Shared `hookSpecificOutput` builders and accessors.
 *
 * Keeps lodash only — no `hook-utils` / `SwizHook` — so manifest-backed hooks can import
 * builders via `SwizHook.ts` or this module without circular deps.
 */

import { merge } from "lodash-es"
import { type HookSpecificOutput, hookOutputSchema, hookSpecificOutputSchema } from "../schemas.ts"

/** Non-array plain object `hookSpecificOutput` from a hook or dispatch envelope. */
export function getHookSpecificOutput(resp: {
  hookSpecificOutput?: unknown
  [key: string]: unknown
}): HookSpecificOutput | undefined {
  const hso = resp.hookSpecificOutput
  if (hso && typeof hso === "object")
    if (!Array.isArray(hso)) {
      return hso as Record<string, any>
    } else {
      return undefined
    }
  else {
    return undefined
  }
}

/**
 * PreToolUse-style `permissionDecision` / `permissionDecisionReason` merged with top-level
 * `decision` / `reason` (used by tests and trace parsing).
 */
export function extractPreToolSurfaceDecision(parsed: Record<string, any>): {
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
  response: Record<string, any>,
  hookEventName: string
): Record<string, any> {
  const existing = getHookSpecificOutput(response)
  const base = existing ? (merge({}, existing) as Record<string, any>) : {}
  const existingName = base.hookEventName
  base.hookEventName =
    typeof existingName === "string" && existingName.trim()
      ? String(existingName).trim()
      : hookEventName
  return base
}

export function hsoPreToolUseAllow(permissionDecisionReason: string): HookSpecificOutput {
  return hookOutputSchema.parse({
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    permissionDecisionReason,
  })
}

export function hsoPreToolUseDeny(permissionDecisionReason: string): HookSpecificOutput {
  return hookOutputSchema.parse({
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason,
  })
}

export function hsoPreToolUseAllowContextual(
  effectiveReason: string | undefined,
  additionalContext: string | undefined
): HookSpecificOutput {
  return hookSpecificOutputSchema.parse({
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    ...(effectiveReason ? { permissionDecisionReason: effectiveReason } : {}),
    ...(additionalContext ? { additionalContext } : {}),
  })
}

export function hsoPreToolUseAllowWithUpdatedInput(
  updatedInput: Record<string, any>,
  reason?: string
): HookSpecificOutput & {
  updatedInput: Record<string, any>
  modifiedInput: Record<string, any>
} {
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
): Partial<HookSpecificOutput> {
  return hookSpecificOutputSchema.parse({ hookEventName, additionalContext })
}

export function hsoPostToolUseDenyBlock(reason: string): HookSpecificOutput {
  return hookSpecificOutputSchema.parse({
    hookEventName: "PostToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
    additionalContext: reason,
  })
}

/** Merged PreToolUse allow envelope from aggregated hints / contexts (dispatch strategy). */
export function hsoPreToolUseMergedAllow(fields: {
  hintsJoined?: string
  contextsJoined?: string
}): HookSpecificOutput {
  return hookSpecificOutputSchema.parse({
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    ...(fields.hintsJoined ? { permissionDecisionReason: fields.hintsJoined } : {}),
    ...(fields.contextsJoined ? { additionalContext: fields.contextsJoined } : {}),
  })
}
