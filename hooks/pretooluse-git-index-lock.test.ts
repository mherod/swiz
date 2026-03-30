import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GIT_INDEX_LOCK, joinGitPath } from "../src/git-helpers.ts"

const HOOK = "hooks/pretooluse-git-index-lock.ts"

// Create isolated temp git repos for testing.
// Use realpathSync after creation to resolve macOS /var → /private/var symlink
// so paths match what `git rev-parse --show-toplevel` returns in the hook subprocess.
let TMP = ""
let REPO_WITHOUT_LOCK = ""

/** Create a fresh git repo with a lock file, returning the resolved path. */
async function createLockedRepo(name: string): Promise<string> {
  const rawDir = join(TMP, name)
  mkdirSync(joinGitPath(rawDir), { recursive: true })
  const proc = Bun.spawn(["git", "init"], { cwd: rawDir, stdout: "pipe", stderr: "pipe" })
  await proc.exited
  const resolved = realpathSync(rawDir)
  writeFileSync(joinGitPath(resolved, GIT_INDEX_LOCK), "")
  return resolved
}

beforeAll(async () => {
  const rawTmp = join(tmpdir(), `swiz-git-lock-test-${process.pid}`)
  const rawClean = join(rawTmp, "repo-clean")
  mkdirSync(joinGitPath(rawClean), { recursive: true })
  const cleanProc = Bun.spawn(["git", "init"], { cwd: rawClean, stdout: "pipe", stderr: "pipe" })
  await cleanProc.exited
  TMP = realpathSync(rawTmp)
  REPO_WITHOUT_LOCK = realpathSync(rawClean)
})

afterAll(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true })
})

async function runHook(
  command: string,
  cwd: string
): Promise<{ decision?: string; reason?: string }> {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command },
    cwd,
  })
  const proc = Bun.spawn(["bun", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  await proc.stdin.write(payload)
  await proc.stdin.end()
  const [out] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited

  if (!out.trim()) return {}
  const parsed = JSON.parse(out.trim())
  const hso = parsed.hookSpecificOutput
  return {
    decision: hso?.permissionDecision ?? parsed.decision,
    reason: hso?.permissionDecisionReason ?? parsed.reason,
  }
}

describe("pretooluse-git-index-lock", () => {
  // Each auto-resolve test uses its own isolated repo to avoid concurrent lock contention.
  describe("auto-resolves stale locks (no active git process)", () => {
    test(
      "git status is allowed after stale lock auto-removal",
      async () => {
        const repo = await createLockedRepo("auto-resolve-status")
        const result = await runHook("git status", repo)
        expect(result.decision).toBe("allow")
        expect(result.reason).toContain("Auto-removed")
        expect(result.reason).toContain("index.lock")
      },
      { timeout: 30_000 }
    )

    test(
      "git commit is allowed after stale lock auto-removal",
      async () => {
        const repo = await createLockedRepo("auto-resolve-commit")
        const result = await runHook('git commit -m "test"', repo)
        expect(result.decision).toBe("allow")
        expect(result.reason).toContain("Auto-removed")
      },
      { timeout: 30_000 }
    )

    test(
      "git add is allowed after stale lock auto-removal",
      async () => {
        const repo = await createLockedRepo("auto-resolve-add")
        const result = await runHook("git add .", repo)
        expect(result.decision).toBe("allow")
      },
      { timeout: 30_000 }
    )

    test(
      "piped git command is allowed after stale lock auto-removal",
      async () => {
        const repo = await createLockedRepo("auto-resolve-piped")
        const result = await runHook("echo hello | git log", repo)
        expect(result.decision).toBe("allow")
      },
      { timeout: 30_000 }
    )

    test(
      "lock file is actually removed after auto-resolution",
      async () => {
        const repo = await createLockedRepo("auto-resolve-verify")
        await runHook("git status", repo)
        const lockPath = joinGitPath(repo, GIT_INDEX_LOCK)
        const exists = await Bun.file(lockPath).exists()
        expect(exists).toBe(false)
      },
      { timeout: 30_000 }
    )
  })

  describe("allows git commands when no lock", () => {
    test("git status is allowed", async () => {
      const result = await runHook("git status", REPO_WITHOUT_LOCK)
      expect(result.decision).toBeUndefined()
    })

    test("git commit is allowed", async () => {
      const result = await runHook('git commit -m "test"', REPO_WITHOUT_LOCK)
      expect(result.decision).toBeUndefined()
    })
  })

  describe("handles lock disappearing during check", () => {
    test("allows when lock is removed before hook runs", async () => {
      const repo = await createLockedRepo("disappear-before-hook")
      // Remove the lock before running the hook — simulates another process clearing it.
      rmSync(joinGitPath(repo, GIT_INDEX_LOCK), { force: true })
      const result = await runHook("git status", repo)
      // No lock → early exit with no output
      expect(result.decision).toBeUndefined()
    })
  })

  describe("passes through non-git commands", () => {
    test("bun test passes through", async () => {
      const repo = await createLockedRepo("passthrough-bun")
      const result = await runHook("bun test", repo)
      expect(result.decision).toBeUndefined()
    })

    test("ls passes through", async () => {
      const repo = await createLockedRepo("passthrough-ls")
      const result = await runHook("ls -la", repo)
      expect(result.decision).toBeUndefined()
    })

    test("non-shell tools pass through", async () => {
      const repo = await createLockedRepo("passthrough-read")
      const payload = JSON.stringify({
        tool_name: "Read",
        tool_input: { file_path: "/some/file" },
        cwd: repo,
      })
      const proc = Bun.spawn(["bun", HOOK], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
      await proc.stdin.write(payload)
      await proc.stdin.end()
      const [out] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      await proc.exited
      expect(out.trim()).toBe("")
    })
  })
})
