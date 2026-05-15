import { describe, expect, test } from "bun:test"
import { replaceTaskGovernanceSynonyms } from "./task-governance-rephrasing.ts"

describe("replaceTaskGovernanceSynonyms", () => {
  test("rephrases task-governance wording through the shared rephraser", () => {
    expect(replaceTaskGovernanceSynonyms("Good task hygiene", () => 0)).toBe(
      "Brilliant task practice"
    )
  })

  test("stays stable within a five-minute window", () => {
    const originalNow = Date.now
    Date.now = () => 1_710_000_000_000
    try {
      const first = replaceTaskGovernanceSynonyms("Good task hygiene")
      const second = replaceTaskGovernanceSynonyms("Good task hygiene")
      expect(first).toBe(second)
      expect(first).not.toBe("Good task hygiene")
    } finally {
      Date.now = originalNow
    }
  })
})
