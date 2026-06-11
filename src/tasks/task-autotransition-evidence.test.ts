import { describe, expect, it } from "bun:test"
import { hasMeaningfulCompletionEvidence } from "./task-service.ts"

// The auto-transition completion gate (`completeTaskWithAutoTransition`) refuses
// to take a still-`pending` task straight to `completed` unless it carries
// meaningful evidence. This is the service-layer analogue of the
// no-phantom-completion hook that gates the native tool path.
describe("hasMeaningfulCompletionEvidence", () => {
  it("rejects missing or empty evidence", () => {
    expect(hasMeaningfulCompletionEvidence(undefined)).toBe(false)
    expect(hasMeaningfulCompletionEvidence("")).toBe(false)
    expect(hasMeaningfulCompletionEvidence("   ")).toBe(false)
    expect(hasMeaningfulCompletionEvidence("\n\t")).toBe(false)
  })

  it("accepts non-empty evidence", () => {
    expect(hasMeaningfulCompletionEvidence("commit:abc1234")).toBe(true)
    expect(hasMeaningfulCompletionEvidence("note: verified by hand")).toBe(true)
    expect(hasMeaningfulCompletionEvidence("done")).toBe(true)
  })
})
