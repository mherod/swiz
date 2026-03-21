import { describe, expect, test } from "bun:test"
import { detect } from "../hooks/task-subject-validation.ts"
import { isPlaceholderSubject, PLACEHOLDER_SUBJECT_RE } from "../hooks/utils/hook-utils.ts"

describe("isPlaceholderSubject", () => {
  test("matches recovered task subjects", () => {
    expect(isPlaceholderSubject("Recovered task #5 (lost during compaction)")).toBe(true)
    expect(isPlaceholderSubject("recovered task #1 (lost during compaction)")).toBe(true)
    expect(isPlaceholderSubject("RECOVERED TASK #99 (lost during compaction)")).toBe(true)
  })

  test("matches bootstrap placeholder subjects", () => {
    expect(isPlaceholderSubject("Session bootstrap — describe current work")).toBe(true)
    expect(isPlaceholderSubject("session bootstrap — describe current work")).toBe(true)
    expect(isPlaceholderSubject("Session bootstrap")).toBe(true)
  })

  test("rejects real task subjects", () => {
    expect(isPlaceholderSubject("Push and verify CI")).toBe(false)
    expect(isPlaceholderSubject("Fix authentication bug")).toBe(false)
    expect(isPlaceholderSubject("Commit changes and sync with remote")).toBe(false)
    expect(isPlaceholderSubject("")).toBe(false)
  })

  test("trims whitespace before matching", () => {
    expect(isPlaceholderSubject("  Recovered task #1 (lost during compaction)  ")).toBe(true)
    expect(isPlaceholderSubject("  Session bootstrap — describe current work  ")).toBe(true)
  })
})

describe("task-subject-validation detect() uses shared matcher", () => {
  test("rejects recovered task as placeholder", () => {
    const result = detect("Recovered task #5 (lost during compaction)")
    expect(result.matched).toBe(true)
    if (result.matched) {
      expect(result.intro).toContain("placeholder")
    }
  })

  test("rejects session bootstrap as placeholder", () => {
    const result = detect("Session bootstrap — describe current work")
    expect(result.matched).toBe(true)
    if (result.matched) {
      expect(result.intro).toContain("placeholder")
    }
  })

  test("allows real subjects through", () => {
    const result = detect("Fix authentication bug")
    expect(result.matched).toBe(false)
  })
})

describe("PLACEHOLDER_SUBJECT_RE is exported", () => {
  test("regex matches expected patterns", () => {
    expect(PLACEHOLDER_SUBJECT_RE.test("Recovered task #1")).toBe(true)
    expect(PLACEHOLDER_SUBJECT_RE.test("Session bootstrap")).toBe(true)
    expect(PLACEHOLDER_SUBJECT_RE.test("Normal task")).toBe(false)
  })
})
