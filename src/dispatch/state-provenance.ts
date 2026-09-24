import { z } from "zod"
import { projectStateSchema, stateHistoryEntrySchema } from "../settings/types.ts"

const payloadSchema = z.object({
  session_id: z.string().optional(),
  cwd: z.string().optional(),
  _projectState: projectStateSchema.nullish(),
  _projectStateTransition: stateHistoryEntrySchema.nullish(),
})

type ProvenancePayload = z.infer<typeof payloadSchema>

/** Last provenance line each session was shown, so an unchanged transition is announced once. */
const announcedProvenanceBySession = new Map<string, string>()
const ANNOUNCED_PROVENANCE_MAX = 256

function provenanceFromPayload(payload: ProvenancePayload): string | null {
  if (!payload._projectState) return null
  const entry = payload._projectStateTransition
  if (!entry || entry.to !== payload._projectState) {
    return `Shared project state: ${payload._projectState}; source unknown (transition unavailable).`
  }
  if (entry.sessionId && entry.sessionId === payload.session_id) return null
  // Legacy histories hold same-state entries; announcing those reports no change.
  if (entry.from === entry.to) return null
  const actor = entry.sessionId ? `session ${JSON.stringify(entry.sessionId)}` : "source unknown"
  return `Shared project state changed by ${actor}: ${entry.from ?? "unset"} → ${entry.to} at ${entry.timestamp}.`
}

/** Attribute shared state without inferring an actor for legacy or manual writes. */
export function projectStateProvenance(payloadStr: string): string | null {
  try {
    return provenanceFromPayload(payloadSchema.parse(JSON.parse(payloadStr)))
  } catch {
    return null
  }
}

/** Record the line for this session; false when the session was already shown it. */
function markAnnounced(payload: ProvenancePayload, context: string): boolean {
  const sessionId = payload.session_id?.trim()
  if (!sessionId) return true
  const key = `${sessionId}\0${payload.cwd ?? ""}`
  if (announcedProvenanceBySession.get(key) === context) return false
  announcedProvenanceBySession.delete(key)
  announcedProvenanceBySession.set(key, context)
  if (announcedProvenanceBySession.size > ANNOUNCED_PROVENANCE_MAX) {
    const oldest = announcedProvenanceBySession.keys().next().value
    if (oldest !== undefined) announcedProvenanceBySession.delete(oldest)
  }
  return true
}

/** Decorate tool-event context before agent-specific serialization, preserving decisions. */
export function injectProjectStateProvenance(
  response: Record<string, any>,
  event: string,
  payloadStr: string
): void {
  if (event !== "preToolUse" && event !== "postToolUse") return
  let payload: ProvenancePayload
  try {
    payload = payloadSchema.parse(JSON.parse(payloadStr))
  } catch {
    return
  }
  const context = provenanceFromPayload(payload)
  if (!context || !markAnnounced(payload, context)) return
  response.systemMessage = [response.systemMessage, context].filter(Boolean).join("\n\n")
  if (response.hookSpecificOutput) {
    const specific = response.hookSpecificOutput
    specific.additionalContext = [specific.additionalContext, context].filter(Boolean).join("\n\n")
  }
}
