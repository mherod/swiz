import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_DIRTY_WORKTREE_THRESHOLD } from "../src/settings.ts"
import { runHook as runHookScript } from "../src/utils/test-utils.ts"
import { initGitRepo } from "./_test-git-init.ts"

async function createDirtyFiles(dir: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await writeFile(join(dir, `dirty-${i}.txt`), `content-${i}`)
  }
}

async function runHook(cwd: string): Promise<{ decision?: string; reason?: string }> {
  // Use a separate temp dir for HOME to avoid bun/node cache files
  // polluting the git worktree (causes +1 untracked file on CI)
  const fakeHome = await mkdtemp(join(tmpdir(), "swiz-dirty-gate-home-"))
  return await runHookScript(
    "hooks/pretooluse-dirty-worktree-gate.ts",
    {
      tool_name: "TaskUpdate",
      tool_input: { taskId: "1", status: "in_progress" },
      cwd,
    },
    { HOME: fakeHome }
  )
}

describe("pretooluse-dirty-worktree-gate", () => {
  test("default threshold is 15", () => {
    expect(DEFAULT_DIRTY_WORKTREE_THRESHOLD).toBe(15)
  })

  test("allows task update in non-git directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-dirty-gate-nongit-"))
    const result = await runHook(dir)
    // No output = silent allow
    expect(result.decision).toBeUndefined()
  })

  test("allows task update in clean git repo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-dirty-gate-clean-"))
    await initGitRepo(dir)
    const result = await runHook(dir)
    // Zero dirty files → silent allow (no output)
    expect(result.decision).toBeUndefined()
  })

  test("allows task update at threshold boundary (15 dirty files)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-dirty-gate-boundary-"))
    await initGitRepo(dir)
    await createDirtyFiles(dir, 15)
    const result = await runHook(dir)
    expect(result.decision).toBe("allow")
  })

  test("blocks task update above threshold (16 dirty files)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-dirty-gate-over-"))
    await initGitRepo(dir)
    await createDirtyFiles(dir, 16)
    const result = await runHook(dir)
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("16 dirty files")
    expect(result.reason).toContain("threshold: 15")
    expect(result.reason).toContain("Commit")
  })

  test("blocks with clear commit instruction at 30 dirty files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-dirty-gate-many-"))
    await initGitRepo(dir)
    await createDirtyFiles(dir, 30)
    const result = await runHook(dir)
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("30 dirty files")
    expect(result.reason).toContain("Commit your current changes")
  })
})
