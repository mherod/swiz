import { describe, expect, test } from "bun:test"
import {
  normalizeSubject,
  significantWords,
  subjectsOverlap,
} from "../hooks/stop-completion-auditor.ts"

describe("normalizeSubject", () => {
  test("lowercases and strips punctuation", () => {
    expect(normalizeSubject("Push backward-compat error commit")).toBe(
      "push backward compat error commit"
    )
  })

  test("collapses multiple spaces", () => {
    expect(normalizeSubject("Verify  CI   for  commit")).toBe("verify ci for commit")
  })

  test("strips special characters", () => {
    expect(normalizeSubject("Task #98: Push (main)")).toBe("task 98 push main")
  })
})

describe("significantWords", () => {
  test("filters out stop words and short tokens", () => {
    const words = significantWords("push the backward compat error commit to main")
    expect(words.has("push")).toBe(true)
    expect(words.has("backward")).toBe(true)
    expect(words.has("commit")).toBe(true)
    expect(words.has("the")).toBe(false) // stop word
    expect(words.has("to")).toBe(false) // stop word
  })

  test("filters tokens with 2 or fewer characters", () => {
    const words = significantWords("ci is ok go")
    expect(words.has("is")).toBe(false) // stop word
    expect(words.has("ok")).toBe(false) // too short (2 chars)
    expect(words.has("go")).toBe(false) // too short
  })
})

describe("subjectsOverlap", () => {
  test("detects overlapping task subjects", () => {
    expect(
      subjectsOverlap(
        normalizeSubject("Push backward-compat error commit"),
        normalizeSubject("Push backward-compat commit")
      )
    ).toBe(true)
  })

  test("detects verify CI duplicates", () => {
    expect(
      subjectsOverlap(
        normalizeSubject("Verify CI for backward-compat commit"),
        normalizeSubject("Verify CI for commit 11afbc8")
      )
    ).toBe(true)
  })

  test("rejects unrelated subjects", () => {
    expect(
      subjectsOverlap(
        normalizeSubject("Push backward-compat error commit"),
        normalizeSubject("Implement stale-task deduplication")
      )
    ).toBe(false)
  })

  test("rejects when one subject is empty", () => {
    expect(subjectsOverlap("", normalizeSubject("Push commit"))).toBe(false)
  })

  test("handles identical subjects", () => {
    const s = normalizeSubject("Verify CI status")
    expect(subjectsOverlap(s, s)).toBe(true)
  })

  test("handles subjects with different word order", () => {
    expect(
      subjectsOverlap(
        normalizeSubject("Commit and push CLAUDE.md update"),
        normalizeSubject("Push CLAUDE.md commit update")
      )
    ).toBe(true)
  })
})
