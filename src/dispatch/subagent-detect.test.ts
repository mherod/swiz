import { describe, expect, it } from "bun:test"
import { isSubagentSession } from "./subagent-detect.ts"

describe("isSubagentSession", () => {
  it("returns false for undefined payload", () => {
    expect(isSubagentSession(undefined)).toBe(false)
  })

  it("returns false when both fields absent", () => {
    expect(isSubagentSession({ cwd: "/some/path", session_id: "abc" })).toBe(false)
  })

  it("returns true when agent_type is a non-empty string", () => {
    expect(isSubagentSession({ agent_type: "general-purpose" })).toBe(true)
  })

  it("returns true when agent_id is a non-empty string (secondary signal)", () => {
    expect(isSubagentSession({ agent_id: "subagent-abc-123" })).toBe(true)
  })

  it("returns true when both agent_type and agent_id are set", () => {
    expect(isSubagentSession({ agent_type: "general-purpose", agent_id: "subagent-abc-123" })).toBe(
      true
    )
  })

  it("returns false when agent_type is an empty string", () => {
    expect(isSubagentSession({ agent_type: "" })).toBe(false)
  })

  it("returns false when agent_id is an empty string", () => {
    expect(isSubagentSession({ agent_id: "" })).toBe(false)
  })

  it("returns false when both fields are empty strings", () => {
    expect(isSubagentSession({ agent_type: "", agent_id: "" })).toBe(false)
  })

  it("returns false when agent_type is a non-string (e.g. number)", () => {
    expect(isSubagentSession({ agent_type: 42 })).toBe(false)
  })

  it("returns false when agent_id is null", () => {
    expect(isSubagentSession({ agent_id: null })).toBe(false)
  })
})
