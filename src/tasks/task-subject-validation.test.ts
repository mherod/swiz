import { describe, expect, test } from "bun:test"
import { type CompoundMatch, detect, formatMessage } from "./task-subject-validation.ts"

function withHome<T>(home: string | undefined, fn: () => T): T {
  const previousHome = process.env.HOME
  if (home === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = home
  }

  try {
    return fn()
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = previousHome
    }
  }
}

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
    test("rejects task tool names without echoing the tripped tool", () => {
      const result = detect("TaskCreate for issue work")
      expect(result.matched).toBe(true)
      if (!result.matched) return
      expect(result.intro).toContain("bookkeeping")
      expect(result.intro).not.toContain("TaskCreate")
    })

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

  describe("deferral rejection", () => {
    test("rejects leading Defer issue subjects", () => {
      const result = detect("Defer #1727")
      expect(result.matched).toBe(true)
      if (!result.matched) return
      expect(result.intro).toContain("avoiding the work")
      expect(result.intro).not.toContain("subject")
    })

    test("rejects deferred task marker example", () => {
      const result = detect("◼ Defer #1727 campaign PUT sba_user_ids wipe to next session")
      expect(result.matched).toBe(true)
      if (!result.matched) return
      expect(result.intro).toContain("Do the work now")
    })

    test("rejects next-session destination phrase", () => {
      const result = detect("Move campaign PUT sba_user_ids wipe to next session")
      expect(result.matched).toBe(true)
      if (!result.matched) return
      expect(result.intro).toContain("concrete blocker with evidence")
    })

    test("does not reject technical deferred loading work", () => {
      expect(detect("Implement deferred image loading").matched).toBe(false)
    })

    test("rejects Future: prefix as deferral tactic", () => {
      const result = detect("Future: add retry logic to payment processor")
      expect(result.matched).toBe(true)
      if (!result.matched) return
      expect(result.intro).toContain("avoiding the work")
    })

    test("rejects Future: prefix case-insensitively", () => {
      expect(detect("FUTURE: migrate to new auth provider").matched).toBe(true)
      expect(detect("future: clean up legacy endpoints").matched).toBe(true)
    })

    test("rejects Future: with extra whitespace before colon", () => {
      expect(detect("Future : refactor billing module").matched).toBe(true)
    })

    test("rejects leading 'Next session:' prefix as deferral tactic", () => {
      const result = detect("Next session: resolve issue #52 Dependabot security alerts")
      expect(result.matched).toBe(true)
      if (!result.matched) return
      expect(result.intro).toContain("avoiding the work")
    })

    test("rejects 'Next session:' prefix without colon", () => {
      expect(detect("Next session fix issue #43").matched).toBe(true)
    })

    test("rejects bullet-prefixed 'Next session:' deferral", () => {
      expect(detect("◻ Next session: fix issue #49 Zod v4 migration").matched).toBe(true)
    })

    test("rejects issue-selection labels as deferral tactics", () => {
      expect(detect("◻ Pick next issue: feat(posts) archive controls (#1717)").matched).toBe(true)
      expect(detect("◻ Consider issue #633: reduce governance complexity").matched).toBe(true)
      expect(detect("Candidate issue #700: improve CI output").matched).toBe(true)
      expect(detect("Maybe issue #701 if time").matched).toBe(true)
      expect(detect("Fix issue #702 after this session").matched).toBe(true)
    })

    test("deferral rejection steers firmly without exposing trigger wording", () => {
      const result = detect("◻ Consider issue #633: reduce governance complexity")
      expect(result.matched).toBe(true)
      if (!result.matched) return
      const message = formatMessage(result)
      expect(message).toContain("deferral tactic")
      expect(message).toContain("unacceptable")
      expect(message).toContain("Do the work now")
      expect(message.toLowerCase()).not.toContain("consider issue")
      expect(message.toLowerCase()).not.toContain("pick next issue")
      expect(message.toLowerCase()).not.toContain("future:")
      expect(message.toLowerCase()).not.toContain("later:")
    })

    test("rejects Follow-up subjects that defer to next session", () => {
      expect(detect("Follow-up: pick up #641 at next session start").matched).toBe(true)
      expect(detect("Follow-up: pick up #637 CI retry backoff at next session").matched).toBe(true)
    })

    test("rejects Later/Backlog/TODO/Postponed/Punt prefixes as deferral tactics", () => {
      expect(detect("Later: add metrics dashboard").matched).toBe(true)
      expect(detect("Backlog: rework auth flow").matched).toBe(true)
      expect(detect("TODO: refactor billing").matched).toBe(true)
      expect(detect("Postponed: migrate to Postgres").matched).toBe(true)
      expect(detect("Punt: investigate flaky test").matched).toBe(true)
      expect(detect("Tomorrow: send weekly digest").matched).toBe(true)
    })

    test("does not reject legitimate work mentioning 'session' or 'future'", () => {
      expect(detect("Add session token refresh logic").matched).toBe(false)
      expect(detect("Refactor future-proofing helpers").matched).toBe(false)
    })

    test("rejects Follow-up prefix (all Follow-up: tasks are deferrals)", () => {
      expect(detect("Follow-up: docs for new flag").matched).toBe(true)
    })
  })

  describe("home directory rejection", () => {
    test("rejects literal home directory paths", () => {
      withHome("/Users/example", () => {
        const result = detect("Edit /Users/example/Development/swiz/src/tasks/file.ts")
        expect(result.matched).toBe(true)
        if (!result.matched) return
        expect(result.intro).toContain("home directory")
        expect(result.suggestions).toContain("Edit src/tasks/task-subject-validation.ts")
      })
    })

    test("rejects symbolic home directory paths", () => {
      expect(detect("Inspect ~/.claude/tasks/session")).toMatchObject({ matched: true })
      expect(detect("Inspect $HOME/.claude/tasks/session")).toMatchObject({ matched: true })
      expect(detect("Inspect ${HOME}/.claude/tasks/session")).toMatchObject({ matched: true })
    })

    test("does not reject repo-relative paths", () => {
      withHome("/Users/example", () => {
        expect(detect("Edit src/tasks/task-subject-validation.ts").matched).toBe(false)
      })
    })

    test("does not reject path prefixes that only resemble home", () => {
      withHome("/Users/example", () => {
        expect(detect("Inspect /Users/example-work/project").matched).toBe(false)
      })
    })

    test("does not reject approximate counts with tilde", () => {
      expect(detect("Audit ~10 task subjects").matched).toBe(false)
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
