import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { type HookResult, useTempDir } from "../src/utils/test-utils.ts"

async function enableTrunkMode(dir: string): Promise<void> {
  await mkdir(join(dir, ".swiz"), { recursive: true })
  await writeFile(join(dir, ".swiz", "config.json"), JSON.stringify({ trunkMode: true }))
}

const HOOK = "hooks/stop-non-default-branch.ts"

const tmp = useTempDir("swiz-non-default-branch-")

async function createGitRepo(branchName = "main"): Promise<string> {
  const dir = await tmp.create()
  Bun.spawnSync(["git", "init"], { cwd: dir })
  Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: dir })
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: dir })
  Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "init"], { cwd: dir })
  if (branchName !== "main") {
    Bun.spawnSync(["git", "checkout", "-b", branchName], { cwd: dir })
  }
  return dir
}

async function runHook(cwd: string): Promise<HookResult> {
  const payload = JSON.stringify({ session_id: "test-session", cwd, transcript_path: "" })
  const proc = Bun.spawn(["bun", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: process.cwd(),
  })
  void proc.stdin.write(payload)
  void proc.stdin.end()

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited

  let json: Record<string, unknown> | null = null
  try {
    if (stdout.trim()) json = JSON.parse(stdout.trim())
  } catch {}

  return { exitCode: proc.exitCode, stdout: stdout.trim(), stderr, json }
}

describe("stop-non-default-branch", () => {
  test("allows stop on main branch", async () => {
    const dir = await createGitRepo("main")
    const result = await runHook(dir)
    // Default branch should pass (no output, no block)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("")
    expect(result.json).toBeNull()
  })

  test("allows stop on master branch", async () => {
    // Create a repo on master
    const dir = await tmp.create()
    Bun.spawnSync(["git", "init", "-b", "master"], { cwd: dir })
    Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: dir })
    Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: dir })
    Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "init"], { cwd: dir })

    const result = await runHook(dir)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("")
  })

  test("respects project default-branch override", async () => {
    const dir = await createGitRepo("feat/my-feature")
    await mkdir(join(dir, ".swiz"), { recursive: true })
    await writeFile(join(dir, ".swiz", "config.json"), JSON.stringify({ defaultBranch: "trunk" }))
    Bun.spawnSync(["git", "checkout", "-b", "trunk"], { cwd: dir })

    const result = await runHook(dir)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("")
  })

  test("blocks stop on a feature branch with block decision", async () => {
    const dir = await createGitRepo("feat/issue-42-add-thing")
    const result = await runHook(dir)
    expect(result.exitCode).toBe(0)
    expect(result.json).not.toBeNull()
    expect(result.json?.decision).toBe("block")
    expect(typeof result.json?.reason).toBe("string")
  })

  test("block reason mentions the feature branch name", async () => {
    const dir = await createGitRepo("feat/my-feature")
    const result = await runHook(dir)
    expect(result.json?.reason).toContain("feat/my-feature")
  })

  test("block reason offers remediation options", async () => {
    const dir = await createGitRepo("fix/some-bug")
    const result = await runHook(dir)
    const reason = result.json?.reason as string
    // Should mention checkout or switching back to default branch
    expect(reason).toContain("git checkout")
    // Should explain workflow concern
    expect(reason.toLowerCase()).toMatch(/unfinished|workflow|branch/)
  })

  test("trunk mode omits PR workflow and mentions trunk", async () => {
    const dir = await createGitRepo("feat/trunk-msg")
    await enableTrunkMode(dir)
    const result = await runHook(dir)
    expect(result.json?.decision).toBe("block")
    const reason = result.json?.reason as string
    expect(reason.toLowerCase()).toContain("trunk mode")
    expect(reason).toContain("git checkout")
    expect(reason).not.toContain("gh pr create")
    expect(reason).not.toContain("PR #")
  })

  test("allows stop when not in a git repo", async () => {
    const dir = await tmp.create("swiz-not-a-repo-")
    const result = await runHook(dir)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("")
  })
})
