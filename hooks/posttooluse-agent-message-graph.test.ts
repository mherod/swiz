import { describe, expect, test } from "bun:test"
import type { ToolHookInput } from "../src/schemas.ts"
import { buildAgentMessageEdge } from "./posttooluse-agent-message-graph.ts"

const NOW = new Date("2026-08-21T05:00:00.000Z")

function input(over: Record<string, unknown> = {}): ToolHookInput {
  return {
    session_id: "sess-a",
    cwd: "/Users/dev/Development/swiz",
    tool_name: "SendMessage",
    tool_input: { to: "openai-sba-dashboard-c6", message: "hello" },
    ...over,
  } as unknown as ToolHookInput
}

describe("buildAgentMessageEdge", () => {
  test("records both ends of the send and the body size", () => {
    expect(buildAgentMessageEdge(input(), NOW)).toEqual({
      at: "2026-08-21T05:00:00.000Z",
      fromSessionId: "sess-a",
      fromCwd: "/Users/dev/Development/swiz",
      toAddress: "openai-sba-dashboard-c6",
      messageBytes: 5,
    })
  })

  test("reads the recipient alias the wire payload also carries", () => {
    const edge = buildAgentMessageEdge(
      input({ tool_input: { recipient: "uds:/tmp/cc-socks/33626.sock", message: "hi" } }),
      NOW
    )
    expect(edge?.toAddress).toBe("uds:/tmp/cc-socks/33626.sock")
  })

  test("measures the real body, not the truncated preview", () => {
    // `content` is a ~50-char preview of `message`; measuring it would understate every edge.
    const message = "x".repeat(400)
    const edge = buildAgentMessageEdge(
      input({ tool_input: { to: "peer", message, content: message.slice(0, 50) } }),
      NOW
    )
    expect(edge?.messageBytes).toBe(400)
  })

  test("counts bytes rather than characters", () => {
    const edge = buildAgentMessageEdge(input({ tool_input: { to: "peer", message: "€" } }), NOW)
    expect(edge?.messageBytes).toBe(3)
  })

  test("never carries the body into the edge", () => {
    const edge = buildAgentMessageEdge(
      input({ tool_input: { to: "peer", message: "secret" } }),
      NOW
    )
    expect(JSON.stringify(edge)).not.toContain("secret")
  })

  test("a send with no recipient records nothing", () => {
    expect(buildAgentMessageEdge(input({ tool_input: { message: "hi" } }), NOW)).toBeNull()
  })

  test("control: a payload missing cwd records nothing, since half an edge is not an edge", () => {
    expect(buildAgentMessageEdge(input({ cwd: "" }), NOW)).toBeNull()
    expect(buildAgentMessageEdge(input({ session_id: "" }), NOW)).toBeNull()
  })

  test("a missing message body is size zero, not a dropped edge", () => {
    const edge = buildAgentMessageEdge(input({ tool_input: { to: "peer" } }), NOW)
    expect(edge).toMatchObject({ toAddress: "peer", messageBytes: 0 })
  })
})
