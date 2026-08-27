import { describe, expect, it } from "bun:test"
import { renderInline } from "./markdown.tsx"

describe("inline markdown placeholders", () => {
  it("preserves incomplete literal placeholder markers without hanging", () => {
    expect(renderInline("literal __PLACEHOLDER_ marker")).toBe("literal __PLACEHOLDER_ marker")
  })

  it("preserves unknown placeholder tokens", () => {
    expect(renderInline("literal __PLACEHOLDER_42__ marker")).toBe(
      "literal __PLACEHOLDER_42__ marker"
    )
  })

  it("restores generated code and link placeholders", () => {
    expect(renderInline("`sample` and [docs](https://example.com)")).toContain(
      '<code class="md-code">sample</code>'
    )
    expect(renderInline("`sample` and [docs](https://example.com)")).toContain(
      '<a href="https://example.com"'
    )
  })
})
