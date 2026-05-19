import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { GIT_INDEX_LOCK, joinGitPath } from "../src/git-helpers.ts"
import { neutralAgentEnv } from "../src/utils/test-utils.ts"

const REPO_ROOT = resolve(import.meta.dir, "..")
const HOOK = join(REPO_ROOT, "hooks", "pretooluse-git-index-lock.ts")

// Create isolated temp git repos for testing.
// Use realpathSync after creation to resolve macOS /var → /private/var symlink
// so paths match what `git rev-parse --show-toplevel` returns in the hook subprocess.
let TMP = ""
let REPO_WITHOUT_LOCK = ""

/** Create a fresh git repo with a lock file, returning the resolved path. */
async function createLockedRepo(name: string): Promise<string> {
  const rawDir = join(TMP, name)
  mkdirSync(rawDir, { recursive: true })
  await runCommandOutput(["git", "init"], rawDir)
  const resolved = realpathSync(rawDir)
  await Bun.write(joinGitPath(resolved, GIT_INDEX_LOCK), "")
  return resolved
}

async function runCommandOutput(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: neutralAgentEnv(),
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  if (proc.exitCode !== 0) {
    throw new Error(`${args.join(" ")} failed: ${stderr}`)
  }
  return stdout.trim()
}

async function createLockedWorktree(name: string): Promise<{ worktree: string; lockPath: string }> {
  const mainRaw = join(TMP, `${name}-main`)
  const worktreeRaw = join(TMP, `${name}-worktree`)
  mkdirSync(mainRaw, { recursive: true })
  await runCommandOutput(["git", "init"], mainRaw)
  await runCommandOutput(
    [
      "git",
      "-c",
      "user.name=Swiz Test",
      "-c",
      "user.email=swiz-test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "init",
    ],
    mainRaw
  )
  await runCommandOutput(["git", "worktree", "add", worktreeRaw], mainRaw)

  const worktree = realpathSync(worktreeRaw)
  const gitDir = await runCommandOutput(["git", "rev-parse", "--absolute-git-dir"], worktree)
  const lockPath = join(gitDir, GIT_INDEX_LOCK)
  await Bun.write(lockPath, "")
  return { worktree, lockPath }
}

beforeAll(async () => {
  const rawTmp = join(tmpdir(), `swiz-git-lock-test-${process.pid}`)
  const rawClean = join(rawTmp, "repo-clean")
  mkdirSync(rawClean, { recursive: true })
  await runCommandOutput(["git", "init"], rawClean)
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
    cwd: REPO_ROOT,
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

    test(
      "worktree lock is resolved from the dispatching directory git dir",
      async () => {
        const { worktree, lockPath } = await createLockedWorktree("auto-resolve-worktree")
        const result = await runHook("git status", worktree)
        expect(result.decision).toBe("allow")
        expect(await Bun.file(lockPath).exists()).toBe(false)
      },
      { timeout: 30_000 }
    )
  })

  describe("denies when lock cannot be removed", () => {
    test(
      "git command is allowed when transient permissions release before deadline",
      async () => {
        const repo = await createLockedRepo("transient-permission-release")
        const gitDir = join(repo, ".git")
        Bun.spawnSync(["chmod", "500", gitDir])
        const restoreProc = Bun.spawn(
          [
            "bun",
            "-e",
            `await Bun.sleep(900); Bun.spawnSync(["chmod", "755", ${JSON.stringify(gitDir)}]);`,
          ],
          {
            stdout: "ignore",
            stderr: "ignore",
            env: neutralAgentEnv(),
          }
        )

        try {
          const result = await runHook("git status", repo)
          expect(result.decision).toBe("allow")
          expect(result.reason).toContain("Auto-removed")
        } finally {
          Bun.spawnSync(["chmod", "755", gitDir])
          await restoreProc.exited
        }
      },
      { timeout: 30_000 }
    )

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
        expect(result.reason).toContain("retrying for up to 10s")
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
        cwd: REPO_ROOT,
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
