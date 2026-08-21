import { describe, expect, it } from "bun:test"
import {
  findUnansweredPeerMessages,
  formatUnansweredPeerContext,
} from "./unanswered-peer-messages.ts"

/** The tag is assembled at runtime so this test file does not trip the detector it exercises. */
const TAG = `<cross${"-"}session-message`

function inboundLine(peer: string, address = "uds:/tmp/cc-socks/1234.sock"): string {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: `${TAG} from="${address}" from-name="${peer}" from-mode="bypass">\nhello\n</cross${"-"}session-message>`,
    },
  })
}

function outboundLine(to: string): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", name: "SendMessage", input: { to, message: "replying" } }],
    },
  })
}

function toolCallLine(name = "Bash"): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", name, input: {} }] },
  })
}

describe("findUnansweredPeerMessages", () => {
  it("reports a peer whose message was never answered", () => {
    const result = findUnansweredPeerMessages([
      inboundLine("peer-a"),
      toolCallLine(),
      toolCallLine(),
    ])
    expect(result).toHaveLength(1)
    expect(result[0]?.peer).toBe("peer-a")
    expect(result[0]?.address).toBe("uds:/tmp/cc-socks/1234.sock")
    expect(result[0]?.toolCallsSince).toBe(2)
  })

  it("clears a peer once a reply is addressed to its name", () => {
    const result = findUnansweredPeerMessages([
      inboundLine("peer-a"),
      toolCallLine(),
      outboundLine("peer-a"),
    ])
    expect(result).toEqual([])
  })

  it("clears a peer when the reply is addressed to its socket instead of its name", () => {
    const result = findUnansweredPeerMessages([
      inboundLine("peer-a", "uds:/tmp/cc-socks/9999.sock"),
      outboundLine("uds:/tmp/cc-socks/9999.sock"),
    ])
    expect(result).toEqual([])
  })

  it("clears a peer when the reply carries a ListAgents [ref] suffix", () => {
    const result = findUnansweredPeerMessages([
      inboundLine("peer-a"),
      outboundLine("peer-a [ffec00]"),
    ])
    expect(result).toEqual([])
  })

  it("re-opens a peer that messaged again after being answered", () => {
    const result = findUnansweredPeerMessages([
      inboundLine("peer-a"),
      outboundLine("peer-a"),
      inboundLine("peer-a"),
      toolCallLine(),
    ])
    expect(result).toHaveLength(1)
    expect(result[0]?.toolCallsSince).toBe(1)
  })

  it("does not let a reply to one peer clear another", () => {
    const result = findUnansweredPeerMessages([
      inboundLine("peer-a", "uds:/tmp/cc-socks/1111.sock"),
      inboundLine("peer-b", "uds:/tmp/cc-socks/2222.sock"),
      outboundLine("peer-b"),
    ])
    expect(result.map((entry) => entry.peer)).toEqual(["peer-a"])
  })

  it("collapses the several records one delivery writes into a single pending peer", () => {
    // A delivery lands as a queue-operation, an attachment, and a user message.
    const result = findUnansweredPeerMessages([
      JSON.stringify({ type: "queue-operation", raw: `${TAG} from-name="peer-a">` }),
      JSON.stringify({ type: "attachment", raw: `${TAG} from-name="peer-a">` }),
      inboundLine("peer-a"),
      toolCallLine(),
    ])
    expect(result).toHaveLength(1)
  })

  it("skips unparseable lines rather than abandoning the scan", () => {
    const result = findUnansweredPeerMessages([inboundLine("peer-a"), "{not json", toolCallLine()])
    expect(result).toHaveLength(1)
  })

  it("reports nothing when no peer message was ever received", () => {
    expect(findUnansweredPeerMessages([toolCallLine(), toolCallLine()])).toEqual([])
  })
})

describe("formatUnansweredPeerContext", () => {
  const pending = {
    peer: "peer-a",
    address: "uds:/tmp/1.sock",
    receivedAtLine: 0,
    toolCallsSince: 5,
  }

  it("stays silent below the tool-call threshold", () => {
    expect(formatUnansweredPeerContext([{ ...pending, toolCallsSince: 2 }], 3)).toBeNull()
  })

  // Control for the assertion above: the same input above the threshold must produce text,
  // otherwise the silence being asserted could come from any unrelated early return.
  it("emits a reminder at or above the threshold", () => {
    const context = formatUnansweredPeerContext([pending], 3)
    expect(context).toContain("peer-a")
    expect(context).toContain("still waiting on a reply")
  })

  it("counts multiple waiting peers in the subject line", () => {
    const context = formatUnansweredPeerContext([pending, { ...pending, peer: "peer-b" }], 3)
    expect(context).toContain("2 peer sessions are")
  })

  it("returns null for an empty list", () => {
    expect(formatUnansweredPeerContext([], 3)).toBeNull()
  })
})
