import { describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { useTempDir } from "../utils/test-utils.ts"
import {
  isWithinUserMessageGrace,
  lastUserMessageAtFromPayload,
  resolveLastUserMessageAt,
  USER_MESSAGE_GRACE_MS,
} from "./task-governance-grace.ts"

const { create: createTempDir } = useTempDir("swiz-grace-")

describe("lastUserMessageAtFromPayload", () => {
  test("reads a finite injected number", () => {
    expect(lastUserMessageAtFromPayload({ _lastUserMessageAt: 1234 })).toBe(1234)
  })

  test("returns null for missing or non-finite values", () => {
    expect(lastUserMessageAtFromPayload({})).toBeNull()
    expect(lastUserMessageAtFromPayload({ _lastUserMessageAt: Number.NaN })).toBeNull()
    expect(lastUserMessageAtFromPayload({ _lastUserMessageAt: "1234" })).toBeNull()
  })
})

describe("resolveLastUserMessageAt", () => {
  test("prefers the injected payload field over the transcript", async () => {
    const at = await resolveLastUserMessageAt({
      _lastUserMessageAt: 9999,
      transcript_path: "/does/not/matter.jsonl",
    })
    expect(at).toBe(9999)
  })

  test("falls back to a transcript scan when no field is injected", async () => {
    const dir = await createTempDir()
    const ts = "2026-05-29T10:00:00.000Z"
    const path = join(dir, "transcript.jsonl")
    await writeFile(
      path,
      [
        JSON.stringify({ type: "user", timestamp: ts, message: { content: "hello" } }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-05-29T10:00:05.000Z",
          message: { content: [{ type: "text", text: "hi" }] },
        }),
      ].join("\n")
    )
    expect(await resolveLastUserMessageAt({ transcript_path: path })).toBe(Date.parse(ts))
  })

  test("returns null with neither field nor transcript path", async () => {
    expect(await resolveLastUserMessageAt({})).toBeNull()
  })
})

describe("isWithinUserMessageGrace", () => {
  test("true when the last user message is inside the window", async () => {
    const now = 1_000_000
    const input = { _lastUserMessageAt: now - (USER_MESSAGE_GRACE_MS - 1) }
    expect(await isWithinUserMessageGrace(input, now)).toBe(true)
  })

  test("true exactly at the window boundary", async () => {
    const now = 1_000_000
    const input = { _lastUserMessageAt: now - USER_MESSAGE_GRACE_MS }
    expect(await isWithinUserMessageGrace(input, now)).toBe(true)
  })

  test("false once the window has elapsed", async () => {
    const now = 1_000_000
    const input = { _lastUserMessageAt: now - (USER_MESSAGE_GRACE_MS + 1) }
    expect(await isWithinUserMessageGrace(input, now)).toBe(false)
  })

  test("fails closed when no time can be resolved", async () => {
    expect(await isWithinUserMessageGrace({})).toBe(false)
  })
})

describe("require-tasks gate honours the grace window", () => {
  // PROJECT_ROOT (this repo) is a git repo with CLAUDE.md, so it is a task-enforcement
  // project — a session with no tasks would normally be denied.
  const PROJECT_ROOT = join(import.meta.dir, "..", "..")

  async function evalRequireTasks(input: Record<string, any>) {
    const { evaluatePretooluseRequireTasks } = await import(
      "../../hooks/pretooluse-task-governance.ts"
    )
    const out = (await evaluatePretooluseRequireTasks(input)) as Record<string, any>
    const hso = out.hookSpecificOutput as Record<string, any> | undefined
    return (hso?.permissionDecision ?? out.decision) as string | undefined
  }

  test("relaxes a would-be deny within the grace window", async () => {
    const taskHome = await createTempDir()
    const decision = await evalRequireTasks({
      tool_name: "Bash",
      session_id: `grace-session-${Date.now()}`,
      cwd: PROJECT_ROOT,
      _taskHome: taskHome,
      _lastUserMessageAt: Date.now(),
      tool_input: { command: "bun run dev" },
    })
    expect(decision).toBeUndefined()
  })

  test("still denies once the grace window has elapsed", async () => {
    const taskHome = await createTempDir()
    const decision = await evalRequireTasks({
      tool_name: "Bash",
      session_id: `stale-session-${Date.now()}`,
      cwd: PROJECT_ROOT,
      _taskHome: taskHome,
      _lastUserMessageAt: Date.now() - (USER_MESSAGE_GRACE_MS + 60_000),
      tool_input: { command: "bun run dev" },
    })
    expect(decision).toBe("deny")
  })
})
