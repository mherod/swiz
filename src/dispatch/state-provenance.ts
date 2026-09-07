import { z } from "zod"
import { projectStateSchema, stateHistoryEntrySchema } from "../settings/types.ts"

const payloadSchema = z.object({
  session_id: z.string().optional(),
  _projectState: projectStateSchema.nullish(),
  _projectStateTransition: stateHistoryEntrySchema.nullish(),
})

/** Attribute shared state without inferring an actor for legacy or manual writes. */
export function projectStateProvenance(payloadStr: string): string | null {
  try {
    const payload = payloadSchema.parse(JSON.parse(payloadStr))
    if (!payload._projectState) return null
    const entry = payload._projectStateTransition
    if (!entry || entry.to !== payload._projectState) {
      return `Shared project state: ${payload._projectState}; source unknown (transition unavailable).`
    }
    if (entry.sessionId && entry.sessionId === payload.session_id) return null
    const actor = entry.sessionId ? `session ${JSON.stringify(entry.sessionId)}` : "source unknown"
    return `Shared project state changed by ${actor}: ${entry.from ?? "unset"} → ${entry.to} at ${entry.timestamp}.`
  } catch {
    return null
  }
}

/** Decorate tool-event context before agent-specific serialization, preserving decisions. */
export function injectProjectStateProvenance(
  response: Record<string, any>,
  event: string,
  payloadStr: string
): void {
  if (event !== "preToolUse" && event !== "postToolUse") return
  const context = projectStateProvenance(payloadStr)
  if (!context) return
  response.systemMessage = [response.systemMessage, context].filter(Boolean).join("\n\n")
  if (response.hookSpecificOutput) {
    const specific = response.hookSpecificOutput
    specific.additionalContext = [specific.additionalContext, context].filter(Boolean).join("\n\n")
  }
}
