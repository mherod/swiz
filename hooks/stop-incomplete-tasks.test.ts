import { describe, expect, test } from "bun:test"
import { AGENTS } from "../src/agents.ts"
import { useTempDir, writeTask } from "../src/utils/test-utils.ts"

interface HookResult {
  decision?: string
  reason?: string
}

async function runHook({
  homeDir,
  cwd,
  sessionId = "session-123",
  envOverrides = {},
  transcriptPath,
}: {
  homeDir: string
  cwd?: string
  sessionId?: string
  envOverrides?: Record<string, string | undefined>
  transcriptPath?: string
}): Promise<HookResult> {
  const hasOtherAgent = Object.keys(envOverrides).some((key) =>
    AGENTS.some((a) => a.id !== "claude" && a.envVars?.includes(key))
  )
  const finalEnvOverrides = { ...envOverrides }
  if (!hasOtherAgent && !envOverrides.CLAUDECODE) {
    finalEnvOverrides.CLAUDECODE = "1"
  }

  const payload = JSON.stringify({
    session_id: sessionId,
    cwd: cwd ?? process.cwd(),
    hook_event_name: "Stop",
    ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
    _env: finalEnvOverrides,
  })
  const env: Record<string, string | undefined> = { ...process.env, HOME: homeDir }
  for (const agent of AGENTS) {
    for (const v of agent.envVars ?? []) env[v] = ""
  }
  env.SWIZ_DAEMON_PORT = "19999"
  const proc = Bun.spawn(["bun", "hooks/stop-incomplete-tasks.ts"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...env, ...envOverrides },
  })
  await proc.stdin.write(payload)
  await proc.stdin.end()

  const out = await new Response(proc.stdout).text()
  await proc.exited
  if (!out.trim()) return {}

  const parsed = JSON.parse(out.trim())
  const hso = parsed.hookSpecificOutput as Record<string, any> | undefined
  return {
    decision: (hso?.decision ?? parsed.decision) as string | undefined,
    reason: (hso?.reason ?? parsed.reason) as string | undefined,
  }
}

const { create: createTempHome } = useTempDir("swiz-stop-incomplete-tasks-")

