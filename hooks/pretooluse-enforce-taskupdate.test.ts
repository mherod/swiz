import { describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runHook } from "../src/utils/test-utils.ts"

const HOOK = "hooks/pretooluse-enforce-taskupdate.ts"

function bashPayload(command: string) {
  return { tool_name: "Bash", tool_input: { command } }
}

function runClaudeHook(command: string) {
  return runHook(HOOK, bashPayload(command), {
    CLAUDECODE: "1",
    CODEX_MANAGED_BY_NPM: undefined,
    CODEX_THREAD_ID: undefined,
    CURSOR_TRACE_ID: undefined,
    GEMINI_CLI: undefined,
    GEMINI_PROJECT_DIR: undefined,
  })
}

function runCodexHook(command: string) {
  return runHook(HOOK, bashPayload(command), {
    CLAUDECODE: undefined,
    CODEX_MANAGED_BY_NPM: "1",
    CODEX_THREAD_ID: "test-codex-thread",
    CURSOR_TRACE_ID: undefined,
    GEMINI_CLI: undefined,
    GEMINI_PROJECT_DIR: undefined,
  })
}

async function withTaskHome(
  sessionId: string,
  tasks: Array<{ id: string; subject: string; status: string }>,
  fn: (home: string) => Promise<void>
): Promise<void> {
  const home = join(
    tmpdir(),
    `swiz-taskupdate-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  const tasksDir = join(home, ".claude", "tasks", sessionId)
  await mkdir(tasksDir, { recursive: true })
  for (const task of tasks) {
    await writeFile(join(tasksDir, `${task.id}.json`), JSON.stringify(task))
  }
  try {
    await fn(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

describe("pretooluse-enforce-taskupdate", () => {
  test("blocks `swiz tasks update` with denial", async () => {
    const result = await runClaudeHook("swiz tasks update 1 --status in_progress")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("approaches")
    expect(result.reason).toContain("TaskUpdate")
  })

  test("blocks `swiz tasks status` with denial", async () => {
    const result = await runClaudeHook("swiz tasks status 1")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("TaskUpdate")
  })

  test("blocks `swiz tasks complete`", async () => {
    const result = await runClaudeHook("swiz tasks complete 1 --evidence note:done")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("swiz tasks")
    expect(result.reason).toContain("TaskUpdate")
  })

  test("blocks `swiz tasks list`", async () => {
    const result = await runClaudeHook("swiz tasks list")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("TaskList")
  })

  test("blocks `swiz tasks get`", async () => {
    const result = await runClaudeHook("swiz tasks get 1")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("TaskGet")
  })

  test("allows `swiz tasks adopt` (orphan recovery)", async () => {
    const result = await runClaudeHook("swiz tasks adopt")
    expect(result.decision).toBe("allow")
  })

  test("allows `swiz tasks adopt --recovered`", async () => {
    const result = await runClaudeHook("swiz tasks adopt --recovered")
    expect(result.decision).toBe("allow")
  })

  test("allows normal commands in agent/Claude Code", async () => {
    const result = await runClaudeHook("git status")
    expect(result.decision).toBe("allow")
  })

  test("hook is active in subprocess context (simulating Claude Code)", async () => {
    const result = await runClaudeHook("swiz tasks status 1")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("TaskUpdate")
  })

  test("blocks swiz tasks with various spacing", async () => {
    const result = await runClaudeHook("swiz  tasks  update  1")
    expect(result.decision).toBe("deny")
  })

  test("does not block swiz tasks when used as argument", async () => {
    const result = await runClaudeHook("echo 'swiz tasks update'")
    expect(result.decision).toBe("allow")
  })

  test("blocks swiz tasks update subcommand variations", async () => {
    const result = await runClaudeHook("swiz tasks update 123 --description 'new desc'")
    expect(result.decision).toBe("deny")
  })

  test("blocks bare `swiz tasks` (list)", async () => {
    const result = await runClaudeHook("swiz tasks")
    expect(result.decision).toBe("deny")
  })

  test("does not apply the Claude-only swiz tasks block in Codex", async () => {
    const result = await runCodexHook("swiz tasks")
    expect(result.decision).not.toBe("deny")
    expect(result.reason ?? "").not.toContain("Claude Code")
  })

  test("blocks TaskUpdate when it would create a duplicate active subject", async () => {
    const sessionId = "duplicate-taskupdate-block"
    await withTaskHome(
      sessionId,
      [
        { id: "1", subject: "Resolve task state", status: "pending" },
        { id: "2", subject: "Write regression tests", status: "pending" },
      ],
      async (home) => {
        const result = await runHook(
          HOOK,
          {
            tool_name: "TaskUpdate",
            session_id: sessionId,
            tool_input: { taskId: "2", subject: "Resolve task state" },
          },
          { HOME: home, CLAUDECODE: "1" }
        )

        expect(result.decision).toBe("deny")
        expect(result.reason).toContain("would leave task #2 with a duplicate active subject")
        expect(result.reason).toContain("Run TaskList")
      }
    )
  })

  test("blocks pending task completion without spelling out the transition recipe", async () => {
    const sessionId = "pending-completion-shortcut"
    await withTaskHome(
      sessionId,
      [
        { id: "1", subject: "Implement checkout fix", status: "pending" },
        { id: "2", subject: "Verify checkout fix", status: "pending" },
        { id: "3", subject: "Document checkout fix", status: "pending" },
      ],
      async (home) => {
        const result = await runHook(
          HOOK,
          {
            tool_name: "TaskUpdate",
            session_id: sessionId,
            tool_input: { taskId: "1", status: "completed" },
          },
          { HOME: home, CLAUDECODE: "1" }
        )

        expect(result.decision).toBe("deny")
        expect(result.reason).toContain("still pending")
        expect(result.reason).toContain("Starting a task before closing it")
        expect(result.reason).toContain("Run TaskList now")
        expect(result.reason).not.toContain("drift")
        expect(result.reason).not.toContain("recent context")
        expect(result.reason).not.toContain("Required transition")
        expect(result.reason).not.toContain("pending -> in_progress -> completed")
      }
    )
  })

  test("blocks task deletion with humanized repair guidance instead of projected counts", async () => {
    const sessionId = "delete-planning-buffer"
    await withTaskHome(
      sessionId,
      [
        { id: "1", subject: "Implement checkout fix", status: "in_progress" },
        { id: "2", subject: "Verify checkout fix", status: "pending" },
      ],
      async (home) => {
        const result = await runHook(
          HOOK,
          {
            tool_name: "TaskUpdate",
            session_id: sessionId,
            tool_input: { taskId: "1", status: "deleted" },
          },
          { HOME: home, CLAUDECODE: "1" }
        )

        expect(result.decision).toBe("deny")
        expect(result.reason).toContain("needs a replacement before it can be removed")
        expect(result.reason).toContain("Run TaskList now")
        expect(result.reason).toContain("Keep current work and follow-up work visible")
        expect(result.reason).not.toContain("Swiz")
        expect(result.reason).not.toContain("drift")
        expect(result.reason).not.toContain("recent context")
        expect(result.reason).not.toContain("After deletion")
        expect(result.reason).not.toContain("In progress tasks:")
        expect(result.reason).not.toContain("Pending tasks:")
        expect(result.reason).not.toContain("governance thresholds")
      }
    )
  })

  test("allows TaskUpdate when it resolves an existing duplicate active subject", async () => {
    const sessionId = "duplicate-taskupdate-resolve"
    await withTaskHome(
      sessionId,
      [
        { id: "1", subject: "Resolve task state", status: "pending" },
        { id: "2", subject: "Resolve task state", status: "pending" },
      ],
      async (home) => {
        const result = await runHook(
          HOOK,
          {
            tool_name: "TaskUpdate",
            session_id: sessionId,
            tool_input: { taskId: "2", subject: "Write regression tests" },
          },
          { HOME: home, CLAUDECODE: "1" }
        )

        expect(result.decision).not.toBe("deny")
      }
    )
  })
})
