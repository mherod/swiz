import type {
  DispatchPayloadWorkerRequest,
  DispatchPayloadWorkerResponse,
  NormalizedDispatchPayload,
} from "./worker-runtime.ts"

function normalizeDispatchPayload(payloadStr: string): NormalizedDispatchPayload | null {
  const parsed = JSON.parse(payloadStr) as {
    cwd?: string
    session_id?: string
    tool_name?: string
    toolName?: string
    tool_input?: Record<string, unknown>
    toolInput?: Record<string, unknown>
  }
  const toolName =
    typeof parsed.tool_name === "string"
      ? parsed.tool_name
      : typeof parsed.toolName === "string"
        ? parsed.toolName
        : null
  const toolInput =
    parsed.tool_input && typeof parsed.tool_input === "object"
      ? parsed.tool_input
      : parsed.toolInput && typeof parsed.toolInput === "object"
        ? parsed.toolInput
        : undefined

  return {
    cwd: typeof parsed.cwd === "string" ? parsed.cwd : null,
    sessionId: typeof parsed.session_id === "string" ? parsed.session_id : null,
    toolName,
    toolInput,
  }
}

self.onmessage = (event: MessageEvent<DispatchPayloadWorkerRequest>) => {
  const req = event.data
  if (!req || req.kind !== "parse-dispatch-payload") return

  let response: DispatchPayloadWorkerResponse
  try {
    response = {
      id: req.id,
      ok: true,
      payload: normalizeDispatchPayload(req.payloadStr),
    }
  } catch (error) {
    response = {
      id: req.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  self.postMessage(response)
}
