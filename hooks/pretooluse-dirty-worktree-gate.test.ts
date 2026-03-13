import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DIRTY_FILE_THRESHOLD } from "./pretooluse-dirty-worktree-gate.ts"

async function initGitRepo(dir: string): Promise<void> {
  const init = Bun.spawn(["git", "init", dir], { stdout: "pipe", stderr: "pipe" })
  await init.exited
  const cfg = Bun.spawn(["git", "-C", dir, "config", "user.email", "test@test.com"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  await cfg.exited
  const cfg2 = Bun.spawn(["git", "-C", dir, "config", "user.name", "Test"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  await cfg2.exited
  // Create an initial commit so HEAD exists
  await writeFile(join(dir, ".gitkeep"), "")
  const add = Bun.spawn(["git", "-C", dir, "add", "."], { stdout: "pipe", stderr: "pipe" })
  await add.exited
  const commit = Bun.spawn(["git", "-C", dir, "commit", "-m", "init", "--no-verify"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  await commit.exited
}

async function createDirtyFiles(dir: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await writeFile(join(dir, `dirty-${i}.txt`), `content-${i}`)
  }
}

async function runHook(cwd: string): Promise<{ decision?: string; reason?: string }> {
  const payload = JSON.stringify({
    tool_name: "TaskUpdate",
    tool_input: { taskId: "1", status: "in_progress" },
    cwd,
  })
  const proc = Bun.spawn(["bun", "hooks/pretooluse-dirty-worktree-gate.ts"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  void proc.stdin.write(payload)
  void proc.stdin.end()
  const out = await new Response(proc.stdout).text()
  await proc.exited

  if (!out.trim()) return {}
  const parsed = JSON.parse(out.trim())
  const hso = parsed.hookSpecificOutput
  return {
    decision: hso?.permissionDecision ?? parsed.decision,
    reason: hso?.permissionDecisionReason ?? parsed.reason,
  }
}

describe("pretooluse-dirty-worktree-gate", () => {
  test("exports threshold constant of 15", () => {
    expect(DIRTY_FILE_THRESHOLD).toBe(15)
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
    expect(result.decision).toBeUndefined()
  })

  test("allows task update at threshold boundary (15 dirty files)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-dirty-gate-boundary-"))
    await initGitRepo(dir)
    await createDirtyFiles(dir, 15)
    const result = await runHook(dir)
    expect(result.decision).toBeUndefined()
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
    expect(result.reason).toContain("/commit")
  })
})
