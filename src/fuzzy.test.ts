import { describe, expect, test } from "bun:test"
import { editDistance, suggest } from "./fuzzy.ts"

describe("editDistance", () => {
  test("identical strings have distance 0", () => {
    expect(editDistance("testing", "testing")).toBe(0)
  })

  test("single insertion", () => {
    expect(editDistance("tesing", "testing")).toBe(1)
  })

  test("single substitution", () => {
    expect(editDistance("tasting", "testing")).toBe(1)
  })

  test("empty string vs non-empty", () => {
    expect(editDistance("", "abc")).toBe(3)
    expect(editDistance("abc", "")).toBe(3)
  })

  test("completely different strings", () => {
    expect(editDistance("abc", "xyz")).toBe(3)
  })
})

describe("suggest", () => {
  const categories = new Set([
    "automation",
    "code-review",
    "communication",
    "data",
    "deployment",
    "design",
    "development",
    "git",
    "learning",
    "productivity",
    "research",
    "security",
    "testing",
    "uncategorized",
    "workflow",
    "writing",
  ])

  test("suggests correct match for 1-edit typo", () => {
    expect(suggest("tesing", categories)).toBe("testing")
  })

  test("suggests correct match for transposition", () => {
    expect(suggest("wirting", categories)).toBe("writing")
  })

  test("returns null for a completely unrelated string", () => {
    expect(suggest("zzzzzzzzzzzz", categories)).toBeNull()
  })

  test("returns null when input already matches exactly (caller should check set membership first)", () => {
    // exact match scores 0 — will be returned since 0 ≤ threshold
    expect(suggest("testing", categories)).toBe("testing")
  })

  test("CLI command suggestions — close typo", () => {
    const commands = new Set(["doctor", "dispatch", "install", "help", "status"])
    expect(suggest("doctr", commands)).toBe("doctor")
  })

  test("CLI command suggestions — no match for gibberish", () => {
    const commands = new Set(["doctor", "dispatch", "install", "help", "status"])
    expect(suggest("xyzqwerty", commands)).toBeNull()
  })
})
