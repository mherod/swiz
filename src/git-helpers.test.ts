import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ghCacheKey, isReadOnlyGhArgs, readGhCache, writeGhCache } from "./git-helpers.ts"

// ─── isReadOnlyGhArgs ────────────────────────────────────────────────────────

describe("isReadOnlyGhArgs", () => {
  describe("read-only commands (should cache)", () => {
    test("pr list", () => expect(isReadOnlyGhArgs(["pr", "list"])).toBe(true))
    test("pr view", () => expect(isReadOnlyGhArgs(["pr", "view", "123"])).toBe(true))
    test("pr checks", () => expect(isReadOnlyGhArgs(["pr", "checks", "123"])).toBe(true))
    test("pr diff", () => expect(isReadOnlyGhArgs(["pr", "diff"])).toBe(true))
    test("issue list", () => expect(isReadOnlyGhArgs(["issue", "list"])).toBe(true))
    test("issue view", () => expect(isReadOnlyGhArgs(["issue", "view", "42"])).toBe(true))
    test("run list", () => expect(isReadOnlyGhArgs(["run", "list"])).toBe(true))
    test("run view", () => expect(isReadOnlyGhArgs(["run", "view", "99"])).toBe(true))
    test("repo view", () => expect(isReadOnlyGhArgs(["repo", "view"])).toBe(true))
    test("gh api (no method = GET)", () =>
      expect(isReadOnlyGhArgs(["api", "repos/owner/repo"])).toBe(true))
    test("gh api --method GET", () =>
      expect(isReadOnlyGhArgs(["api", "repos/owner/repo", "--method", "GET"])).toBe(true))
    test("gh api -X GET", () =>
      expect(isReadOnlyGhArgs(["api", "repos/owner/repo", "-X", "GET"])).toBe(true))
  })

  describe("mutating commands (must not cache)", () => {
    test("pr create", () => expect(isReadOnlyGhArgs(["pr", "create"])).toBe(false))
    test("pr merge", () => expect(isReadOnlyGhArgs(["pr", "merge", "123"])).toBe(false))
    test("pr comment", () => expect(isReadOnlyGhArgs(["pr", "comment"])).toBe(false))
    test("pr edit", () => expect(isReadOnlyGhArgs(["pr", "edit"])).toBe(false))
    test("pr close", () => expect(isReadOnlyGhArgs(["pr", "close"])).toBe(false))
    test("pr review", () => expect(isReadOnlyGhArgs(["pr", "review"])).toBe(false))
    test("issue create", () => expect(isReadOnlyGhArgs(["issue", "create"])).toBe(false))
    test("issue comment", () => expect(isReadOnlyGhArgs(["issue", "comment"])).toBe(false))
    test("issue close", () => expect(isReadOnlyGhArgs(["issue", "close"])).toBe(false))
    test("issue edit", () => expect(isReadOnlyGhArgs(["issue", "edit"])).toBe(false))
    test("run cancel", () => expect(isReadOnlyGhArgs(["run", "cancel"])).toBe(false))
    test("gh api --method POST", () =>
      expect(isReadOnlyGhArgs(["api", "repos/owner/repo", "--method", "POST"])).toBe(false))
    test("gh api -X DELETE", () =>
      expect(isReadOnlyGhArgs(["api", "repos/owner/repo", "-X", "DELETE"])).toBe(false))
    test("gh api -X PATCH", () =>
      expect(isReadOnlyGhArgs(["api", "repos/owner/repo", "-X", "PATCH"])).toBe(false))
    test("empty args", () => expect(isReadOnlyGhArgs([])).toBe(false))
    test("single arg", () => expect(isReadOnlyGhArgs(["pr"])).toBe(false))
  })
})

// ─── ghCacheKey ──────────────────────────────────────────────────────────────

describe("ghCacheKey", () => {
  test("returns a hex string", () => {
    const key = ghCacheKey(["pr", "list"], "abc123")
    expect(key).toMatch(/^[0-9a-f]+$/)
  })

  test("same args + cwd → same key", () => {
    const k1 = ghCacheKey(["pr", "list", "--json", "number"], "abc")
    const k2 = ghCacheKey(["pr", "list", "--json", "number"], "abc")
    expect(k1).toBe(k2)
  })

  test("different args → different keys", () => {
    const k1 = ghCacheKey(["pr", "list"], "abc")
    const k2 = ghCacheKey(["issue", "list"], "abc")
    expect(k1).not.toBe(k2)
  })

  test("different cwd → different keys", () => {
    const k1 = ghCacheKey(["pr", "list"], "abc")
    const k2 = ghCacheKey(["pr", "list"], "xyz")
    expect(k1).not.toBe(k2)
  })
})

// ─── readGhCache / writeGhCache ───────────────────────────────────────────────

describe("cache I/O", () => {
  function tempDir(): string {
    const dir = join(tmpdir(), `gh-cache-test-${process.pid}-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  test("returns null when cache file missing", () => {
    const dir = tempDir()
    expect(readGhCache("nonexistent", dir)).toBeNull()
  })

  test("write then read returns cached value (within TTL)", () => {
    const dir = tempDir()
    const key = "test-key-hit"
    writeGhCache(key, '[{"number":42}]', dir)
    const result = readGhCache(key, dir)
    expect(result).toBe('[{"number":42}]')
  })

  test("returns null when cache entry is expired", () => {
    const dir = tempDir()
    const key = "test-key-expired"
    // Write a cache file with timestamp far in the past
    const entry = { output: "stale", timestamp: Date.now() - 999_999 }
    writeFileSync(join(dir, `${key}.json`), JSON.stringify(entry))
    expect(readGhCache(key, dir)).toBeNull()
  })

  test("returns null when cache file is corrupt JSON", () => {
    const dir = tempDir()
    const key = "test-key-corrupt"
    writeFileSync(join(dir, `${key}.json`), "not-json{{{")
    expect(readGhCache(key, dir)).toBeNull()
  })

  test("writeGhCache creates directory if missing", () => {
    const dir = join(tmpdir(), `gh-cache-mkdir-${process.pid}-${Date.now()}`, "nested")
    // dir does not exist yet; writeGhCache should create it
    expect(() => writeGhCache("k", "v", dir)).not.toThrow()
    expect(readGhCache("k", dir)).toBe("v")
  })
})
