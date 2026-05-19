import { describe, expect, it } from "bun:test"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTaskStoreForHookPayload, findTaskStoreForSession } from "./task-roots.ts"

describe("task roots", () => {
  it("resolves Codex task roots from a Codex hook payload", () => {
    const roots = createTaskStoreForHookPayload({
      transcript_path: "/Users/test/.codex/sessions/2026/05/19/session.jsonl",
    })

    expect(roots.tasksDir).toEndWith("/.codex/tasks")
  })

  it("finds the provider task root that owns a session", async () => {
    const home = join(tmpdir(), `swiz-task-roots-${crypto.randomUUID()}`)
    const sessionId = "codex-session"
    const tasksDir = join(home, ".codex", "tasks", sessionId)
    await mkdir(tasksDir, { recursive: true })
    await Bun.write(
      join(tasksDir, "codex-1.json"),
      JSON.stringify({ id: "codex-1", subject: "Plan task", status: "pending" })
    )

    const roots = findTaskStoreForSession(sessionId, home)
    expect(roots.tasksDir).toBe(join(home, ".codex", "tasks"))
  })
})
