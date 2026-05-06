import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GIT_INDEX_LOCK, joinGitPath } from "../src/git-helpers.ts"
import { neutralAgentEnv } from "../src/utils/test-utils.ts"

const HOOK = "hooks/pretooluse-git-index-lock.ts"

// Create isolated temp git repos for testing.
// Use realpathSync after creation to resolve macOS /var → /private/var symlink
// so paths match what `git rev-parse --show-toplevel` returns in the hook subprocess.
let TMP = ""
let REPO_WITHOUT_LOCK = ""

/** Create a fresh git repo with a lock file, returning the resolved path. */
async function createLockedRepo(name: string): Promise<string> {
  const rawDir = join(TMP, name)
  mkdirSync(rawDir, { recursive: true })
  const proc = Bun.spawn(["git", "init"], { cwd: rawDir, stdout: "pipe", stderr: "pipe" })
  await proc.exited
  const resolved = realpathSync(rawDir)
  await Bun.write(joinGitPath(resolved, GIT_INDEX_LOCK), "")
  return resolved
}

beforeAll(async () => {
  const rawTmp = join(tmpdir(), `swiz-git-lock-test-${process.pid}`)
  const rawClean = join(rawTmp, "repo-clean")
  mkdirSync(rawClean, { recursive: true })
  const cleanProc = Bun.spawn(["git", "init"], { cwd: rawClean, stdout: "pipe", stderr: "pipe" })
  await cleanProc.exited
  TMP = realpathSync(rawTmp)
  REPO_WITHOUT_LOCK = realpathSync(rawClean)
})

afterAll(async () => {
  if (TMP) {
    // Clear immutable flags before cleanup to avoid EPERM.
    try {
      await Bun.spawn(["chflags", "-R", "nouchg", TMP]).exited
    } catch {
      // ignore if no immutable files exist
    }
    try {
      await Bun.file(TMP).delete()
    } catch {
      // best-effort cleanup
    }
  }
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
    env: neutralAgentEnv(),
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

  describe("denies when lock cannot be removed", () => {
    test(
      "git command is denied after retries on an immutable lock",
      async () => {
        const repo = await createLockedRepo("deny-immutable")
        const lockPath = joinGitPath(repo, GIT_INDEX_LOCK)
        const gitDir = join(repo, ".git")
        // Make the lock file immutable so unlink will fail.
        // macOS: chflags uchg; Linux: chmod 000 on parent directory.
        try {
          const chflagsProc = Bun.spawn(["chflags", "uchg", lockPath], {
            stdout: "pipe",
            stderr: "pipe",
          })
          await chflagsProc.exited
          if (chflagsProc.exitCode !== 0) throw new Error("chflags failed")
        } catch {
          // Linux fallback: restrict the parent .git directory.
          Bun.spawnSync(["chmod", "500", gitDir])
        }
        const result = await runHook("git status", repo)
        expect(result.decision).toBe("deny")
        expect(result.reason).toContain("index.lock")
        expect(result.reason).toContain("removal attempts")
        // Restore permissions so cleanup can remove the repo.
        try {
          Bun.spawnSync(["chflags", "nouchg", lockPath])
        } catch {
          Bun.spawnSync(["chmod", "755", gitDir])
        }
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
      await Bun.file(joinGitPath(repo, GIT_INDEX_LOCK)).delete()
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
        env: neutralAgentEnv(),
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
