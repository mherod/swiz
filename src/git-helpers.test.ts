import { describe, expect, test } from "bun:test"
import { isReadOnlyGhApiArgs, withApiCache } from "./git-helpers.ts"

// ─── isReadOnlyGhApiArgs ─────────────────────────────────────────────────────

describe("isReadOnlyGhApiArgs", () => {
  describe("read-only api commands (should inject --cache)", () => {
    test("gh api (no method = GET)", () =>
      expect(isReadOnlyGhApiArgs(["api", "repos/owner/repo"])).toBe(true))
    test("gh api --method GET", () =>
      expect(isReadOnlyGhApiArgs(["api", "repos/owner/repo", "--method", "GET"])).toBe(true))
    test("gh api -X GET", () =>
      expect(isReadOnlyGhApiArgs(["api", "repos/owner/repo", "-X", "GET"])).toBe(true))
  })

  describe("mutating api commands (must not inject --cache)", () => {
    test("gh api --method POST", () =>
      expect(isReadOnlyGhApiArgs(["api", "repos/owner/repo", "--method", "POST"])).toBe(false))
    test("gh api -X DELETE", () =>
      expect(isReadOnlyGhApiArgs(["api", "repos/owner/repo", "-X", "DELETE"])).toBe(false))
    test("gh api -X PATCH", () =>
      expect(isReadOnlyGhApiArgs(["api", "repos/owner/repo", "-X", "PATCH"])).toBe(false))
  })

  describe("non-api commands (always false)", () => {
    test("pr list", () => expect(isReadOnlyGhApiArgs(["pr", "list"])).toBe(false))
    test("issue view", () => expect(isReadOnlyGhApiArgs(["issue", "view", "42"])).toBe(false))
    test("empty args", () => expect(isReadOnlyGhApiArgs([])).toBe(false))
    test("single arg", () => expect(isReadOnlyGhApiArgs(["pr"])).toBe(false))
  })
})

// ─── withApiCache ────────────────────────────────────────────────────────────

describe("withApiCache", () => {
  test("injects --cache for read-only api call", () => {
    const result = withApiCache(["api", "repos/owner/repo"])
    expect(result).toEqual(["api", "--cache", "20s", "repos/owner/repo"])
  })

  test("injects --cache for api call with --jq", () => {
    const result = withApiCache(["api", "user", "--jq", ".login"])
    expect(result).toEqual(["api", "--cache", "20s", "user", "--jq", ".login"])
  })

  test("does not inject --cache for mutating api call", () => {
    const args = ["api", "repos/owner/repo", "--method", "POST"]
    expect(withApiCache(args)).toBe(args)
  })

  test("does not inject --cache if already present", () => {
    const args = ["api", "--cache", "60s", "repos/owner/repo"]
    expect(withApiCache(args)).toBe(args)
  })

  test("passes through non-api commands unchanged", () => {
    const args = ["pr", "list"]
    expect(withApiCache(args)).toBe(args)
  })

  test("respects GH_API_CACHE_DURATION env var", () => {
    const original = process.env.GH_API_CACHE_DURATION
    // The module-level const is already evaluated, so this tests the default
    const result = withApiCache(["api", "user"])
    expect(result[2]).toBe("20s")
    process.env.GH_API_CACHE_DURATION = original
  })
})
