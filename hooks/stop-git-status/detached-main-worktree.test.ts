import { afterAll, describe, expect, spyOn, test } from "bun:test"
import { mkdir, realpath } from "node:fs/promises"
import { join } from "node:path"
import { stopHookOutputSchema } from "../../src/schemas.ts"
import * as ownershipUtils from "../../src/utils/session-file-ownership.ts"
import * as taskIo from "../../src/utils/session-task-io.ts"
import {
  buildEffectiveTestSettings,
  runHookInProcess,
  useTempDir,
} from "../../src/utils/test-utils.ts"
import { resolveGitContext } from "./context.ts"
import { collectGitWorkflowStop, evaluateStopGitStatus } from "./evaluate.ts"

const { create: createTempDir } = useTempDir("swiz-detached-main-")
const createTask = spyOn(taskIo, "createSessionTask").mockResolvedValue(undefined)
afterAll(() => createTask.mockRestore())

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
    session_id: "detached-main-test",
    _agent: "claude",
    _effectiveSettings: buildEffectiveTestSettings({ autoContinue: true }),
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

  test("blocks a clean detached linked worktree without blaming the main worktree", async () => {
    const { main, linked } = await createRepository()
    const commit = await git(["rev-parse", "--short=12", "HEAD"], main)
    await git(["worktree", "add", "--detach", linked, "HEAD"], main)

    const result = await runStopHook(linked)
    const collected = await collectGitWorkflowStop({ cwd: linked, session_id: "self" })

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("current Git worktree is on a detached HEAD")
    expect(result.reason).toContain(`Worktree: ${await realpath(linked)}`)
    expect(result.reason).toContain(commit)
    expect(result.reason).toContain(`git switch -c <branch> ${commit}`)
    expect(result.reason).not.toContain("main Git worktree")
    expect(collected.kind).toBe("block")
    if (collected.kind === "block") expect(collected.taskSubject).toBe("Reattach worktree HEAD")
  })

  test("control: a clean linked worktree on a branch does not block", async () => {
    const { main, linked } = await createRepository()
    await git(["worktree", "add", "-b", "feature/attached", linked], main)

    const result = await runStopHook(linked)

    expect(result.stdout).toBe("")
  })

  test("a detached worktree mid-rebase is told to finish the rebase, not switch", async () => {
    const { main, linked } = await createRepository()
    await git(["worktree", "add", "-b", "feature/rebase", linked], main)
    await Bun.write(join(main, "conflict.txt"), "main\n")
    await git(["add", "conflict.txt"], main)
    await git(["commit", "-m", "main side"], main)
    await Bun.write(join(linked, "conflict.txt"), "feature\n")
    await git(["add", "conflict.txt"], linked)
    await git(["commit", "-m", "feature side"], linked)
    await expect(git(["rebase", "main"], linked)).rejects.toThrow()

    const collected = await collectGitWorkflowStop({ cwd: linked, session_id: "self" })

    expect(collected.kind).toBe("block")
    const serialized = JSON.stringify(collected)
    expect(serialized).toContain("rebase in progress")
    expect(serialized).toContain("git rebase --continue")
    expect(serialized).toContain("git rebase --abort")
    expect(serialized).not.toContain("git switch")
  })

  test("a detached worktree mid-bisect is told to reset the bisect", async () => {
    const { main } = await createRepository()
    for (const message of ["second", "third", "fourth"]) {
      await git(["commit", "--allow-empty", "-m", message], main)
    }
    await git(["bisect", "start", "HEAD", "HEAD~3"], main)
    expect(await git(["symbolic-ref", "-q", "--short", "HEAD"], main).catch(() => "")).toBe("")

    const collected = await collectGitWorkflowStop({ cwd: main, session_id: "self" })

    expect(collected.kind).toBe("block")
    const serialized = JSON.stringify(collected)
    expect(serialized).toContain("bisect in progress")
    expect(serialized).toContain("git bisect reset")
    expect(serialized).not.toContain("git switch")
  })

  test("a missing session blocks detached recovery without a branch-switch command", async () => {
    const { main } = await createRepository()
    await git(["switch", "--detach", "HEAD"], main)
    const result = await collectGitWorkflowStop({ cwd: main })
    expect(result.kind).toBe("block")
    expect(JSON.stringify(result)).toContain("missing-session")
    expect(JSON.stringify(result)).not.toContain("git switch")
  })

  test("peer ownership of the main worktree replaces recovery commands with inspection", async () => {
    const { main, linked } = await createRepository()
    await git(["worktree", "add", "-b", "feature/peer", linked], main)
    await git(["switch", "--detach", "HEAD"], main)
    const discovery = spyOn(ownershipUtils, "resolvePeerHeldFiles").mockResolvedValue({
      known: true,
      files: ["peer.ts"],
    })
    try {
      const result = await collectGitWorkflowStop({ cwd: linked, session_id: "self" })
      expect(discovery).toHaveBeenCalledWith(await realpath(main), "self")
      expect(result.kind).toBe("block")
      expect(JSON.stringify(result)).toContain("peer.ts")
      expect(JSON.stringify(result)).not.toContain("git switch")
    } finally {
      discovery.mockRestore()
    }
  })

  test("unknown ownership of dirty files remains a block with no staging command", async () => {
    const { main } = await createRepository()
    await Bun.write(join(main, "unknown.ts"), "export {}\n")
    const input = { cwd: main, _effectiveSettings: buildEffectiveTestSettings() }
    const result = await collectGitWorkflowStop(input)
    const output = stopHookOutputSchema.parse(await evaluateStopGitStatus(input))
    expect(result.kind).toBe("block")
    expect(output.reason).toContain("missing-session")
    expect(JSON.stringify(result)).not.toMatch(/git (add|commit|pull|checkout|switch)/)
    expect(output.reason).not.toMatch(/git (add|commit|pull|checkout|switch)/)
  })

  test("missing cwd never uses the daemon repository for context or recovery", async () => {
    expect(await resolveGitContext({ session_id: "self" })).toBeNull()
    const collected = await collectGitWorkflowStop({ session_id: "self" })
    const evaluated = stopHookOutputSchema.parse(
      await evaluateStopGitStatus({
        session_id: "self",
        _effectiveSettings: buildEffectiveTestSettings({ autoContinue: true }),
      })
    )
    expect(collected.kind).toBe("hookOutput")
    expect(evaluated.reason).toContain("missing-cwd")
    expect(evaluated.reason).not.toMatch(/git (add|commit|checkout|switch)/)
  })
})
