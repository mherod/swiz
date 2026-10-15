import { normalizeAgentHookPayload } from "../../dispatch/payload-normalize.ts"

export interface NormalizedDispatchPayload {
  cwd: string | null
  sessionId: string | null
  transcriptPath: string | null
  toolName: string | null
  toolInput?: Record<string, any>
  /** Claude Code subagent id; present only when the hook fired inside a subagent (#962). */
  agentId?: string | null
}

export interface DispatchPayloadWorkerRequest {
  id: string
  kind: "parse-dispatch-payload"
  payloadStr: string
}

export type DispatchPayloadWorkerResponse =
  | { id: string; ok: true; payload: NormalizedDispatchPayload | null }
  | { id: string; ok: false; error: string }

function stringField(parsed: Record<string, any>, snake: string, camel?: string): string | null {
  const primary = parsed[snake]
  if (typeof primary === "string") return primary
  const fallback = camel ? parsed[camel] : undefined
  return typeof fallback === "string" ? fallback : null
}

function objectField(
  parsed: Record<string, any>,
  snake: string,
  camel: string
): Record<string, any> | undefined {
  const primary = parsed[snake]
  if (primary && typeof primary === "object") return primary as Record<string, any>
  const fallback = parsed[camel]
  return fallback && typeof fallback === "object" ? (fallback as Record<string, any>) : undefined
}

/** Shared normalization policy for worker execution and local recovery. */
export function normalizeParsedDispatchPayload(
  parsed: Record<string, any>
): NormalizedDispatchPayload {
  normalizeAgentHookPayload(parsed)
  return {
    cwd: stringField(parsed, "cwd"),
    sessionId: stringField(parsed, "session_id"),
    transcriptPath: stringField(parsed, "transcript_path"),
    toolName: stringField(parsed, "tool_name", "toolName"),
    toolInput: objectField(parsed, "tool_input", "toolInput"),
    agentId: stringField(parsed, "agent_id"),
  }
}

export function parseDispatchPayload(payloadStr: string): NormalizedDispatchPayload | null {
  try {
    return normalizeParsedDispatchPayload(JSON.parse(payloadStr) as Record<string, any>)
  } catch {
    return null
  }
}
