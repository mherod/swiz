import { afterEach, describe, expect, it } from "bun:test"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  extractCodexUpdatePlanSnapshots,
  syncCodexUpdatePlanFromTranscriptSummary,
  syncCodexUpdatePlanSnapshot,
} from "./codex-update-plan.ts"
import { pruneSession } from "./task-event-state.ts"
import { readTasks } from "./task-repository.ts"

const TEST_SESSIONS = ["codex-plan-sync", "codex-plan-summary", "codex-plan-transcript-path"]

function codexPlanLine(args: Record<string, unknown>, callId = "call_plan"): string {
  return JSON.stringify({
    timestamp: "2026-05-19T16:21:03.564Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "update_plan",
      arguments: JSON.stringify(args),
      call_id: callId,
    },
  })
}

describe("codex-update-plan", () => {
  afterEach(() => {
    for (const sessionId of TEST_SESSIONS) pruneSession(sessionId)
  })

  it("extracts Codex update_plan snapshots from transcript lines", () => {
    const snapshots = extractCodexUpdatePlanSnapshots(
      [
        JSON.stringify({ type: "system", content: "older compacted content" }),
        codexPlanLine({
          explanation: "Working through the task sync implementation.",
          plan: [
            { step: "Inspect task sync", status: "completed" },
            { step: "Mirror update_plan tasks", status: "in_progress" },
            { step: "Run tests", status: "pending" },
          ],
        }),
      ].join("\n")
    )

    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.explanation).toBe("Working through the task sync implementation.")
    expect(snapshots[0]?.plan).toEqual([
      { step: "Inspect task sync", status: "completed" },
      { step: "Mirror update_plan tasks", status: "in_progress" },
      { step: "Run tests", status: "pending" },
    ])
  })

  it("syncs the latest update_plan snapshot into file-backed tasks", async () => {
    const tempRoot = join(tmpdir(), `swiz-codex-plan-${crypto.randomUUID()}`)
    const tasksDir = join(tempRoot, "tasks")
    const sessionId = "codex-plan-sync"

    await syncCodexUpdatePlanSnapshot(
      sessionId,
      {
        explanation: "Implement Codex plan syncing.",
        plan: [
          { step: "Inspect Codex dumps", status: "completed" },
          { step: "Implement parser", status: "in_progress" },
          { step: "Run focused tests", status: "pending" },
        ],
      },
      { cwd: process.cwd(), tasksDir }
    )

    let tasks = await readTasks(sessionId, tasksDir)
    expect(tasks.map((task) => [task.id, task.subject, task.status])).toEqual([
      ["codex-1", "Inspect Codex dumps", "completed"],
      ["codex-2", "Implement parser", "in_progress"],
      ["codex-3", "Run focused tests", "pending"],
    ])

    const result = await syncCodexUpdatePlanSnapshot(
      sessionId,
      {
        plan: [
          { step: "Inspect Codex dumps", status: "completed" },
          { step: "Implement parser", status: "completed" },
        ],
      },
      { cwd: process.cwd(), tasksDir }
    )

    expect(result.updated).toBe(1)
    expect(result.cancelled).toBe(1)
    tasks = await readTasks(sessionId, tasksDir)
    expect(tasks.map((task) => [task.id, task.subject, task.status])).toEqual([
      ["codex-1", "Inspect Codex dumps", "completed"],
      ["codex-2", "Implement parser", "completed"],
      ["codex-3", "Run focused tests", "cancelled"],
    ])
  })

  it("clears completion metadata when a Codex plan item becomes incomplete again", async () => {
    const tempRoot = join(tmpdir(), `swiz-codex-plan-reopen-${crypto.randomUUID()}`)
    const tasksDir = join(tempRoot, "tasks")
    const sessionId = "codex-plan-sync"

    await syncCodexUpdatePlanSnapshot(
      sessionId,
      {
        plan: [{ step: "Push branch to remote", status: "completed" }],
      },
      { cwd: process.cwd(), tasksDir }
    )

    let tasks = await readTasks(sessionId, tasksDir)
    expect(tasks[0]?.completionTimestamp).toBeTruthy()

    await syncCodexUpdatePlanSnapshot(
      sessionId,
      {
        plan: [{ step: "Push branch to remote", status: "pending" }],
      },
      { cwd: process.cwd(), tasksDir }
    )

    tasks = await readTasks(sessionId, tasksDir)
    expect(tasks[0]?.status).toBe("pending")
    expect(tasks[0]?.completedAt).toBeNull()
    expect(tasks[0]?.completionTimestamp).toBeUndefined()
    expect(tasks[0]?.completionEvidence).toBeUndefined()
  })

  it("syncs from a transcript summary for Codex payloads", async () => {
    const originalHome = process.env.HOME
    const tempHome = join(tmpdir(), `swiz-codex-home-${crypto.randomUUID()}`)
    process.env.HOME = tempHome
    try {
      const sessionId = "codex-plan-summary"
      const sessionLines = [
        codexPlanLine({
          plan: [
            { step: "Read incoming dumps", status: "completed" },
            { step: "Wire task sync", status: "in_progress" },
          ],
        }),
      ]

      await syncCodexUpdatePlanFromTranscriptSummary(
        {
          session_id: sessionId,
          cwd: process.cwd(),
          transcript_path: join(tempHome, ".codex", "sessions", "session.jsonl"),
        },
        {
          toolNames: ["update_plan"],
          toolCallCount: 1,
          bashCommands: [],
          skillInvocations: [],
          hasGitPush: false,
          sessionLines,
          sessionDurationMs: 0,
          successfulTestRuns: 0,
          lastVerificationTime: null,
          sessionScope: "trivial",
        }
      )

      const tasksDir = join(tempHome, ".codex", "tasks")
      await mkdir(tasksDir, { recursive: true })
      const tasks = await readTasks(sessionId, tasksDir)
      expect(tasks.map((task) => [task.id, task.status, task.subject])).toEqual([
        ["codex-1", "completed", "Read incoming dumps"],
        ["codex-2", "in_progress", "Wire task sync"],
      ])
    } finally {
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
    }
  })

  it("syncs from transcript_path when the daemon has no transcript summary", async () => {
    const originalHome = process.env.HOME
    const tempHome = join(tmpdir(), `swiz-codex-home-${crypto.randomUUID()}`)
    process.env.HOME = tempHome
    try {
      const sessionId = "codex-plan-transcript-path"
      const transcriptPath = join(tempHome, ".codex", "sessions", "2026", "session.jsonl")
      await mkdir(join(tempHome, ".codex", "sessions", "2026"), { recursive: true })
      await Bun.write(
        transcriptPath,
        codexPlanLine({
          plan: [
            { step: "Detect daemon update_plan", status: "completed" },
            { step: "Mirror plan from transcript", status: "in_progress" },
          ],
        })
      )

      const result = await syncCodexUpdatePlanFromTranscriptSummary(
        {
          session_id: sessionId,
          cwd: process.cwd(),
          transcript_path: transcriptPath,
        },
        null
      )

      expect(result?.snapshots).toBe(1)
      const tasks = await readTasks(sessionId, join(tempHome, ".codex", "tasks"))
      expect(tasks.map((task) => [task.id, task.status, task.subject])).toEqual([
        ["codex-1", "completed", "Detect daemon update_plan"],
        ["codex-2", "in_progress", "Mirror plan from transcript"],
      ])
    } finally {
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
    }
  })
})
