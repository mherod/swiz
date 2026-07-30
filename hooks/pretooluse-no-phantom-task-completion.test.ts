import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { neutralAgentEnvOverrides, runHookInProcess } from "../src/utils/test-utils.ts"
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
  transcriptPath?: string,
  toolName = "TaskUpdate"
): Promise<{ decision?: string; reason?: string }> {
  const payload = {
    tool_name: toolName,
    tool_input: toolInput,
    cwd,
    session_id: sessionId,
    transcript_path: transcriptPath || "",
  }
  const result = await runHookInProcess("hooks/pretooluse-no-phantom-task-completion.ts", payload, {
    cwd,
    env: neutralAgentEnvOverrides({ CLAUDECODE: "1", HOME: home }),
  })
  return {
    decision: result.decision,
    reason: result.reason,
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
    expect(result.reason).toContain("active-task-buffer")
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
    expect(result.reason).toContain("planned-task-buffer")
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
    expect(result.reason).toContain("needs substantive work before it can close")

    // The hook gates the "Run TaskList now" step on the agent detected from the
    // payload (detectCurrentAgentFromHookPayload), not the host process env. This
    // payload carries no agent identity, so the Claude-only step is filtered out.
    expect(result.reason).not.toContain("Run TaskList now")
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

  test("ignores update_plan as a whole-plan mutation, not a one-task completion", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-phantom-gate-update-plan-"))
    const home = await mkdtemp(join(tmpdir(), "swiz-phantom-gate-update-plan-home-"))
    await initGitRepo(dir)
    const sessionId = "session-update-plan"
    const transcriptPath = join(dir, "transcript.jsonl")
    await writeFile(transcriptPath, "")

    const toolInput = {
      plan: [{ step: "Implement model", status: "completed" }],
    }
    const result = await runHook(dir, home, sessionId, toolInput, transcriptPath, "update_plan")

    expect(result).toEqual({})
  })
})
