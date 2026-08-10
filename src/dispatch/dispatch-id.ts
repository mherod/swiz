import { randomUUID } from "node:crypto"

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null
}

/** Ensure every dispatch carries one stable correlation id across all Swiz layers. */
export function ensureDispatchId(payload: Record<string, any>): string {
  const dispatchId =
    nonEmptyString(payload._swizDispatchId) ?? nonEmptyString(payload.request_id) ?? randomUUID()
  payload._swizDispatchId = dispatchId
  return dispatchId
}

export function dispatchToolUseId(payload: Record<string, any>): string | undefined {
  return nonEmptyString(payload.tool_use_id) ?? nonEmptyString(payload.tool_call_id) ?? undefined
}
