import { describe, expect, test } from "bun:test"
import { runBashHook } from "../src/utils/test-utils.ts"

const HOOK = "hooks/pretooluse-no-merge-conflict-comments.ts"

function runHook(command: string) {
  return runBashHook(HOOK, command)
}

// ─── gh pr comment path ──────────────────────────────────────────────────────

describe("pretooluse-no-merge-conflict-comments — gh pr comment", () => {
  test("blocks a comment that only says merge conflict + please rebase", async () => {
    const result = await runHook(
      'gh pr comment 42 --body "This PR has merge conflicts. Please rebase your branch."'
    )
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("merge-conflict")
  })

  test("blocks a short conflict-only body", async () => {
    const result = await runHook('gh pr comment 1 --body "needs a rebase"')
    expect(result.decision).toBe("deny")
  })

  test("allows a comment with substantive review content beyond the conflict notice", async () => {
    const result = await runHook(
      'gh pr comment 42 --body "The validation logic on line 42 uses the wrong comparator and will pass null inputs. Please fix that, and also rebase your branch."'
    )
    expect(result.decision).toBe("allow")
  })

  test("allows unrelated comments", async () => {
    const result = await runHook(
      'gh pr comment 7 --body "LGTM, nice work! A small nit: prefer const over let on line 5."'
    )
    expect(result.decision).toBe("allow")
  })
})

// ─── gh pr review --comment path ─────────────────────────────────────────────

describe("pretooluse-no-merge-conflict-comments — gh pr review", () => {
  test("blocks a review comment that only discusses conflicts", async () => {
    const result = await runHook(
      'gh pr review 10 --comment --body "Branch is behind main. Please rebase onto main before merging."'
    )
    expect(result.decision).toBe("deny")
  })

  test("allows a review comment with substantive content", async () => {
    const result = await runHook(
      'gh pr review 10 --comment --body "Great approach overall. The error handling in the retry loop will suppress network timeouts — consider wrapping in a separate try/catch."'
    )
    expect(result.decision).toBe("allow")
  })
})

// ─── gh api POST path ─────────────────────────────────────────────────────────

describe("pretooluse-no-merge-conflict-comments — gh api POST", () => {
  test("blocks gh api issues comments with conflict-only body", async () => {
    const result = await runHook(
      'gh api repos/owner/repo/issues/42/comments --method POST --field body="This PR has merge conflicts. Please rebase your branch to resolve them before it can be merged."'
    )
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("merge-conflict")
  })

  test("blocks gh api pulls comments with conflict-only body", async () => {
    const result = await runHook(
      'gh api repos/owner/repo/pulls/7/comments --method POST --field body="Needs a rebase."'
    )
    expect(result.decision).toBe("deny")
  })

  test("allows gh api issues comments with substantive content", async () => {
    const result = await runHook(
      'gh api repos/owner/repo/issues/42/comments --method POST --field body="The schema migration in this PR will fail if the table does not exist yet. Add a conditional check before the ALTER TABLE statement."'
    )
    expect(result.decision).toBe("allow")
  })

  test("allows gh api calls to unrelated endpoints", async () => {
    const result = await runHook("gh api repos/owner/repo/pulls/42 --field state=closed")
    expect(result.decision).toBeUndefined()
  })

  test("does not block gh api GET to comments endpoint (no --field body)", async () => {
    const result = await runHook("gh api repos/owner/repo/issues/42/comments")
    expect(result.decision).toBeUndefined()
  })
})

// ─── NFKC normalization ───────────────────────────────────────────────────────

describe("pretooluse-no-merge-conflict-comments — NFKC normalization", () => {
  test("blocks body containing full-width characters that normalize to conflict phrases", async () => {
    // "merge" spelled with full-width letters: ｍｅｒｇｅ → NFKC normalizes to ASCII
    const result = await runHook('gh pr comment 5 --body "ｍｅｒｇｅ conflict — please rebase"')
    expect(result.decision).toBe("deny")
  })
})
