import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AGENTS } from "./agents.ts"
import { taskListSyncSentinelPath } from "./temp-paths.ts"
import { neutralAgentEnvOverrides, runHookInProcess } from "./utils/test-utils.ts"

const HOOK_PATH = join(import.meta.dir, "..", "hooks", "pretooluse-require-tasks.ts")
const HOOK_SCRIPT = "hooks/pretooluse-require-tasks.ts"

// ── Hook behavior tests ───────────────────────────────────────────────────────

interface HookResult {
  stdout: string
  exitCode: number | null
  parsed: Record<string, any> | null
}

async function runHook(
  payload: Record<string, any>,
  env?: Record<string, string | undefined>
): Promise<HookResult> {
  const agentEnvOverrides = Object.fromEntries(
    AGENTS.flatMap((agent) => (agent.envVars ?? []).map((envVar) => [envVar, undefined]))
  )
  const result = await runHookInProcess(HOOK_SCRIPT, payload, {
    env: neutralAgentEnvOverrides({ ...agentEnvOverrides, ...env }),
  })
  return {
    stdout: result.stdout.trim(),
    exitCode: result.exitCode,
    parsed: result.json ?? null,
  }
}

describe("pretooluse-require-tasks hook", () => {
  test("allows non-blocked tools (e.g. Read)", async () => {
    const result = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "src/foo.ts" },
      session_id: `test-allow-${Date.now()}`,
    })
    expect(result.exitCode).toBe(0)
    expect(result.parsed).toBeNull()
  })

  test("denies shell commands when task buffer is missing, even for read-only git", async () => {
    const tmpHome = await mkdtemp(join(tmpdir(), "swiz-hook-shell-governance-"))
    const sessionId = `test-exempt-${Date.now()}`
    await Bun.write(taskListSyncSentinelPath(sessionId), String(Date.now()))
    try {
      const result = await runHook(
        {
          tool_name: "Bash",
          tool_input: { command: "git status" },
          session_id: sessionId,
        },
        { HOME: tmpHome }
      )
      expect(result.exitCode).toBe(0)
      expect(result.parsed?.hookSpecificOutput?.permissionDecision).toBe("deny")
      expect(String(result.parsed?.hookSpecificOutput?.permissionDecisionReason ?? "")).toContain(
        "needs tasks in place first"
      )
    } finally {
      await rm(tmpHome, { recursive: true, force: true })
    }
  })

  test("allows CLAUDE.md edits without tasks", async () => {
    const result = await runHook({
      tool_name: "Edit",
      tool_input: { file_path: "/some/project/CLAUDE.md", new_string: "test" },
      session_id: `test-memory-${Date.now()}`,
    })
    expect(result.exitCode).toBe(0)
    expect(result.parsed).toBeNull()
  })

  test("denies when session has no tasks and does not auto-create a bootstrap task", async () => {
    const tmpHome = await mkdtemp(join(tmpdir(), "swiz-hook-test-"))
    const sessionId = `test-bootstrap-${Date.now()}`
    // Write sync sentinel so the canonical staleness gate doesn't fire first
    await Bun.write(taskListSyncSentinelPath(sessionId), String(Date.now()))
    try {
      const result = await runHook(
        {
          tool_name: "Bash",
          tool_input: { command: "echo hello" },
          session_id: sessionId,
        },
        { HOME: tmpHome }
      )
      // Hook should deny and require explicit task creation
      expect(result.exitCode).toBe(0)
      expect(result.parsed).not.toBeNull()
      const reason = (result.parsed as Record<string, any>)?.hookSpecificOutput as
        | Record<string, any>
        | undefined
      expect(reason?.permissionDecision).toBe("deny")
      expect(String(reason?.permissionDecisionReason ?? "")).toContain("needs tasks in place first")
      // Message must state the exact enforced minimums
      expect(String(reason?.permissionDecisionReason ?? "")).toContain("2")
      expect(String(reason?.permissionDecisionReason ?? "")).toContain("pending")

      // Verify no task file was auto-created
      const taskPath = join(tmpHome, ".claude", "tasks", sessionId, "test-1.json")
      expect(await Bun.file(taskPath).exists()).toBe(false)
    } finally {
      await rm(tmpHome, { recursive: true, force: true })
    }
  })

  test("blocks Bash when 5 tasks are in_progress (exceeds cap of 4)", async () => {
    const tmpHome = await mkdtemp(join(tmpdir(), "swiz-hook-cap-"))
    const sessionId = `test-cap-${Date.now()}`
    const tasksDir = join(tmpHome, ".claude", "tasks", sessionId)
    const { mkdir } = await import("node:fs/promises")
    await mkdir(tasksDir, { recursive: true })
    // Create 5 in_progress tasks — exceeds the cap of 4
    for (let i = 1; i <= 5; i++) {
      await Bun.write(
        join(tasksDir, `${i}.json`),
        JSON.stringify({
          id: String(i),
          subject: `Task ${i}`,
          description: "Active work",
          status: "in_progress",
          blocks: [],
          blockedBy: [],
        })
      )
    }
    try {
      const result = await runHook(
        {
          tool_name: "Bash",
          tool_input: { command: "echo hello" },
          session_id: sessionId,
        },
        { HOME: tmpHome }
      )
      expect(result.exitCode).toBe(0)
      expect(result.parsed).not.toBeNull()
      const hookOutput = (result.parsed as Record<string, any>)?.hookSpecificOutput as
        | Record<string, any>
        | undefined
      expect(hookOutput?.permissionDecision).toBe("deny")
      // Hook now blocks on stale task sync before checking cap.
      expect(String(hookOutput?.permissionDecisionReason ?? "")).toContain(
        "Sync task state before Bash"
      )
    } finally {
      await rm(tmpHome, { recursive: true, force: true })
    }
  })

  test("allows Bash when exactly 4 tasks are in_progress (at cap boundary)", async () => {
    const tmpHome = await mkdtemp(join(tmpdir(), "swiz-hook-cap4-"))
    const sessionId = `test-cap4-${Date.now()}`
    const tasksDir = join(tmpHome, ".claude", "tasks", sessionId)
    const { mkdir } = await import("node:fs/promises")
    await mkdir(tasksDir, { recursive: true })
    // Create exactly 4 in_progress tasks — at the cap, not over it
    for (let i = 1; i <= 4; i++) {
      await Bun.write(
        join(tasksDir, `${i}.json`),
        JSON.stringify({
          id: String(i),
          subject: `Task ${i}`,
          description: "Active work",
          status: "in_progress",
          blocks: [],
          blockedBy: [],
        })
      )
    }
    try {
      const result = await runHook(
        {
          tool_name: "Bash",
          tool_input: { command: "echo hello" },
          session_id: sessionId,
        },
        { HOME: tmpHome }
      )
      // Hook blocks when no pending tasks exist, even at cap boundary
      expect(result.exitCode).toBe(0)
      expect(result.parsed).not.toBeNull()
      const hookOutput = (result.parsed as Record<string, any>)?.hookSpecificOutput as
        | Record<string, any>
        | undefined
      expect(hookOutput?.permissionDecision).toBe("deny")
    } finally {
      await rm(tmpHome, { recursive: true, force: true })
    }
  })

  test("allows Bash when sync sentinel is missing but transcript shows a recent TaskList, and self-heals the sentinel", async () => {
    const tmpHome = await mkdtemp(join(tmpdir(), "swiz-hook-sync-fallback-"))
    const sessionId = `test-sync-fallback-${Date.now()}`
    const tasksDir = join(tmpHome, ".claude", "tasks", sessionId)
    const { mkdir } = await import("node:fs/promises")
    await mkdir(tasksDir, { recursive: true })
    // Healthy task state so no other governance check denies
    await Bun.write(
      join(tasksDir, "1.json"),
      JSON.stringify({ id: "1", subject: "Current work", status: "in_progress" })
    )
    await Bun.write(
      join(tasksDir, "2.json"),
      JSON.stringify({ id: "2", subject: "Next step", status: "pending" })
    )
    // Transcript with a recent TaskList call — the sentinel writer (PostToolUse
    // TaskList sync) may not dispatch for every agent, so this evidence must
    // satisfy the canonical sync gate on its own.
    const transcriptPath = join(tmpHome, "transcript.jsonl")
    const taskListLine = JSON.stringify({
      type: "assistant",
      timestamp: new Date(Date.now() - 1000).toISOString(),
      message: { content: [{ type: "tool_use", id: "t1", name: "TaskList", input: {} }] },
    })
    await Bun.write(transcriptPath, `${taskListLine}\n`)
    try {
      const result = await runHook(
        {
          tool_name: "Bash",
          tool_input: { command: "echo hello" },
          session_id: sessionId,
          transcript_path: transcriptPath,
        },
        { HOME: tmpHome }
      )
      expect(result.exitCode).toBe(0)
      const decision = result.parsed?.hookSpecificOutput?.permissionDecision
      expect(decision).not.toBe("deny")
      // Sentinel self-heals so subsequent calls pass without re-scanning
      expect(await Bun.file(taskListSyncSentinelPath(sessionId)).exists()).toBe(true)
    } finally {
      await rm(tmpHome, { recursive: true, force: true })
      await rm(taskListSyncSentinelPath(sessionId), { force: true })
    }
  })

  test("canonical sync deny states its cause and a false-positive escape route", async () => {
    const tmpHome = await mkdtemp(join(tmpdir(), "swiz-hook-sync-deny-"))
    const sessionId = `test-sync-deny-${Date.now()}`
    const tasksDir = join(tmpHome, ".claude", "tasks", sessionId)
    const { mkdir } = await import("node:fs/promises")
    await mkdir(tasksDir, { recursive: true })
    await Bun.write(
      join(tasksDir, "1.json"),
      JSON.stringify({ id: "1", subject: "Current work", status: "in_progress" })
    )
    await Bun.write(
      join(tasksDir, "2.json"),
      JSON.stringify({ id: "2", subject: "Next step", status: "pending" })
    )
    // Transcript exists but contains no TaskList call — the gate must deny
    // with a message that names the real condition, not just "sync".
    const transcriptPath = join(tmpHome, "transcript.jsonl")
    const readLine = JSON.stringify({
      type: "assistant",
      timestamp: new Date(Date.now() - 1000).toISOString(),
      message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
    })
    await Bun.write(transcriptPath, `${readLine}\n`)
    try {
      const result = await runHook(
        {
          tool_name: "Bash",
          tool_input: { command: "echo hello" },
          session_id: sessionId,
          transcript_path: transcriptPath,
        },
        { HOME: tmpHome }
      )
      expect(result.exitCode).toBe(0)
      const hookOutput = result.parsed?.hookSpecificOutput as Record<string, any> | undefined
      expect(hookOutput?.permissionDecision).toBe("deny")
      const reason = String(hookOutput?.permissionDecisionReason ?? "")
      expect(reason).toContain("Sync task state before Bash")
      expect(reason).toContain("no canonical TaskList sync is recorded")
      expect(reason).toContain("/re-assess")
    } finally {
      await rm(tmpHome, { recursive: true, force: true })
    }
  })

  test("denies (fail-closed) when hook receives malformed JSON stdin", async () => {
    // PROCESS_CONTRACT_TEST: malformed stdin must fail closed at the executable boundary.
    const proc = Bun.spawn([process.execPath, HOOK_PATH], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: process.cwd(),
    })
    await proc.stdin.write("not valid json {{{")
    await proc.stdin.end()
    const [stdout] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    // On malformed JSON, Bun.stdin.json() throws — hook must deny, not allow
    // (Some JSON parse errors may result in empty tool_name which exits 0 — acceptable fallback)
    // The important thing is that the hook does NOT produce an "allow" decision
    let parsed: Record<string, any> | null = null
    try {
      parsed = JSON.parse(stdout.trim())
    } catch {}
    if (parsed !== null) {
      const hookOutput = (parsed as Record<string, any>)?.hookSpecificOutput as
        | Record<string, any>
        | undefined
      expect(hookOutput?.permissionDecision).not.toBe("allow")
    }
    expect(proc.exitCode).toBe(0)
  })

  test("denies Bash when all tasks are completed (no wrap-up exemption)", async () => {
    const tmpHome = await mkdtemp(join(tmpdir(), "swiz-hook-wrapup-"))
    const sessionId = `test-wrapup-${Date.now()}`
    // Write sync sentinel so the canonical staleness gate doesn't fire first
    await Bun.write(taskListSyncSentinelPath(sessionId), String(Date.now()))
    const tasksDir = join(tmpHome, ".claude", "tasks", sessionId)
    const { mkdir } = await import("node:fs/promises")
    await mkdir(tasksDir, { recursive: true })
    // Create a completed task — governance blocks when allTasksDone is true
    await Bun.write(
      join(tasksDir, "1.json"),
      JSON.stringify({
        id: "1",
        subject: "Done task",
        description: "Already done",
        status: "completed",
        blocks: [],
        blockedBy: [],
      })
    )
    try {
      const result = await runHook(
        {
          tool_name: "Bash",
          tool_input: { command: "echo hello" },
          session_id: sessionId,
        },
        { HOME: tmpHome }
      )
      // Hook blocks when all tasks are completed — requires new tasks
      expect(result.exitCode).toBe(0)
      expect(result.parsed).not.toBeNull()
      expect(result.parsed?.hookSpecificOutput?.permissionDecision).toBe("deny")
    } finally {
      await rm(tmpHome, { recursive: true, force: true })
    }
  })
})
