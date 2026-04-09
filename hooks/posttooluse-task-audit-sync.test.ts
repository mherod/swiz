import { describe, expect, test } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AGENTS } from "../src/agents.ts"

interface HookJson {
  systemMessage?: string
  hookSpecificOutput?: { additionalContext?: string }
}

async function runHook(payload: Record<string, any>, home: string): Promise<HookJson> {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home }
  for (const agent of AGENTS) {
    for (const v of agent.envVars ?? []) env[v] = ""
  }

  const proc = Bun.spawn(["bun", "hooks/posttooluse-task-audit-sync.ts"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
  })
  await proc.stdin.write(`${JSON.stringify(payload)}\n`)
  await proc.stdin.end()

  const raw = await new Response(proc.stdout).text()
  await proc.exited
  expect(proc.exitCode).toBe(0)
  expect(raw.trim()).not.toBe("")
  return JSON.parse(raw.trim()) as HookJson
}

describe("posttooluse-task-audit-sync: emits full task list in systemMessage", () => {
  test("TaskUpdate returns systemMessage including current tasks", async () => {
    const home = join(
      tmpdir(),
      `swiz-task-audit-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    const sessionId = "11111111-1111-1111-1111-111111111111"
    const tasksDir = join(home, ".claude", "tasks", sessionId)

    try {
      await mkdir(tasksDir, { recursive: true })
      await Bun.write(
        join(tasksDir, "1.json"),
        JSON.stringify({ id: "1", subject: "Do the thing", description: "desc", status: "pending" })
      )

      const out = await runHook(
        {
          tool_name: "TaskUpdate",
          tool_input: { taskId: "1", status: "in_progress", subject: "Do the thing" },
          cwd: "/tmp",
          session_id: sessionId,
        },
        home
      )

      expect(out.systemMessage).toContain("Current tasks:")
      expect(out.systemMessage).toContain("• #1 [pending]: Do the thing")
      expect(out.hookSpecificOutput?.additionalContext).toContain("Current tasks:")
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
