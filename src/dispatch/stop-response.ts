/**
 * Stop dispatch responses must include at least one control field (see
 * `hookOutputSchema` in hooks/schemas.ts). Several code paths previously
 * returned `{}` or only `hookExecutions`, which agents treat as vacuous.
 */

const STOP_DISPATCH_CONTROL_KEYS = new Set([
  "decision",
  "hookSpecificOutput",
  "ok",
  "continue",
  "systemMessage",
  "error",
])

export function stopDispatchResponseHasControlField(response: Record<string, unknown>): boolean {
  return Object.keys(response).some((k) => STOP_DISPATCH_CONTROL_KEYS.has(k))
}

/** Mutates `response` when it lacks agent-visible control fields (in-place). */
export function normalizeStopDispatchResponseInPlace(
  response: Record<string, unknown>,
  hookEventName: string
): void {
  if (stopDispatchResponseHasControlField(response)) return
  const existingHso =
    response.hookSpecificOutput !== null &&
    typeof response.hookSpecificOutput === "object" &&
    !Array.isArray(response.hookSpecificOutput)
      ? (response.hookSpecificOutput as Record<string, unknown>)
      : {}
  Object.assign(response, {
    continue: true,
    hookSpecificOutput: { ...existingHso, hookEventName },
  })
}
