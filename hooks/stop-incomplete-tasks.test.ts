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
}: {
  homeDir: string
  cwd?: string
  sessionId?: string
  envOverrides?: Record<string, string | undefined>
}): Promise<HookResult> {
  const payload = JSON.stringify({
    session_id: sessionId,
    cwd: cwd ?? process.cwd(),
    hook_event_name: "Stop",
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

  test("blocks stop when all tasks are completed (zero-task governance)", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-completed"
    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Done work",
      status: "completed",
    })

    const result = await runHook({ homeDir, sessionId })
    // Zero incomplete tasks triggers promotion + block — governance invariant
    expect(result.decision).toBe("block")
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

    // Phase 5: Hook blocks on zero-task governance — promotion creates successor
    const allowResult = await runHook({ homeDir, sessionId })
    expect(allowResult.decision).toBe("block")
  })

  test("allows stop when only deferred-subject pending tasks remain (issue #563)", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-deferred-only"

    // A real-work task that is completed
    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Ship the feature",
      status: "completed",
    })
    // Forward-looking notes that should NOT block stop
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
    expect(result.decision).toBeUndefined()
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
