import { describe, expect, test } from "bun:test"
import { type CompoundMatch, detect, formatMessage } from "./task-subject-validation.ts"

describe("detect", () => {
  describe("recovered task rejection", () => {
    test("rejects subject starting with 'Recovered task'", () => {
      const result = detect("Recovered task #5")
      expect(result.matched).toBe(true)
      if (!result.matched) return
      expect(result.intro).toContain("placeholder")
      expect(result.suggestions.length).toBeGreaterThan(0)
    })

    test("rejects 'Recovered task' case-insensitively", () => {
      const result = detect("recovered task from compaction")
      expect(result.matched).toBe(true)
    })

    test("does not reject 'Recover' without the full word 'task'", () => {
      expect(detect("Recover the lost data").matched).toBe(false)
    })

    test("does not reject 'Recovered tasks' (plural — not a placeholder pattern)", () => {
      // The pattern is /^recovered task\b/i — word boundary after "task" means
      // "tasks" (extra 's') does NOT match.
      expect(detect("Recovered tasks for the sprint").matched).toBe(false)
    })
  })

  describe("compliance-gaming rejection", () => {
    test("rejects 'Ensure a task is in progress'", () => {
      const result = detect("Ensure a task is in progress")
      expect(result.matched).toBe(true)
      if (!result.matched) return
      expect(result.intro).toContain("task-management mechanics")
    })

    test("rejects 'Create a pending task before running bash'", () => {
      const result = detect("Create a pending task before running bash")
      expect(result.matched).toBe(true)
      if (!result.matched) return
      expect(result.intro).toContain("real work")
    })

    test("rejects 'Maintain tasks in pending state to satisfy hook'", () => {
      const result = detect("Maintain tasks in pending state to satisfy hook")
      expect(result.matched).toBe(true)
    })

    test("rejects 'Keep a task in progress to unblock gate'", () => {
      const result = detect("Keep a task in progress to unblock gate")
      expect(result.matched).toBe(true)
    })

    test("rejects 'Ensure tasks exist before editing'", () => {
      const result = detect("Ensure tasks exist before editing")
      expect(result.matched).toBe(true)
    })

    test("does not reject 'Create authentication task tracking'", () => {
      expect(detect("Create authentication task tracking").matched).toBe(false)
    })

    test("does not reject 'Ensure login flow handles errors'", () => {
      expect(detect("Ensure login flow handles errors").matched).toBe(false)
    })
  })

  describe("no match (single concern)", () => {
    test("plain imperative subject", () => {
      expect(detect("Fix authentication bug").matched).toBe(false)
    })

    test("short subject", () => {
      expect(detect("Add CI").matched).toBe(false)
    })

    test("update with single object", () => {
      expect(detect("Update README").matched).toBe(false)
    })

    test("and in non-action context is not compound", () => {
      // "merge" is not in ACTION_VERBS so second part is not an independent action
      expect(detect("Review and merge the PR").matched).toBe(false)
    })

    test("single issue hash is not compound", () => {
      expect(detect("Fix #123").matched).toBe(false)
    })
  })

  describe("multiple issue hashes", () => {
    test("two hashes are split", () => {
      const result = detect("Fix #123 and #456")
      expect(result.matched).toBe(true)
      if (!result.matched) return
      expect(result.suggestions).toHaveLength(2)
      expect(result.suggestions[0]).toContain("#123")
      expect(result.suggestions[1]).toContain("#456")
    })

    test("three hashes are split", () => {
      const result = detect("Address #10, #20, and #30")
      expect(result.matched).toBe(true)
      if (!result.matched) return
      expect(result.suggestions).toHaveLength(3)
    })
  })

  describe("comma-separated list (3+ items)", () => {
    test("three-item list is matched", () => {
      const result = detect("Fix the login, register, and logout flows")
      expect(result.matched).toBe(true)
      if (!result.matched) return
      expect(result.suggestions.length).toBeGreaterThanOrEqual(3)
    })

    test("shared trailing object: verb appended to each part", () => {
      const result = detect("Review, approve, and merge the PR")
      expect(result.matched).toBe(true)
      if (!result.matched) return
      // Each suggestion should reference the shared object "the PR"
      for (const s of result.suggestions) {
        expect(s.toLowerCase()).toContain("pr")
      }
    })

    test("suffix expansion: date list gets full context", () => {
      const result = detect(
        "Get usage breakdowns from billing console for Dec 2025, Jan 2026, Feb 2026"
      )
      expect(result.matched).toBe(true)
      if (!result.matched) return
      expect(result.suggestions).toHaveLength(3)
      expect(result.suggestions[0]).toContain("Dec 2025")
      expect(result.suggestions[1]).toContain("Jan 2026")
      expect(result.suggestions[2]).toContain("Feb 2026")
    })
  })

  describe("and-separated compound with two action verbs", () => {
    test("two independent action verbs are split", () => {
      const result = detect("Add feature and fix bug")
      expect(result.matched).toBe(true)
      if (!result.matched) return
      expect(result.suggestions).toHaveLength(2)
    })

    test("verb is prepended to each suggestion", () => {
      const result = detect("Add feature and fix bug")
      expect(result.matched).toBe(true)
      if (!result.matched) return
      // "Add feature" and "Fix bug" should appear
      expect(result.suggestions.some((s) => /feature/i.test(s))).toBe(true)
      expect(result.suggestions.some((s) => /fix/i.test(s))).toBe(true)
    })

    test("non-action second part is not compound", () => {
      // "verify" is excluded from ACTION_VERBS intentionally
      expect(detect("Add feature and verify it works").matched).toBe(false)
    })
  })

  describe("test task pairing", () => {
    test("write tests for multi-item suffix sets pairing flag", () => {
      const result = detect("Write ScopeInsufficientError retry tests for cal, mail, and contacts")
      expect(result.matched).toBe(true)
      if (!result.matched) return
      expect(result.pairing).toBe(true)
      expect(result.suggestions).toHaveLength(3)
      // Suggestions use the original verb, not mangled phrasing
      expect(result.suggestions[0]).toContain("Write")
      expect(result.suggestions[1]).toContain("Write")
      expect(result.suggestions[2]).toContain("Write")
    })

    test("pairing intro advises updating existing tasks", () => {
      const result = detect("Write ScopeInsufficientError retry tests for cal, mail, and contacts")
      expect(result.matched).toBe(true)
      if (!result.matched) return
      expect(result.intro).toContain("update them to include tests")
      expect(result.intro).not.toContain("compound task")
    })

    test("non-test multi-item split keeps regular message and no pairing flag", () => {
      const result = detect("Add ScopeInsufficientError retry to cal, mail, and contacts")
      expect(result.matched).toBe(true)
      if (!result.matched) return
      expect(result.intro).toContain("compound task")
      expect(result.pairing).toBeUndefined()
    })

    test("add test cases suffix pattern triggers pairing", () => {
      const result = detect("Add test cases for login, logout, and register flows")
      expect(result.matched).toBe(true)
      if (!result.matched) return
      expect(result.pairing).toBe(true)
      expect(result.intro).toContain("update them to include tests")
      expect(result.suggestions[0]).toContain("login")
    })
  })

  describe("brackets and punctuation", () => {
    test("parenthesized qualifier does not trigger compound detection", () => {
      expect(detect("Fix authentication (OAuth) bug").matched).toBe(false)
    })

    test("square brackets in subject do not trigger compound detection", () => {
      expect(detect("Update [WIP] login page").matched).toBe(false)
    })

    test("colon after verb with comma list still triggers compound", () => {
      const result = detect("Fix: login, register, and logout")
      expect(result.matched).toBe(true)
      if (!result.matched) return
      expect(result.suggestions.length).toBeGreaterThanOrEqual(3)
    })

    test("semicolons are not treated as separators", () => {
      // Semicolons are not handled; this should not match as compound
      expect(detect("Fix login; update register").matched).toBe(false)
    })

    test("exclamation mark does not affect detection", () => {
      expect(detect("Fix the critical auth bug!").matched).toBe(false)
    })

    test("slashes in paths do not trigger detection", () => {
      expect(detect("Fix src/components/Login.tsx rendering").matched).toBe(false)
    })

    test("curly braces in subject pass through without detection", () => {
      expect(detect("Update {config} template values").matched).toBe(false)
    })

    test("multiple issue hashes with parentheses are still split", () => {
      const result = detect("Fix #123 (login) and #456 (logout)")
      expect(result.matched).toBe(true)
      if (!result.matched) return
      expect(result.suggestions).toHaveLength(2)
      expect(result.suggestions[0]).toContain("#123")
      expect(result.suggestions[1]).toContain("#456")
    })

    test("comma list with parenthesized details preserves context", () => {
      const result = detect("Fix the login (OAuth), register (email), and logout (session) flows")
      expect(result.matched).toBe(true)
      if (!result.matched) return
      expect(result.suggestions.length).toBeGreaterThanOrEqual(3)
    })

    test("hyphenated compound words are not split", () => {
      expect(detect("Add re-authentication flow").matched).toBe(false)
    })
  })
})

describe("formatMessage", () => {
  test("formats intro and bullet list", () => {
    const match: CompoundMatch = {
      matched: true,
      intro: "This is a compound task. Suggested split:",
      suggestions: ["Fix login bug", "Fix logout bug"],
    }
    const msg = formatMessage(match)
    expect(msg).toContain("compound task")
    expect(msg).toContain("• Fix login bug")
    expect(msg).toContain("• Fix logout bug")
  })

  test("appends optional postfix", () => {
    const match: CompoundMatch = {
      matched: true,
      intro: "Split:",
      suggestions: ["Task A", "Task B"],
    }
    const msg = formatMessage(match, "Please create separate tasks.")
    expect(msg).toContain("Please create separate tasks.")
  })
})
