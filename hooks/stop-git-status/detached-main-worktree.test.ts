import { describe, expect, test } from "bun:test"
import { mkdir, realpath } from "node:fs/promises"
import { join } from "node:path"
import {
  buildEffectiveTestSettings,
  runHookInProcess,
  useTempDir,
} from "../../src/utils/test-utils.ts"
import { collectGitWorkflowStop } from "./evaluate.ts"

const { create: createTempDir } = useTempDir("swiz-detached-main-")

async function git(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr || stdout}`)
  }
  return stdout.trim()
}

async function createRepository(): Promise<{ main: string; linked: string }> {
  const parent = await createTempDir()
  const main = join(parent, "main")
  const linked = join(parent, "linked")
  await mkdir(main)
  await git(["init", "-b", "main"], main)
  await git(["config", "user.email", "test@example.com"], main)
  await git(["config", "user.name", "Test User"], main)
  await git(["commit", "--allow-empty", "-m", "initial"], main)
  return { main, linked }
}

async function runStopHook(cwd: string) {
  return await runHookInProcess("hooks/stop-git-status.ts", {
    cwd,
    _agent: "claude",
    _effectiveSettings: buildEffectiveTestSettings(),
  })
}

describe("stop-git-status detached main worktree", () => {
  test("blocks a clean main worktree on a detached HEAD", async () => {
    const { main } = await createRepository()
    const commit = await git(["rev-parse", "--short=12", "HEAD"], main)
    await git(["switch", "--detach", "HEAD"], main)

    const result = await runStopHook(main)

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("main Git worktree is on a detached HEAD")
    expect(result.reason).toContain(commit)
    expect(result.reason).toContain("git switch <branch>")
  })

  test("blocks from a linked worktree when the main worktree is detached", async () => {
    const { main, linked } = await createRepository()
    await git(["worktree", "add", "-b", "feature/linked", linked], main)
    await git(["switch", "--detach", "HEAD"], main)

    const result = await runStopHook(linked)
    const collected = await collectGitWorkflowStop({ cwd: linked })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain(`Main worktree: ${await realpath(main)}`)
    expect(collected.kind).toBe("block")
  })

  test("does not mistake a detached linked worktree for the main worktree", async () => {
    const { main, linked } = await createRepository()
    await git(["worktree", "add", "--detach", linked, "HEAD"], main)

    const result = await runStopHook(linked)

    expect(result.stdout).toBe("")
  })
})