describe("stop-incomplete-tasks", () => {
  test("blocks stop when session has incomplete tasks", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-incomplete"
    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Unfinished work",
      status: "in_progress",
    })

    const result = await runHook({ homeDir, sessionId })
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("Unfinished work")
  })

  test("allows stop when all tasks are completed", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-completed"
    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Done work",
      status: "completed",
    })

    const result = await runHook({ homeDir, sessionId })
    expect(result.decision).toBeUndefined()
  })

  test("allows stop when running in Gemini CLI (GEMINI_CLI=1) even with incomplete tasks", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-gemini-incomplete"
    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Gemini work",
      status: "in_progress",
    })

    const result = await runHook({
      homeDir,
      sessionId,
      envOverrides: { GEMINI_CLI: "1" },
    })
    expect(result.decision).toBeUndefined()
  })

  test("integration: blocks on pending task, allows after completion transition", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-integration"

    // Phase 1: Pending task created
    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Feature implementation",
      status: "pending",
    })

    // Phase 2: Agent transitions to in_progress
    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Feature implementation",
      status: "in_progress",
    })

    // Phase 3: Hook blocks on in_progress task
    const blockResult = await runHook({ homeDir, sessionId })
    expect(blockResult.decision).toBe("block")
    expect(blockResult.reason).toContain("Incomplete tasks remain")
    expect(blockResult.reason).toContain("Feature implementation")

    // Phase 4: Agent completes task with evidence
    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Feature implementation",
      status: "completed",
    })

    // Phase 5: Hook allows stop once no incomplete tasks remain
    const allowResult = await runHook({ homeDir, sessionId })
    expect(allowResult.decision).toBeUndefined()
  })

  test("blocks stop when only deferred-subject pending tasks remain", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-deferred-only"

    // A real-work task that is completed
    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Ship the feature",
      status: "completed",
    })
    // Forward-looking notes that should block stop
    await writeTask(homeDir, sessionId, {
      id: "2",
      subject: "Consider promoting fragmentation thresholds to swiz settings",
      status: "pending",
    })
    await writeTask(homeDir, sessionId, {
      id: "3",
      subject: "Future: revisit cache TTL",
      status: "pending",
    })
    await writeTask(homeDir, sessionId, {
      id: "4",
      subject: "Follow-up: docs for new flag",
      status: "pending",
    })

    const result = await runHook({ homeDir, sessionId })
    expect(result.decision).toBe("block")
    expect(result.reason).toContain(
      "The remaining tasks were parked under a deferral label instead of completed"
    )
    expect(result.reason).toContain("revisit cache TTL")
    expect(result.reason).toContain("docs for new flag")
  })

  test("blocks when sole remaining task has a deferral prefix (dodge steering)", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-sole-deferred"

    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Ship the feature",
      status: "completed",
    })
    // Only one incomplete task remains — and it's a deferral dodge
    await writeTask(homeDir, sessionId, {
      id: "2",
      subject: "Future: add rate-limiting to comments endpoint",
      status: "pending",
    })

    const result = await runHook({ homeDir, sessionId })
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("add rate-limiting to comments endpoint")
    expect(result.reason).toContain("Do the work now")
  })

  test("blocks stop when multiple deferred tasks remain", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-multi-deferred"

    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Ship the feature",
      status: "completed",
    })
    await writeTask(homeDir, sessionId, {
      id: "2",
      subject: "Future: add rate-limiting to comments endpoint",
      status: "pending",
    })
    await writeTask(homeDir, sessionId, {
      id: "3",
      subject: "Consider extracting helper",
      status: "pending",
    })

    const result = await runHook({ homeDir, sessionId })
    expect(result.decision).toBe("block")
    expect(result.reason).toContain(
      "The remaining tasks were parked under a deferral label instead of completed"
    )
    expect(result.reason).toContain("add rate-limiting to comments endpoint")
    expect(result.reason).toContain("extracting helper")
  })

  test("blocks when real pending task sits alongside deferred subjects", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-deferred-mixed"

    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Wire up the migration",
      status: "in_progress",
    })
    await writeTask(homeDir, sessionId, {
      id: "2",
      subject: "Consider extracting helper",
      status: "pending",
    })

    const result = await runHook({ homeDir, sessionId })
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("Wire up the migration")
    // Deferred subject must not appear in blocking list
    expect(result.reason).not.toContain("Consider extracting helper")
  })

  test("blocks Codex stop on incomplete tasks without requiring TaskList", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-codex-transcript"
    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Codex work",
      status: "in_progress",
    })

    const result = await runHook({
      homeDir,
      sessionId,
      envOverrides: { CODEX_MANAGED_BY_NPM: "1" },
      transcriptPath: `${homeDir}/.codex/sessions/abc123.jsonl`,
    })
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("Codex work")
    expect(result.reason).toContain("Use update_plan to update task statuses")
    expect(result.reason).not.toContain("TaskList")
    expect(result.reason).not.toContain("TaskUpdate")
  })

  test("gate behavior: multiple incomplete tasks ordered in-progress first", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-task-ordering"

    // Create tasks with different subjects (avoid dedup matching)
    // Task ordering should prioritize in_progress, then sort numerically
    await writeTask(homeDir, sessionId, {
      id: "10",
      subject: "Implement API endpoint",
      status: "in_progress",
    })
    await writeTask(homeDir, sessionId, {
      id: "5",
      subject: "Add unit tests for validation",
      status: "pending",
    })

    const result = await runHook({ homeDir, sessionId })
    expect(result.decision).toBe("block")
    // Verify both incomplete tasks are listed
    expect(result.reason).toContain("Implement API endpoint")
    expect(result.reason).toContain("Add unit tests for validation")
    // in_progress should appear first in the listing
    const endpointIdx = result.reason?.indexOf("Implement API endpoint") ?? -1
    const testIdx = result.reason?.indexOf("Add unit tests for validation") ?? -1
    expect(endpointIdx).toBeLessThan(testIdx)
  })
})
