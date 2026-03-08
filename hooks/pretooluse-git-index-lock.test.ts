import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GIT_INDEX_LOCK, joinGitPath } from "../src/git-helpers.ts"

const HOOK = "hooks/pretooluse-git-index-lock.ts"

// Create isolated temp git repos for testing.
const TMP = join(tmpdir(), `swiz-git-lock-test-${process.pid}`)
const REPO_WITH_LOCK = join(TMP, "repo-locked")
const REPO_WITHOUT_LOCK = join(TMP, "repo-clean")

beforeAll(async () => {
  mkdirSync(joinGitPath(REPO_WITH_LOCK), { recursive: true })
  mkdirSync(joinGitPath(REPO_WITHOUT_LOCK), { recursive: true })
  // Create a lock file in the locked repo.
  writeFileSync(joinGitPath(REPO_WITH_LOCK, GIT_INDEX_LOCK), "")

  // Initialize real git repos so `git rev-parse --show-toplevel` works.
  for (const dir of [REPO_WITH_LOCK, REPO_WITHOUT_LOCK]) {
    const proc = Bun.spawn(["git", "init"], { cwd: dir, stdout: "pipe", stderr: "pipe" })
    await proc.exited
  }
  // Re-create the lock file after git init (init may have cleaned it).
  writeFileSync(joinGitPath(REPO_WITH_LOCK, GIT_INDEX_LOCK), "")
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
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
  proc.stdin.write(payload)
  proc.stdin.end()
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
  describe("blocks git commands when lock exists", () => {
    test("git status is denied", async () => {
      const result = await runHook("git status", REPO_WITH_LOCK)
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("index.lock")
    })

    test("git commit is denied", async () => {
      const result = await runHook('git commit -m "test"', REPO_WITH_LOCK)
      expect(result.decision).toBe("deny")
    })

    test("git add is denied", async () => {
      const result = await runHook("git add .", REPO_WITH_LOCK)
      expect(result.decision).toBe("deny")
    })

    test("piped git command is denied", async () => {
      const result = await runHook("echo hello | git log", REPO_WITH_LOCK)
      expect(result.decision).toBe("deny")
    })

    test("reason includes resolution steps", async () => {
      const result = await runHook("git status", REPO_WITH_LOCK)
      expect(result.reason).toContain("trash")
      expect(result.reason).toContain("index.lock")
    })
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

  describe("passes through non-git commands", () => {
    test("bun test passes through", async () => {
      const result = await runHook("bun test", REPO_WITH_LOCK)
      expect(result.decision).toBeUndefined()
    })

    test("ls passes through", async () => {
      const result = await runHook("ls -la", REPO_WITH_LOCK)
      expect(result.decision).toBeUndefined()
    })

    test("non-shell tools pass through", async () => {
      const payload = JSON.stringify({
        tool_name: "Read",
        tool_input: { file_path: "/some/file" },
        cwd: REPO_WITH_LOCK,
      })
      const proc = Bun.spawn(["bun", HOOK], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
      proc.stdin.write(payload)
      proc.stdin.end()
      const [out] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      await proc.exited
      expect(out.trim()).toBe("")
    })
  })
})
