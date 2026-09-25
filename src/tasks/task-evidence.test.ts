import { describe, expect, it } from "bun:test"
import {
  hasCiEvidence,
  hasMeaningfulCompletionEvidence,
  hasStructuredEvidence,
  pendingCompletionRefusal,
} from "./task-evidence.ts"

describe("hasMeaningfulCompletionEvidence", () => {
  it("rejects missing or whitespace-only evidence", () => {
    expect(hasMeaningfulCompletionEvidence(undefined)).toBe(false)
    expect(hasMeaningfulCompletionEvidence("")).toBe(false)
    expect(hasMeaningfulCompletionEvidence("   \n\t")).toBe(false)
  })

  it("accepts any non-empty evidence", () => {
    expect(hasMeaningfulCompletionEvidence("note: did it")).toBe(true)
    expect(hasMeaningfulCompletionEvidence("commit:abc1234")).toBe(true)
    expect(hasMeaningfulCompletionEvidence("done")).toBe(true)
  })
})

// The one contract shared by the service hop and the native TaskUpdate hook (#930).
describe("pendingCompletionRefusal", () => {
  it("allows the one-step completion only with auto-transition on and evidence present", () => {
    expect(pendingCompletionRefusal(true, "commit:abc1234")).toBeNull()
    expect(pendingCompletionRefusal(true, "note: finished before the task was started")).toBeNull()
  })

  it("refuses missing or whitespace-only evidence", () => {
    expect(pendingCompletionRefusal(true, undefined)).toBe("missing-evidence")
    expect(pendingCompletionRefusal(true, "  \n")).toBe("missing-evidence")
  })

  it("reports the disabled setting first, since evidence cannot unlock it", () => {
    expect(pendingCompletionRefusal(false, "commit:abc1234")).toBe("auto-transition-disabled")
    expect(pendingCompletionRefusal(false, undefined)).toBe("auto-transition-disabled")
  })
})

describe("hasStructuredEvidence", () => {
  it("matches traceable evidence markers", () => {
    expect(hasStructuredEvidence("commit:abc1234")).toBe(true)
    expect(hasStructuredEvidence("done — pr:https://x/1")).toBe(true)
    expect(hasStructuredEvidence("file:src/x.ts updated")).toBe(true)
    expect(hasStructuredEvidence("test:passing")).toBe(true)
    expect(hasStructuredEvidence("ci_green:123")).toBe(true)
    expect(hasStructuredEvidence("run:456")).toBe(true)
  })

  it("rejects a bare note or prose without a marker", () => {
    expect(hasStructuredEvidence("note: I did the work")).toBe(false)
    expect(hasStructuredEvidence("finished the thing")).toBe(false)
    expect(hasStructuredEvidence("commit: ")).toBe(false)
  })
})

describe("hasCiEvidence", () => {
  it("matches CI-passed phrasing", () => {
    expect(hasCiEvidence("CI green")).toBe(true)
    expect(hasCiEvidence("ci passed for the run")).toBe(true)
    expect(hasCiEvidence("conclusion: success")).toBe(true)
  })

  it("rejects text without CI success signal", () => {
    expect(hasCiEvidence("committed and pushed")).toBe(false)
    expect(hasCiEvidence("ci is still running")).toBe(false)
  })
})
