import { AntigravityToolCallSchema } from "agent-hook-schemas/antigravity"
import { normalizeAntigravityToolInput } from "../antigravity-tools.ts"

/** Preserve protojson metadata while exposing the canonical fields hooks consume. */
export function normalizeAntigravityPayload(payload: Record<string, any>): void {
  for (const [canonical, native] of [
    ["session_id", "conversationId"],
    ["workspace_roots", "workspacePaths"],
    ["transcript_path", "transcriptPath"],
    ["model", "modelName"],
  ] as const) {
    if (!payload[canonical] && payload[native] !== undefined) payload[canonical] = payload[native]
  }

  const tool = AntigravityToolCallSchema.safeParse(payload.toolCall)
  if (tool.success && !payload.tool_name && !payload.tool_input) {
    payload.tool_name = tool.data.name
    payload.tool_input = { ...tool.data.args }
  }
  const input = payload.tool_input
  if (input && typeof input === "object" && !Array.isArray(input)) {
    payload.tool_input = normalizeAntigravityToolInput(payload.tool_name, input)
  }
}
