import { describe, expect, test } from "bun:test"
import type { Turn } from "../transcript-turns.ts"
import { buildAutoReplyMessages } from "./transcript.ts"

function makeTurn(index: number, role: Turn["role"]): Turn {
  const content = role === "assistant" ? [{ type: "text", text: `turn-${index}` }] : `turn-${index}`
  return {
    role,
    entry: {
      type: role,
      timestamp: String(index),
      message: { role, content },
    },
  }
}

describe("buildAutoReplyMessages", () => {
  test("keeps only the tail context plus the continue prompt", () => {
    const turns = Array.from({ length: 25 }, (_, index) =>
      makeTurn(index, index % 2 === 0 ? "user" : "assistant")
    )

    const messages = buildAutoReplyMessages(turns, false)

    expect(messages).toHaveLength(20)
    expect(messages[0]?.content).toBe("turn-6")
    expect(messages.at(-2)?.content).toBe("turn-24")
    expect(messages.at(-1)).toEqual({
      role: "user",
      content: "Continue - the session is NOT ready to finish.",
    })
  })

  test("flips transcript roles without flipping the continue prompt", () => {
    const messages = buildAutoReplyMessages([makeTurn(1, "user"), makeTurn(2, "assistant")], true)

    expect(messages.map((message) => message.role)).toEqual(["assistant", "user", "user"])
    expect(messages.map((message) => message.content)).toEqual([
      "turn-1",
      "turn-2",
      "Continue - the session is NOT ready to finish.",
    ])
  })
})
