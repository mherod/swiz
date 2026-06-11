import { describe, expect, it } from "bun:test"
import {
  hasCiEvidence,
  hasMeaningfulCompletionEvidence,
  hasStructuredEvidence,
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
