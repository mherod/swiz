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
})
