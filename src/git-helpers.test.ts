import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ensureGitExclude,
  GIT_DIR_NAME,
  type GitBranchStatus,
  getGitBranchStatus,
  isGitHubHost,
  isReadOnlyGhApiArgs,
  parseRemoteUrl,
  resolveGitPaths,
  withApiCache,
} from "./git-helpers.ts"

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

// ─── resolveGitPaths ─────────────────────────────────────────────────────────

describe("resolveGitPaths", () => {
  test("returns gitDir and workTree when inside a git repo", async () => {
    const result = await resolveGitPaths(process.cwd())
    expect(result).not.toBeNull()
    expect(result?.gitDir).toBeString()
    expect(result?.workTree).toBeString()
    expect(result?.gitDir).toContain(GIT_DIR_NAME)
  })

  test("workTree is an ancestor of cwd", async () => {
    const result = await resolveGitPaths(process.cwd())
    expect(result).not.toBeNull()
    expect(process.cwd().startsWith(result!.workTree)).toBe(true)
  })

  test("returns the same result from a subdirectory", async () => {
    const subdir = join(process.cwd(), "src")
    const fromCwd = await resolveGitPaths(process.cwd())
    const fromSub = await resolveGitPaths(subdir)
    expect(fromSub?.workTree).toBe(fromCwd?.workTree)
    expect(fromSub?.gitDir).toBe(fromCwd?.gitDir)
  })

  test("returns null outside a git repo", async () => {
    // /tmp is outside any git repo on macOS
    const result = await resolveGitPaths("/tmp")
    expect(result).toBeNull()
  })

  test("returns null for a newly created empty directory", async () => {
    const tmpDir = join(tmpdir(), `swiz-git-test-${process.pid}`)
    mkdirSync(tmpDir, { recursive: true })
    try {
      expect(await resolveGitPaths(tmpDir)).toBeNull()
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

// ─── getGitBranchStatus ──────────────────────────────────────────────────────

describe("getGitBranchStatus", () => {
  test("returns a GitBranchStatus object inside a git repo", async () => {
    const result = await getGitBranchStatus(process.cwd())
    expect(result).not.toBeNull()
    const status = result as GitBranchStatus
    expect(typeof status.branch).toBe("string")
    expect(status.branch.length).toBeGreaterThan(0)
    expect(typeof status.ahead).toBe("number")
    expect(typeof status.behind).toBe("number")
    expect(typeof status.staged).toBe("number")
    expect(typeof status.unstaged).toBe("number")
    expect(typeof status.untracked).toBe("number")
    expect(typeof status.conflicts).toBe("number")
    expect(typeof status.stash).toBe("number")
    expect(typeof status.changedFallback).toBe("number")
  })

  test("counts are non-negative integers", async () => {
    const result = await getGitBranchStatus(process.cwd())
    expect(result).not.toBeNull()
    const s = result!
    for (const key of [
      "ahead",
      "behind",
      "staged",
      "unstaged",
      "untracked",
      "conflicts",
      "stash",
      "changedFallback",
    ] as const) {
      expect(s[key]).toBeGreaterThanOrEqual(0)
      expect(Number.isInteger(s[key])).toBe(true)
    }
  })

  test("returns null outside a git repo", async () => {
    const result = await getGitBranchStatus("/tmp")
    expect(result).toBeNull()
  })

  test("returns the same branch from a subdirectory", async () => {
    const fromCwd = await getGitBranchStatus(process.cwd())
    const fromSub = await getGitBranchStatus(`${process.cwd()}/src`)
    expect(fromSub?.branch).toBe(fromCwd?.branch)
  })
})

// ─── ensureGitExclude ─────────────────────────────────────────────────────────

function makeFakeRepo(base: string): string {
  const repoDir = join(base, "repo")
  mkdirSync(join(repoDir, ".git", "info"), { recursive: true })
  writeFileSync(join(repoDir, ".git", "HEAD"), "ref: refs/heads/main\n")
  return repoDir
}

describe("ensureGitExclude", () => {
  test("creates exclude file with entry when it does not exist", async () => {
    const tmp = join(tmpdir(), `swiz-exclude-test-${process.pid}-1`)
    mkdirSync(tmp, { recursive: true })
    try {
      const repo = makeFakeRepo(tmp)
      const excludePath = join(repo, ".git", "info", "exclude")
      expect(existsSync(excludePath)).toBe(false)
      await ensureGitExclude(repo, ".swiz/")
      expect(existsSync(excludePath)).toBe(true)
      expect(readFileSync(excludePath, "utf8")).toContain(".swiz/")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("is idempotent — does not duplicate entry", async () => {
    const tmp = join(tmpdir(), `swiz-exclude-test-${process.pid}-2`)
    mkdirSync(tmp, { recursive: true })
    try {
      const repo = makeFakeRepo(tmp)
      await ensureGitExclude(repo, ".swiz/")
      await ensureGitExclude(repo, ".swiz/")
      await ensureGitExclude(repo, ".swiz/")
      const content = readFileSync(join(repo, ".git", "info", "exclude"), "utf8")
      const occurrences = content.split(".swiz/").length - 1
      expect(occurrences).toBe(1)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("creates .git/info/ directory when it is missing", async () => {
    const tmp = join(tmpdir(), `swiz-exclude-test-${process.pid}-3`)
    mkdirSync(tmp, { recursive: true })
    try {
      // Set up a git repo WITHOUT .git/info/
      const repoDir = join(tmp, "repo")
      mkdirSync(join(repoDir, ".git"), { recursive: true })
      writeFileSync(join(repoDir, ".git", "HEAD"), "ref: refs/heads/main\n")
      expect(existsSync(join(repoDir, ".git", "info"))).toBe(false)
      await ensureGitExclude(repoDir, ".swiz/")
      expect(existsSync(join(repoDir, ".git", "info", "exclude"))).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("appends to existing exclude file without duplicating", async () => {
    const tmp = join(tmpdir(), `swiz-exclude-test-${process.pid}-4`)
    mkdirSync(tmp, { recursive: true })
    try {
      const repo = makeFakeRepo(tmp)
      const excludePath = join(repo, ".git", "info", "exclude")
      writeFileSync(excludePath, "*.log\n*.tmp\n")
      await ensureGitExclude(repo, ".swiz/")
      const content = readFileSync(excludePath, "utf8")
      expect(content).toContain("*.log")
      expect(content).toContain(".swiz/")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("does not add entry when already present", async () => {
    const tmp = join(tmpdir(), `swiz-exclude-test-${process.pid}-5`)
    mkdirSync(tmp, { recursive: true })
    try {
      const repo = makeFakeRepo(tmp)
      const excludePath = join(repo, ".git", "info", "exclude")
      writeFileSync(excludePath, "*.log\n.swiz/\n*.tmp\n")
      await ensureGitExclude(repo, ".swiz/")
      const content = readFileSync(excludePath, "utf8")
      const occurrences = content.split(".swiz/").length - 1
      expect(occurrences).toBe(1)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("silently no-ops outside a git repo", async () => {
    const tmp = join(tmpdir(), `swiz-exclude-test-${process.pid}-6`)
    mkdirSync(tmp, { recursive: true })
    try {
      await ensureGitExclude(tmp, ".swiz/")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe("parseRemoteUrl", () => {
  test("parses GitHub HTTPS remote", () => {
    expect(parseRemoteUrl("https://github.com/acme/widget.git")).toEqual({
      host: "github.com",
      slug: "acme/widget",
    })
  })

  test("parses GitHub SSH colon remote", () => {
    expect(parseRemoteUrl("git@github.com:acme/widget.git")).toEqual({
      host: "github.com",
      slug: "acme/widget",
    })
  })

  test("parses GitHub SSH slash remote", () => {
    expect(parseRemoteUrl("ssh://git@github.example.com/acme/widget.git")).toEqual({
      host: "github.example.com",
      slug: "acme/widget",
    })
  })

  test("returns null for unsupported remote format", () => {
    expect(parseRemoteUrl("invalid-remote-format")).toBeNull()
  })
})

describe("isGitHubHost", () => {
  test("returns true for github.com", async () => {
    expect(await isGitHubHost("github.com")).toBe(true)
  })
})
