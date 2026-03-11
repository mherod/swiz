import { describe, expect, test } from "bun:test"
import { extractPrNumber, GH_PR_MERGE_RE } from "../hooks/hook-utils.ts"

// ── gh pr merge command detection ────────────────────────────────────────────
// These tests verify the regex and helper used by the scope gate hook to
// intercept `gh pr merge` commands (issue #212).

describe("GH_PR_MERGE_RE (scope gate — blocked commands)", () => {
  test("matches plain gh pr merge <number>", () => {
    expect(GH_PR_MERGE_RE.test("gh pr merge 1011")).toBe(true)
  })

  test("matches gh pr merge --squash variant", () => {
    expect(GH_PR_MERGE_RE.test("gh pr merge 42 --squash")).toBe(true)
  })

  test("matches gh pr merge --rebase variant", () => {
    expect(GH_PR_MERGE_RE.test("gh pr merge 42 --rebase 2>&1")).toBe(true)
  })

  test("matches gh pr merge --merge variant", () => {
    expect(GH_PR_MERGE_RE.test("gh pr merge 42 --merge")).toBe(true)
  })

  test("matches gh pr merge --auto --squash variant", () => {
    expect(GH_PR_MERGE_RE.test("gh pr merge 42 --auto --squash")).toBe(true)
  })

  test("matches gh pr merge in && chain", () => {
    expect(GH_PR_MERGE_RE.test("git push origin feat/x && gh pr merge 42 --squash")).toBe(true)
  })

  test("matches gh pr merge after heredoc body assignment", () => {
    const command = [
      "body=$(cat <<'EOF'",
      "## Summary",
      "- sample",
      "EOF",
      ")",
      'gh pr create --body "$body"',
      "gh pr merge 1072 --squash",
    ].join("\n")
    expect(GH_PR_MERGE_RE.test(command)).toBe(true)
  })
})

describe("GH_PR_MERGE_RE (scope gate — allowed commands)", () => {
  test("does not match gh pr view", () => {
    expect(GH_PR_MERGE_RE.test("gh pr view 42")).toBe(false)
  })

  test("does not match gh pr list", () => {
    expect(GH_PR_MERGE_RE.test("gh pr list --state open")).toBe(false)
  })

  test("does not match gh pr create", () => {
    expect(GH_PR_MERGE_RE.test("gh pr create --base main")).toBe(false)
  })

  test("does not match gh pr checks", () => {
    expect(GH_PR_MERGE_RE.test("gh pr checks 42")).toBe(false)
  })

  test("does not match git push origin main", () => {
    expect(GH_PR_MERGE_RE.test("git push origin main")).toBe(false)
  })

  test("does not match echo containing gh pr merge text", () => {
    expect(GH_PR_MERGE_RE.test('echo "run gh pr merge to finish"')).toBe(false)
  })
})

describe("extractPrNumber (used by scope gate for richer error messages)", () => {
  test("extracts PR number from gh pr merge <number>", () => {
    expect(extractPrNumber("gh pr merge 1011")).toBe("1011")
  })

  test("extracts PR number from gh pr merge <number> --squash", () => {
    expect(extractPrNumber("gh pr merge 42 --squash")).toBe("42")
  })

  test("extracts PR number from gh pr merge <number> --rebase", () => {
    expect(extractPrNumber("gh pr merge 99 --rebase 2>&1")).toBe("99")
  })

  test("returns null when no number present", () => {
    expect(extractPrNumber("gh pr merge --squash")).toBeNull()
  })
})
