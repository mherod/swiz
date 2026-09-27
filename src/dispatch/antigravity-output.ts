import {
  AntigravityPostToolUseStdoutSchema,
  AntigravityPreToolUseStdoutSchema,
} from "agent-hook-schemas/antigravity"

function permissionDecision(response: Record<string, any>): string | undefined {
  if (response.decision === "block" || response.continue === false) return "deny"
  return response.hookSpecificOutput?.permissionDecision
}

/** Convert only at the wire boundary; internal strategies keep canonical output. */
export function formatAntigravityToolOutput(
  response: Record<string, any>,
  event: string
): Record<string, any> {
  if (event === "postToolUse") return AntigravityPostToolUseStdoutSchema.parse({})
  if (event !== "preToolUse") return response
  const hso = response.hookSpecificOutput
  const decision = permissionDecision(response)
  const reason = hso?.permissionDecisionReason ?? response.reason ?? response.systemMessage
  // An advisory must not override the agent's permission mode with an explicit allow.
  return AntigravityPreToolUseStdoutSchema.parse({
    ...(decision ? { decision } : {}),
    ...(reason ? { reason } : {}),
  })
}
