import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { LazyMessageDetails } from "./message-body.tsx"
import { areMessageRowsEqual } from "./session-messages.tsx"

describe("LazyMessageDetails", () => {
  it("does not render collapsed message content", () => {
    const html = renderToStaticMarkup(
      <LazyMessageDetails summary={<span>Preview</span>}>
        <span>Expensive full body</span>
      </LazyMessageDetails>
    )

    expect(html).toContain("Preview")
    expect(html).not.toContain("Expensive full body")
  })

  it("renders message content when initially expanded", () => {
    const html = renderToStaticMarkup(
      <LazyMessageDetails summary={<span>Preview</span>} defaultOpen>
        <span>Expensive full body</span>
      </LazyMessageDetails>
    )

    expect(html).toContain('open=""')
    expect(html).toContain("Expensive full body")
  })
})

describe("areMessageRowsEqual", () => {
  const base = {
    message: {
      role: "assistant" as const,
      timestamp: "2026-09-06T00:00:00Z",
      text: "same content",
      toolCalls: [{ name: "Read", detail: "same input" }],
    },
    count: 1,
    isNew: false,
    adjacentSkillName: null,
    isToolOnlyAssistant: false,
  }

  it("preserves rows reconstructed with identical content", () => {
    expect(areMessageRowsEqual(base, { ...base, message: { ...base.message } })).toBe(true)
  })

  it("rerenders when message content changes", () => {
    expect(
      areMessageRowsEqual(base, {
        ...base,
        message: { ...base.message, text: "changed content" },
      })
    ).toBe(false)
  })
})
