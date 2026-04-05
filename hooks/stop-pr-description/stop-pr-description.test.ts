/**
 * Tests for stop-pr-description hook extraction.
 *
 * Validates PR description format and completeness checks.
 */

import { describe, expect, it } from "bun:test"
import {
  buildEmptyDescriptionOutput,
  buildPlaceholderOutput,
  buildTooShortOutput,
} from "./action-plan.ts"
import {
  getCharCount,
  isEmptyDescription,
  isTooShortDescription,
} from "./completeness-validator.ts"
import { hasPlaceholderPattern, hasSummaryPlaceholder } from "./format-validator.ts"
import type { PRCheckContext } from "./types.ts"

const mockContext: PRCheckContext = {
  cwd: "/tmp/test-repo",
  prNumber: 42,
  prTitle: "feat: add new feature",
  prBody: "This is a valid PR description with enough content.",
}

describe("Format Validator", () => {
  it("detects summary placeholder", () => {
    const body = "## Summary\n<placeholder>"
    expect(hasSummaryPlaceholder(body)).toBe(true)
  })

  it("returns false for non-placeholder summary", () => {
    const body = "## Summary\nThis is a real description"
    expect(hasSummaryPlaceholder(body)).toBe(false)
  })

  it("detects placeholder patterns", () => {
    const body = "Describe your changes here"
    expect(hasPlaceholderPattern(body)).toBe(true)
  })

  it("returns false for non-placeholder text", () => {
    const body = "This is a legitimate description"
    expect(hasPlaceholderPattern(body)).toBe(false)
  })
})

describe("Completeness Validator", () => {
  it("detects empty description", () => {
    expect(isEmptyDescription("")).toBe(true)
    expect(isEmptyDescription("   \n  \n  ")).toBe(true)
  })

  it("returns false for non-empty description", () => {
    expect(isEmptyDescription("This has content")).toBe(false)
  })

  it("detects too-short description", () => {
    expect(isTooShortDescription("short")).toBe(true)
  })

  it("returns false for sufficient length", () => {
    expect(isTooShortDescription("This is a long enough description")).toBe(false)
  })

  it("counts non-whitespace characters correctly", () => {
    expect(getCharCount("hello world")).toBe(10)
    expect(getCharCount("  a  b  c  ")).toBe(3)
  })
})

describe("Action Plan - Output Formatting", () => {
  it("formats empty description output", () => {
    const ctx: PRCheckContext = {
      ...mockContext,
      prBody: "",
    }
    const output = buildEmptyDescriptionOutput(ctx)
    expect(output).toBeDefined()
    expect(JSON.stringify(output)).toContain("empty description")
  })

  it("formats placeholder output", () => {
    const ctx: PRCheckContext = {
      ...mockContext,
      prBody: "## Summary\n<placeholder>",
    }
    const output = buildPlaceholderOutput(ctx)
    expect(output).toBeDefined()
    expect(JSON.stringify(output)).toContain("placeholder")
  })

  it("formats too-short output", () => {
    const ctx: PRCheckContext = {
      ...mockContext,
      prBody: "short",
    }
    const state = { isEmpty: false, hasPlaceholder: false, isTooShort: true, minCharCount: 20 }
    const output = buildTooShortOutput(ctx, state)
    expect(output).toBeDefined()
    expect(JSON.stringify(output)).toContain("too short")
  })
})
