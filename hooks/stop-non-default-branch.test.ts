import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { type HookResult, runHookInProcess, useTempDir } from "../src/utils/test-utils.ts"
import {
  buildStandardFeatureBranchReason,
  buildTrunkModeOutput,
} from "./stop-non-default-branch.ts"

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

async function createConflictingLinkedWorktree(): Promise<string> {
  const parent = await tmp.create()
  const primary = join(parent, "primary")
  const linked = join(parent, "linked")
  await mkdir(primary)

  Bun.spawnSync(["git", "init", "-b", "main"], { cwd: primary })
  Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: primary })
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: primary })
  await writeFile(join(primary, "shared.txt"), "base\n")
  Bun.spawnSync(["git", "add", "shared.txt"], { cwd: primary })
  Bun.spawnSync(["git", "commit", "-m", "base"], { cwd: primary })
  Bun.spawnSync(["git", "worktree", "add", "-b", "feature/preserve", linked], { cwd: primary })

  await writeFile(join(primary, "shared.txt"), "main\n")
  Bun.spawnSync(["git", "add", "shared.txt"], { cwd: primary })
  Bun.spawnSync(["git", "commit", "-m", "main change"], { cwd: primary })

  await writeFile(join(linked, "shared.txt"), "feature\n")
  Bun.spawnSync(["git", "add", "shared.txt"], { cwd: linked })
  Bun.spawnSync(["git", "commit", "-m", "feature change"], { cwd: linked })
  return linked
}

async function runHook(cwd: string): Promise<HookResult> {
  return await runHookInProcess(HOOK, {
    session_id: "test-session",
    cwd,
    transcript_path: "",
  })
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

  test("requires PR preservation for a conflicting linked worktree", async () => {
    const dir = await createConflictingLinkedWorktree()
    const result = await runHook(dir)
    const reason = result.json?.reason as string

    expect(result.json?.decision).toBe("block")
    expect(reason).toContain("Preserve linked worktree branch 'feature/preserve'")
    expect(reason).toContain("Open a PR")
    expect(reason).not.toContain("git checkout main")
  })

  test("allows stop when not in a git repo", async () => {
    const dir = await tmp.create("swiz-not-a-repo-")
    const result = await runHook(dir)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("")
  })
})

describe("peer-held file caution (issue #842)", () => {
  const PEER_FILES = ["src/theirs.ts", "hooks/also-theirs.ts"]

  test("control: trunk-mode output without peer files has no caution", () => {
    const reason = buildTrunkModeOutput("feat/x", "main", []).reason ?? ""
    expect(reason).not.toContain("peer session")
    expect(reason).toContain("git checkout main")
  })

  test("trunk-mode output leads with the defer caution when a peer holds files", () => {
    const reason = buildTrunkModeOutput("feat/x", "main", PEER_FILES).reason ?? ""
    expect(reason.startsWith("A peer session holds uncommitted edits")).toBe(true)
    expect(reason).toContain("src/theirs.ts, hooks/also-theirs.ts")
    expect(reason).toContain("Do not switch branches")
    expect(reason).toContain("stranding the peer's work")
  })

  test("control: standard reason without peer files has no caution", () => {
    const reason = buildStandardFeatureBranchReason("feat/x", "main", null, null, [])
    expect(reason).not.toContain("peer session")
    expect(reason).toContain("git checkout main")
  })

  test("standard reason leads with the defer caution when a peer holds files", () => {
    const reason = buildStandardFeatureBranchReason("feat/x", "main", null, null, PEER_FILES)
    expect(reason.startsWith("A peer session holds uncommitted edits")).toBe(true)
    expect(reason).toContain("Do not switch branches")
  })

  test("PR-path reason also carries the caution", () => {
    const pr = { mergeable: "MERGEABLE", number: 7 }
    const reason = buildStandardFeatureBranchReason("feat/x", "main", pr, null, PEER_FILES)
    expect(reason.startsWith("A peer session holds uncommitted edits")).toBe(true)
    expect(reason).toContain("PR #7 is open")
  })

  test("long peer file lists are bounded", () => {
    const many = Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`)
    const reason = buildTrunkModeOutput("feat/x", "main", many).reason ?? ""
    expect(reason).toContain("(and 5 more)")
    expect(reason).not.toContain("src/f24.ts")
  })
})
