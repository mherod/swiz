import { describe, expect, test } from "bun:test"
import { mkdir, unlink, utimes, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { getSessionTasksDir } from "../../hooks/utils/hook-utils.ts"
import { useTempDir } from "../../hooks/utils/test-utils.ts"
import { hookCooldownPath } from "../dispatch/filters.ts"

interface DispatchResult {
  stdout: string
  stderr: string
  exitCode: number | null
  parsed: Record<string, unknown> | null
}

const _tmp = useTempDir()

/** Create a git repo + old-mtime CLAUDE.md so enforcement hooks fire without cooldown bypass. */
async function createProjectDir(): Promise<string> {
  const dir = await _tmp.create("swiz-dispatch-project-")
  Bun.spawnSync(["git", "init"], { cwd: dir, stdout: "pipe", stderr: "pipe" })
  const claudeMd = join(dir, "CLAUDE.md")
  await writeFile(claudeMd, "# Guide\n")
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
  await utimes(claudeMd, twoHoursAgo, twoHoursAgo)
  return dir
}

function runGit(cwd: string, args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString().trim()}`)
  }
}

async function dispatch({
  event,
  hookEventName,
  payload,
  homeDir,
}: {
  event: string
  hookEventName: string
  payload: Record<string, unknown>
  homeDir: string
}): Promise<DispatchResult> {
  const proc = Bun.spawn(["bun", "run", "index.ts", "dispatch", event, hookEventName], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HOME: homeDir,
      // Prevent stop-auto-continue from waiting on live AI backends in format tests.
      AI_TEST_NO_BACKEND: "1",
      // Give hooks extra time in CI where bun cold-compiles TypeScript on first invocation.
      SWIZ_TEST_HOOK_TIMEOUT_SEC: "20",
    },
  })

  void proc.stdin.write(JSON.stringify(payload))
  void proc.stdin.end()

  const stdout = (await new Response(proc.stdout).text()).trim()
  const stderr = await new Response(proc.stderr).text()
  await proc.exited

  let parsed: Record<string, unknown> | null = null
  if (stdout) {
    try {
      parsed = JSON.parse(stdout) as Record<string, unknown>
    } catch {
      parsed = null
    }
  }

  return { stdout, stderr, exitCode: proc.exitCode, parsed }
}

async function writeTask(
  homeDir: string,
  sessionId: string,
  status: "pending" | "in_progress" | "completed" | "cancelled"
): Promise<void> {
  const tasksDir = getSessionTasksDir(sessionId, homeDir)
  if (!tasksDir) throw new Error("Failed to resolve session tasks directory")
  await mkdir(tasksDir, { recursive: true })
  await writeFile(
    join(tasksDir, "1.json"),
    JSON.stringify(
      {
        id: "1",
        subject: "Dispatch contract task",
        description: "Task for dispatch contract tests",
        status,
        blocks: [],
        blockedBy: [],
      },
      null,
      2
    )
  )
}

describe("dispatch output formats", () => {
  test("preToolUse deny uses hookSpecificOutput.permissionDecision", async () => {
    const homeDir = await _tmp.create("swiz-dispatch-home-")
    // createProjectDir() ensures the cwd is a git repo with CLAUDE.md so enforcement hooks
    // apply (the guard added in issue #28 skips enforcement in non-project directories).
    const cwd = await createProjectDir()
    // Clear any cooldown sentinel left by a prior concurrent test run so require-tasks fires.
    const cooldownFile = hookCooldownPath("pretooluse-require-tasks.ts", cwd)
    await unlink(cooldownFile).catch(() => {})
    const result = await dispatch({
      event: "preToolUse",
      hookEventName: "PreToolUse",
      payload: {
        tool_name: "Bash",
        tool_input: { command: "echo hi" },
        session_id: "session-deny",
        cwd,
      },
      homeDir,
    })

    expect(result.exitCode).toBe(0)
    expect(result.parsed).not.toBeNull()

    const hso = result.parsed!.hookSpecificOutput as Record<string, unknown>
    expect(hso.hookEventName).toBe("PreToolUse")
    expect(hso.permissionDecision).toBe("deny")
    expect(typeof hso.permissionDecisionReason).toBe("string")
  }, 15_000)

  test("preToolUse allow-with-reason uses hookSpecificOutput envelope", async () => {
    const homeDir = await _tmp.create("swiz-dispatch-home-")
    const cwd = await _tmp.create("swiz-dispatch-cwd-")
    runGit(cwd, ["init"])
    const sessionId = "session-allow"
    await writeTask(homeDir, sessionId, "pending")

    const result = await dispatch({
      event: "preToolUse",
      hookEventName: "PreToolUse",
      payload: {
        tool_name: "Bash",
        tool_input: { command: "grep -r TODO src/" },
        session_id: sessionId,
        cwd,
      },
      homeDir,
    })

    expect(result.exitCode).toBe(0)
    expect(result.parsed).not.toBeNull()

    const hso = result.parsed!.hookSpecificOutput as Record<string, unknown>
    expect(hso.hookEventName).toBe("PreToolUse")
    expect(hso.permissionDecision).toBe("allow")
    expect(typeof hso.permissionDecisionReason).toBe("string")
    expect((hso.permissionDecisionReason as string).toLowerCase()).toContain("rg")
  }, 15_000)

  test("stop block uses top-level decision + reason", async () => {
    const homeDir = await _tmp.create("swiz-dispatch-home-")
    const repoDir = await _tmp.create("swiz-dispatch-repo-")
    const transcriptPath = join(repoDir, "transcript.jsonl")
    await writeFile(
      transcriptPath,
      `${JSON.stringify({ type: "user", message: { content: "done?" } })}\n`
    )

    runGit(repoDir, ["init"])
    runGit(repoDir, ["config", "user.email", "swiz-tests@example.com"])
    runGit(repoDir, ["config", "user.name", "Swiz Tests"])
    await writeFile(join(repoDir, "app.ts"), "export const value = 1;\n")
    runGit(repoDir, ["add", "app.ts"])
    runGit(repoDir, ["commit", "-m", "test: init"])
    await writeFile(join(repoDir, "app.ts"), "export const value = 2;\n")

    const result = await dispatch({
      event: "stop",
      hookEventName: "Stop",
      payload: {
        session_id: "session-stop",
        transcript_path: transcriptPath,
        cwd: repoDir,
        stop_hook_active: false,
      },
      homeDir,
    })

    expect(result.exitCode).toBe(0)
    expect(result.parsed).not.toBeNull()
    expect(result.parsed!.decision).toBe("block")
    expect(typeof result.parsed!.reason).toBe("string")
    expect(result.parsed!.reason as string).toContain("Uncommitted changes detected")
  }, 15_000)

  test("sessionStart context uses hookSpecificOutput.additionalContext", async () => {
    const homeDir = await _tmp.create("swiz-dispatch-home-")
    const cwd = await _tmp.create("swiz-dispatch-cwd-")
    runGit(cwd, ["init"])
    const result = await dispatch({
      event: "sessionStart",
      hookEventName: "SessionStart",
      payload: {
        session_id: "session-start",
        cwd,
        trigger: "compact",
        matcher: "compact",
      },
      homeDir,
    })

    expect(result.exitCode).toBe(0)
    expect(result.parsed).not.toBeNull()

    const hso = result.parsed!.hookSpecificOutput as Record<string, unknown>
    expect(hso.hookEventName).toBe("SessionStart")
    expect(typeof hso.additionalContext).toBe("string")
    expect(hso.additionalContext as string).toContain("Post-compaction context")
  }, 15_000)

  test("userPromptSubmit context uses hookSpecificOutput.additionalContext", async () => {
    const homeDir = await _tmp.create("swiz-dispatch-home-")
    const cwd = await _tmp.create("swiz-dispatch-cwd-")
    runGit(cwd, ["init"])
    const result = await dispatch({
      event: "userPromptSubmit",
      hookEventName: "UserPromptSubmit",
      payload: {
        session_id: "session-user-prompt",
        cwd,
        prompt: "continue",
      },
      homeDir,
    })

    expect(result.exitCode).toBe(0)
    expect(result.parsed).not.toBeNull()

    const hso = result.parsed!.hookSpecificOutput as Record<string, unknown>
    expect(hso.hookEventName).toBe("UserPromptSubmit")
    expect(typeof hso.additionalContext).toBe("string")
    expect((hso.additionalContext as string).length).toBeGreaterThan(0)
  }, 15_000)
})
