import { describe, expect, it } from "bun:test"
import { dispatchToolUseId, ensureDispatchId } from "./dispatch-id.ts"

describe("dispatch correlation id", () => {
  it("prefers and preserves an existing Swiz id", () => {
    const payload = { _swizDispatchId: "swiz-1", request_id: "agent-1" }
    expect(ensureDispatchId(payload)).toBe("swiz-1")
    expect(ensureDispatchId(payload)).toBe("swiz-1")
  })

  it("adopts an inbound request id before generating a UUID", () => {
    const inbound: Record<string, any> = { request_id: "agent-1" }
    expect(ensureDispatchId(inbound)).toBe("agent-1")
    expect(inbound._swizDispatchId).toBe("agent-1")
    expect(ensureDispatchId({})).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("normalizes tool-use ids", () => {
    expect(dispatchToolUseId({ tool_use_id: "tool-1", tool_call_id: "call-1" })).toBe("tool-1")
    expect(dispatchToolUseId({ tool_call_id: "call-1" })).toBe("call-1")
  })
})
