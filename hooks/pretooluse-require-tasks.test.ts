import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

interface HookResult {
  decision?: string
  reason?: string
}

async function runHook({
  homeDir,
  toolName = "Bash",
  sessionId = "session-123",
  transcriptPath,
  command,
}: {
  homeDir: string
  toolName?: string
  sessionId?: string
  transcriptPath?: string
  command?: string
}): Promise<HookResult> {
  const payload = JSON.stringify({
    tool_name: toolName,
    session_id: sessionId,
    transcript_path: transcriptPath ?? "",
    tool_input: command !== undefined ? { command } : {},
  })
  const proc = Bun.spawn(["bun", "hooks/pretooluse-require-tasks.ts"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: homeDir },
  })
  proc.stdin.write(payload)
  proc.stdin.end()

  const out = await new Response(proc.stdout).text()
  await proc.exited
  if (!out.trim()) return {}

  const parsed = JSON.parse(out.trim())
  const hso = parsed.hookSpecificOutput as Record<string, unknown> | undefined
  return {
    decision: (hso?.permissionDecision ?? parsed.decision) as string | undefined,
    reason: (hso?.permissionDecisionReason ?? parsed.reason) as string | undefined,
  }
}

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (!dir) continue
    await rm(dir, { recursive: true, force: true })
  }
})

async function createTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "swiz-require-tasks-"))
  tempDirs.push(dir)
  return dir
}

async function writeTask(
  homeDir: string,
  sessionId: string,
  {
    id,
    subject,
    status,
  }: {
    id: string
    subject: string
    status: "pending" | "in_progress" | "completed" | "cancelled"
  }
) {
  const dir = join(homeDir, ".claude", "tasks", sessionId)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, `${id}.json`),
    JSON.stringify(
      {
        id,
        subject,
        description: "",
        status,
        blocks: [],
        blockedBy: [],
      },
      null,
      2
    )
  )
}

describe("pretooluse-require-tasks", () => {
  test("denies Bash when session has no tasks", async () => {
    const homeDir = await createTempHome()
    const result = await runHook({ homeDir, toolName: "Bash" })
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("no incomplete tasks")
  })

  test("denies Edit when only completed/cancelled tasks exist", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-abc"
    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Done task",
      status: "completed",
    })
    await writeTask(homeDir, sessionId, {
      id: "2",
      subject: "Cancelled task",
      status: "cancelled",
    })

    const result = await runHook({ homeDir, toolName: "Edit", sessionId })
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("no incomplete tasks")
  })

  test("allows Shell when at least one pending task exists", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-pending"
    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Next step",
      status: "pending",
    })

    const result = await runHook({ homeDir, toolName: "Shell", sessionId })
    expect(result.decision).toBeUndefined()
  })

  test("allows Edit when at least one in_progress task exists", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-active"
    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Current work",
      status: "in_progress",
    })

    const result = await runHook({ homeDir, toolName: "Edit", sessionId })
    expect(result.decision).toBeUndefined()
  })

  test("denies when tasks exist but are stale (20+ calls since last task tool)", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-stale"
    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Active task",
      status: "in_progress",
    })

    // Build a transcript: one TaskCreate call, then 21 non-task calls
    const lines: string[] = []
    const makeEntry = (toolName: string) =>
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: toolName, id: "x", input: {} }],
        },
      })
    lines.push(makeEntry("TaskCreate")) // index 0 — last task tool
    for (let i = 0; i < 21; i++) lines.push(makeEntry("Read")) // indices 1–21

    const transcriptPath = join(homeDir, "transcript.jsonl")
    await writeFile(transcriptPath, lines.join("\n") + "\n")

    const result = await runHook({ homeDir, toolName: "Bash", sessionId, transcriptPath })
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("stale")
  })

  test("allows when tasks exist and transcript is fresh (< 20 calls since last task tool)", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-fresh"
    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Active task",
      status: "in_progress",
    })

    const lines: string[] = []
    const makeEntry = (toolName: string) =>
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: toolName, id: "x", input: {} }],
        },
      })
    lines.push(makeEntry("TaskCreate")) // index 0
    for (let i = 0; i < 5; i++) lines.push(makeEntry("Read")) // indices 1–5

    const transcriptPath = join(homeDir, "transcript.jsonl")
    await writeFile(transcriptPath, lines.join("\n") + "\n")

    const result = await runHook({ homeDir, toolName: "Edit", sessionId, transcriptPath })
    expect(result.decision).toBeUndefined()
  })

  describe("read-only git exemption", () => {
    test("allows git status without any tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "git status" })
      expect(result.decision).toBeUndefined()
    })

    test("allows git log without any tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "git log --oneline -10" })
      expect(result.decision).toBeUndefined()
    })

    test("allows git diff without any tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "git diff HEAD~1" })
      expect(result.decision).toBeUndefined()
    })

    test("allows git show without any tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "git show HEAD" })
      expect(result.decision).toBeUndefined()
    })

    test("allows git branch without any tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "git branch --show-current" })
      expect(result.decision).toBeUndefined()
    })

    test("allows git rev-parse without any tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "git rev-parse --abbrev-ref HEAD" })
      expect(result.decision).toBeUndefined()
    })

    test("allows git reflog without any tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "git reflog --limit 5" })
      expect(result.decision).toBeUndefined()
    })

    test("allows git status with leading pwd prefix", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "pwd && git status" })
      expect(result.decision).toBeUndefined()
    })

    test("still denies git commit without tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: 'git commit -m "wip"' })
      expect(result.decision).toBe("deny")
    })

    test("allows git push without tasks (push/pull/fetch are exempt)", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "git push origin main" })
      expect(result.decision).toBeUndefined()
    })

    test("still denies git checkout without tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "git checkout -b new-branch" })
      expect(result.decision).toBe("deny")
    })

    test("still denies non-exempt commands without tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "cat some-file.txt" })
      expect(result.decision).toBe("deny")
    })

    test("allows ls without tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "ls -la" })
      expect(result.decision).toBeUndefined()
    })

    test("allows ls with path without tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "ls src/" })
      expect(result.decision).toBeUndefined()
    })

    test("allows rg without tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "rg 'some pattern' src/" })
      expect(result.decision).toBeUndefined()
    })

    test("allows grep without tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "grep -r 'TODO' hooks/" })
      expect(result.decision).toBeUndefined()
    })

    test("allows ls chained after pwd without tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "pwd && ls -la" })
      expect(result.decision).toBeUndefined()
    })
  })

  test("skips staleness check when no task tool has been used yet", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-notask-tool"
    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Bootstrap task",
      status: "pending",
    })

    // Transcript with many non-task tool calls but no task tool call
    const lines: string[] = []
    for (let i = 0; i < 30; i++) {
      lines.push(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "tool_use", name: "Read", id: "x", input: {} }],
          },
        })
      )
    }
    const transcriptPath = join(homeDir, "transcript.jsonl")
    await writeFile(transcriptPath, lines.join("\n") + "\n")

    // Should allow — staleness only triggers after task tools have been used
    const result = await runHook({ homeDir, toolName: "Bash", sessionId, transcriptPath })
    expect(result.decision).toBeUndefined()
  })
})
