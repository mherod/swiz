import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initGitRepo } from "./_test-git-init.ts"

async function writeTask(
  home: string,
  sessionId: string,
  taskId: string,
  status: string
): Promise<void> {
  // Match createDefaultTaskStore()'s resolution for the test subprocess,
  // which inherits CLAUDECODE=1 from the parent session and so reads from
  // ~/.claude/tasks, not ~/.gemini/tasks.
  const tasksDir = join(home, ".claude", "tasks", sessionId)
  await mkdir(tasksDir, { recursive: true })
  const task = {
    id: taskId,
    subject: `Task ${taskId}`,
    description: `Description ${taskId}`,
    status,
    blocks: [],
    blockedBy: [],
  }
  await writeFile(join(tasksDir, `${taskId}.json`), JSON.stringify(task))
}

async function runHook(
  cwd: string,
  home: string,
  sessionId: string,
  toolInput: any,
  transcriptPath?: string
): Promise<{ decision?: string; reason?: string }> {
  const payload = JSON.stringify({
    tool_name: "TaskUpdate",
    tool_input: toolInput,
    cwd,
    session_id: sessionId,
    transcript_path: transcriptPath || "",
  })
  const proc = Bun.spawn(["bun", "hooks/pretooluse-no-phantom-task-completion.ts"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home },
  })
  await proc.stdin.write(payload)
  await proc.stdin.end()
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  if (err) console.error(err)
  await proc.exited

  if (!out.trim()) return {}
  const parsed = JSON.parse(out.trim())
  const hso = parsed.hookSpecificOutput
  return {
    decision: hso?.permissionDecision ?? parsed.decision,
    reason: hso?.permissionDecisionReason ?? parsed.reason,
  }
}

function transcriptLine(toolName: string, toolInput: any): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: toolName,
          input: toolInput,
        },
      ],
    },
  })
}

describe("pretooluse-no-phantom-task-completion", () => {
  test("allows completion if 2 other tasks are in_progress", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-phantom-gate-busy-"))
    const home = await mkdtemp(join(tmpdir(), "swiz-phantom-gate-busy-home-"))
    await initGitRepo(dir)
    const sessionId = "session-busy"
    const transcriptPath = join(dir, "transcript.jsonl")
    await writeFile(transcriptPath, "") // Empty but present

    // Target task to complete
    await writeTask(home, sessionId, "1", "in_progress")
    // Two other in_progress tasks
    await writeTask(home, sessionId, "2", "in_progress")
    await writeTask(home, sessionId, "3", "in_progress")

    const toolInput = { taskId: "1", status: "completed", description: "done" }
    const result = await runHook(dir, home, sessionId, toolInput, transcriptPath)

    expect(result.decision).toBe("allow")
    expect(result.reason).toContain("busy session")
  })

  test("allows completion if 2 other tasks are pending", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-phantom-gate-planned-"))
    const home = await mkdtemp(join(tmpdir(), "swiz-phantom-gate-planned-home-"))
    await initGitRepo(dir)
    const sessionId = "session-planned"
    const transcriptPath = join(dir, "transcript.jsonl")
    await writeFile(transcriptPath, "")

    // Target task to complete
    await writeTask(home, sessionId, "1", "in_progress")
    // Two other pending tasks form the planning buffer
    await writeTask(home, sessionId, "2", "pending")
    await writeTask(home, sessionId, "3", "pending")

    const toolInput = { taskId: "1", status: "completed", description: "done" }
    const result = await runHook(dir, home, sessionId, toolInput, transcriptPath)

    expect(result.decision).toBe("allow")
    expect(result.reason).toContain("planned session")
  })

  test("blocks completion if only 1 other task is in_progress and no transcript evidence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-phantom-gate-lonely-"))
    const home = await mkdtemp(join(tmpdir(), "swiz-phantom-gate-lonely-home-"))
    await initGitRepo(dir)
    const sessionId = "session-lonely"
    const transcriptPath = join(dir, "transcript.jsonl")

    // Target task to complete
    await writeTask(home, sessionId, "1", "in_progress")
    // Only one other in_progress task
    await writeTask(home, sessionId, "2", "in_progress")

    // Transcript shows in_progress transition but NO work
    const transcript = `${transcriptLine("TaskUpdate", { taskId: "1", status: "in_progress" })}\n`
    await writeFile(transcriptPath, transcript)

    const toolInput = { taskId: "1", status: "completed", description: "done" }
    const result = await runHook(dir, home, sessionId, toolInput, transcriptPath)

    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("PHANTOM TASK BLOCK")
  })

  test("allows completion if only 1 other task is in_progress but transcript HAS work", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-phantom-gate-work-"))
    const home = await mkdtemp(join(tmpdir(), "swiz-phantom-gate-work-home-"))
    await initGitRepo(dir)
    const sessionId = "session-work"
    const transcriptPath = join(dir, "transcript.jsonl")

    await writeTask(home, sessionId, "1", "in_progress")
    await writeTask(home, sessionId, "2", "in_progress")

    const transcript = `${[
      transcriptLine("TaskUpdate", { taskId: "1", status: "in_progress" }),
      transcriptLine("Read", { file_path: "foo.ts" }), // SUBSTANTIVE WORK
    ].join("\n")}\n`
    await writeFile(transcriptPath, transcript)

    const toolInput = { taskId: "1", status: "completed", description: "done" }
    const result = await runHook(dir, home, sessionId, toolInput, transcriptPath)

    expect(result.decision).toBe("allow")
    expect(result.reason).toContain("work tool call(s) after in_progress")
  })
})
