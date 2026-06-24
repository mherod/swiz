import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { evaluatePostcompactTaskRestore } from "./postcompact-task-restore.ts"
import type { CompactSnapshot } from "./precompact-task-snapshot.ts"

// The shared compact-recovery helpers resolve task paths from $HOME. HOME is set
// ONCE for the whole file (not per-test) so concurrent tests never race on the
// shared env var; each test uses a unique session ID under ~/.claude/tasks/.
let home = ""
let originalHome: string | undefined

async function seedTasksDir(sessionId: string): Promise<string> {
  const dir = join(home, ".claude", "tasks", sessionId)
  await mkdir(dir, { recursive: true })
  return dir
}

async function writeSnapshot(dir: string, snapshot: CompactSnapshot): Promise<void> {
  await writeFile(join(dir, "compact-snapshot.json"), JSON.stringify(snapshot))
}

beforeAll(async () => {
  originalHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "swiz-postcompact-"))
  process.env.HOME = home
})

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (home) await rm(home, { recursive: true, force: true })
})

describe("evaluatePostcompactTaskRestore", () => {
  test("emits recovery guidance even with no snapshot or tasks", async () => {
    await seedTasksDir("sess-empty")
    const out = await evaluatePostcompactTaskRestore({
      session_id: "sess-empty",
      hook_event_name: "PostCompact",
    })
    const ctx =
      (out as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput
        ?.additionalContext ?? ""
    expect(ctx).toContain("TaskList")
  })

  test("returns empty output for malformed input", async () => {
    const out = await evaluatePostcompactTaskRestore(42)
    expect(out).toEqual({})
  })

  test("recreates a missing task file from the snapshot", async () => {
    const dir = await seedTasksDir("sess-restore")
    const snapshot: CompactSnapshot = {
      sessionId: "sess-restore",
      compactedAt: "2026-06-24T00:00:00.000Z",
      tasks: [{ id: "7", subject: "Ship the gate", status: "in_progress" }],
    }
    await writeSnapshot(dir, snapshot)

    const out = await evaluatePostcompactTaskRestore({
      session_id: "sess-restore",
      hook_event_name: "PostCompact",
    })

    const restored = Bun.file(join(dir, "7.json"))
    expect(await restored.exists()).toBe(true)
    const parsed = (await restored.json()) as { id: string; status: string }
    expect(parsed.id).toBe("7")
    expect(parsed.status).toBe("in_progress")

    const ctx =
      (out as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput
        ?.additionalContext ?? ""
    expect(ctx).toContain("restored")
  })

  test("does not overwrite an existing task file", async () => {
    const dir = await seedTasksDir("sess-keep")
    await writeFile(
      join(dir, "3.json"),
      JSON.stringify({ id: "3", subject: "Original", status: "completed" })
    )
    const snapshot: CompactSnapshot = {
      sessionId: "sess-keep",
      compactedAt: "2026-06-24T00:00:00.000Z",
      tasks: [{ id: "3", subject: "Snapshot copy", status: "pending" }],
    }
    await writeSnapshot(dir, snapshot)

    await evaluatePostcompactTaskRestore({
      session_id: "sess-keep",
      hook_event_name: "PostCompact",
    })

    const parsed = (await Bun.file(join(dir, "3.json")).json()) as { subject: string }
    expect(parsed.subject).toBe("Original")
  })
})
