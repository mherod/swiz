import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { taskListSyncSentinelPath } from "../temp-paths.ts"
import { acquireEnvLock, releaseEnvLockFn } from "../utils/test-utils.ts"
import {
  codexPlanSyncMarkerPath,
  extractCodexUpdatePlanSnapshots,
  getCodexPlanSyncMetrics,
  resetCodexPlanSyncStateForTests,
  syncCodexUpdatePlanFromTranscriptSummary,
  syncCodexUpdatePlanSnapshot,
} from "./codex-update-plan.ts"
import { pruneSession } from "./task-event-state.ts"
import { readTasks } from "./task-repository.ts"

const TEST_SESSIONS = [
  "codex-plan-sync",
  "codex-plan-summary",
  "codex-plan-transcript-path",
  "codex-plan-repeat",
  "codex-plan-restart",
  "codex-plan-same-plan",
  "codex-plan-marker-recovery",
  "codex-plan-marker-failure",
  "codex-plan-sentinel-failure",
]

function codexPlanLine(args: Record<string, unknown>, callId: string | null = "call_plan"): string {
  return JSON.stringify({
    timestamp: "2026-05-19T16:21:03.564Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "update_plan",
      arguments: JSON.stringify(args),
      ...(callId ? { call_id: callId } : {}),
    },
  })
}

describe("codex-update-plan", () => {
  afterEach(() => {
    for (const sessionId of TEST_SESSIONS) pruneSession(sessionId)
    resetCodexPlanSyncStateForTests()
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
    expect(snapshots[0]).not.toHaveProperty("identityArguments")
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

  it("skips an exact update_plan snapshot that was already applied", async () => {
    const tempRoot = join(tmpdir(), `swiz-codex-plan-repeat-${crypto.randomUUID()}`)
    const tasksDir = join(tempRoot, "tasks")
    const sessionId = "codex-plan-repeat"
    const snapshot = {
      callId: "call_exact_repeat",
      plan: [{ step: "Avoid duplicate task writes", status: "in_progress" as const }],
    }

    await syncCodexUpdatePlanSnapshot(sessionId, snapshot, { cwd: process.cwd(), tasksDir })
    const observedPaths = [
      join(tasksDir, sessionId, "codex-1.json"),
      join(tasksDir, sessionId, ".audit-log.jsonl"),
      join(tasksDir, sessionId, ".session-meta.json"),
      codexPlanSyncMarkerPath(sessionId, tasksDir),
      taskListSyncSentinelPath(sessionId),
    ]
    const before = await Promise.all(observedPaths.map(async (path) => (await stat(path)).mtimeMs))
    const markerBefore = await readFile(codexPlanSyncMarkerPath(sessionId, tasksDir), "utf-8")

    await Bun.sleep(20)
    let repeated = await syncCodexUpdatePlanSnapshot(sessionId, snapshot, {
      cwd: process.cwd(),
      tasksDir,
    })
    for (let index = 1; index < 99; index++) {
      repeated = await syncCodexUpdatePlanSnapshot(sessionId, snapshot, {
        cwd: process.cwd(),
        tasksDir,
      })
    }

    expect(repeated.skipped).toBe(1)
    const after = await Promise.all(observedPaths.map(async (path) => (await stat(path)).mtimeMs))
    expect(after).toEqual(before)
    expect(await readFile(codexPlanSyncMarkerPath(sessionId, tasksDir), "utf-8")).toBe(markerBefore)
    expect(markerBefore).not.toContain("Avoid duplicate task writes")
    expect(getCodexPlanSyncMetrics()).toMatchObject({ applied: 1, exactSnapshotSkips: 99 })
  })

  it("uses the durable marker after a process restart without rewriting task state", async () => {
    const tempRoot = join(tmpdir(), `swiz-codex-plan-restart-${crypto.randomUUID()}`)
    const tasksDir = join(tempRoot, "tasks")
    const sessionId = "codex-plan-restart"
    const snapshot = {
      callId: "call_restart",
      plan: [{ step: "Read durable marker", status: "pending" as const }],
    }

    await syncCodexUpdatePlanSnapshot(sessionId, snapshot, { tasksDir })
    const observedPaths = [
      join(tasksDir, sessionId, "codex-1.json"),
      join(tasksDir, sessionId, ".audit-log.jsonl"),
      join(tasksDir, sessionId, ".session-meta.json"),
      codexPlanSyncMarkerPath(sessionId, tasksDir),
      taskListSyncSentinelPath(sessionId),
    ]
    const before = await Promise.all(observedPaths.map(async (path) => (await stat(path)).mtimeMs))

    resetCodexPlanSyncStateForTests()
    await Bun.sleep(20)
    const repeated = await syncCodexUpdatePlanSnapshot(sessionId, snapshot, { tasksDir })

    expect(repeated.skipped).toBe(1)
    expect(
      await Promise.all(observedPaths.map(async (path) => (await stat(path)).mtimeMs))
    ).toEqual(before)
  })

  it("refreshes only the sentinel and marker for a new call with the same plan", async () => {
    const tempRoot = join(tmpdir(), `swiz-codex-plan-same-plan-${crypto.randomUUID()}`)
    const tasksDir = join(tempRoot, "tasks")
    const sessionId = "codex-plan-same-plan"
    const plan = [{ step: "Preserve task records", status: "pending" as const }]

    await syncCodexUpdatePlanSnapshot(sessionId, { callId: "call_one", plan }, { tasksDir })
    const taskPath = join(tasksDir, sessionId, "codex-1.json")
    const auditPath = join(tasksDir, sessionId, ".audit-log.jsonl")
    const markerPath = codexPlanSyncMarkerPath(sessionId, tasksDir)
    const sentinelPath = taskListSyncSentinelPath(sessionId)
    const taskAuditAndMetaBefore = await Promise.all(
      [taskPath, auditPath, join(tasksDir, sessionId, ".session-meta.json")].map(
        async (path) => (await stat(path)).mtimeMs
      )
    )
    const markerAndSentinelBefore = await Promise.all(
      [markerPath, sentinelPath].map(async (path) => (await stat(path)).mtimeMs)
    )

    await Bun.sleep(20)
    const result = await syncCodexUpdatePlanSnapshot(
      sessionId,
      { callId: "call_two", plan },
      { tasksDir }
    )

    expect(result.samePlan).toBe(1)
    expect(
      await Promise.all(
        [taskPath, auditPath, join(tasksDir, sessionId, ".session-meta.json")].map(
          async (path) => (await stat(path)).mtimeMs
        )
      )
    ).toEqual(taskAuditAndMetaBefore)
    const markerAndSentinelAfter = await Promise.all(
      [markerPath, sentinelPath].map(async (path) => (await stat(path)).mtimeMs)
    )
    expect(markerAndSentinelAfter[0]).toBeGreaterThan(markerAndSentinelBefore[0]!)
    expect(markerAndSentinelAfter[1]).toBeGreaterThan(markerAndSentinelBefore[1]!)
  })

  it("canonicalizes fallback identity and ignores explanation and object key order in plans", async () => {
    const tempRoot = join(tmpdir(), `swiz-codex-plan-canonical-${crypto.randomUUID()}`)
    const tasksDir = join(tempRoot, "tasks")
    const fallbackSessionId = "codex-plan-fallback-canonical"
    const samePlanSessionId = "codex-plan-same-plan-canonical"
    const [firstFallback] = extractCodexUpdatePlanSnapshots(
      codexPlanLine({ plan: [{ step: "Canonicalize fallback identity", status: "pending" }] }, null)
    )
    const [reorderedFallback] = extractCodexUpdatePlanSnapshots(
      codexPlanLine({ plan: [{ status: "pending", step: "Canonicalize fallback identity" }] }, null)
    )

    await syncCodexUpdatePlanSnapshot(fallbackSessionId, firstFallback!, { tasksDir })
    expect(
      await syncCodexUpdatePlanSnapshot(fallbackSessionId, reorderedFallback!, { tasksDir })
    ).toMatchObject({ skipped: 1 })

    const [firstPlan] = extractCodexUpdatePlanSnapshots(
      codexPlanLine(
        {
          explanation: "First wording only.",
          plan: [{ step: "Preserve semantic tasks", status: "in_progress" }],
        },
        "call_plan_first"
      )
    )
    const [samePlan] = extractCodexUpdatePlanSnapshots(
      codexPlanLine(
        { plan: [{ status: "in_progress", step: "Preserve semantic tasks" }] },
        "call_plan_second"
      )
    )

    await syncCodexUpdatePlanSnapshot(samePlanSessionId, firstPlan!, { tasksDir })
    const firstMarker = JSON.parse(
      await readFile(codexPlanSyncMarkerPath(samePlanSessionId, tasksDir), "utf-8")
    ) as { planFingerprint: string }
    expect(
      await syncCodexUpdatePlanSnapshot(samePlanSessionId, samePlan!, { tasksDir })
    ).toMatchObject({
      samePlan: 1,
    })
    const samePlanMarker = JSON.parse(
      await readFile(codexPlanSyncMarkerPath(samePlanSessionId, tasksDir), "utf-8")
    ) as { planFingerprint: string }
    expect(samePlanMarker.planFingerprint).toBe(firstMarker.planFingerprint)
  })

  it("reconciles a corrupt marker once and restores a hash-only marker", async () => {
    const tempRoot = join(tmpdir(), `swiz-codex-plan-marker-recovery-${crypto.randomUUID()}`)
    const tasksDir = join(tempRoot, "tasks")
    const sessionId = "codex-plan-marker-recovery"
    const snapshot = {
      callId: "call_marker_recovery",
      plan: [{ step: "Recover idempotency state", status: "pending" as const }],
    }

    await syncCodexUpdatePlanSnapshot(sessionId, snapshot, { tasksDir })
    const markerPath = codexPlanSyncMarkerPath(sessionId, tasksDir)
    await Bun.write(markerPath, "{invalid")
    resetCodexPlanSyncStateForTests()

    const result = await syncCodexUpdatePlanSnapshot(sessionId, snapshot, { tasksDir })

    expect(result.skipped).toBe(0)
    expect(result.unchanged).toBe(1)
    const recoveredMarker = JSON.parse(await readFile(markerPath, "utf-8"))
    expect(Object.keys(recoveredMarker).sort()).toEqual([
      "appliedAt",
      "planFingerprint",
      "snapshotIdentity",
      "version",
    ])
    expect(recoveredMarker).toMatchObject({
      version: 1,
      snapshotIdentity: expect.stringMatching(/^[a-f0-9]{64}$/),
      planFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
  })

  it("does not advance the marker when final marker persistence fails", async () => {
    const tempRoot = join(tmpdir(), `swiz-codex-plan-marker-failure-${crypto.randomUUID()}`)
    const tasksDir = join(tempRoot, "tasks")
    const sessionId = "codex-plan-marker-failure"
    const markerPath = codexPlanSyncMarkerPath(sessionId, tasksDir)

    await syncCodexUpdatePlanSnapshot(
      sessionId,
      { callId: "call_marker_before", plan: [{ step: "Initial plan", status: "pending" }] },
      { tasksDir }
    )
    const markerBefore = await readFile(markerPath, "utf-8")

    await expect(
      syncCodexUpdatePlanSnapshot(
        sessionId,
        { callId: "call_marker_after", plan: [{ step: "Changed plan", status: "completed" }] },
        {
          tasksDir,
          writeMarker: async () => {
            throw new Error("marker write failed")
          },
        }
      )
    ).rejects.toThrow("marker write failed")
    expect(await readFile(markerPath, "utf-8")).toBe(markerBefore)

    const retried = await syncCodexUpdatePlanSnapshot(
      sessionId,
      { callId: "call_marker_after", plan: [{ step: "Changed plan", status: "completed" }] },
      { tasksDir }
    )
    expect(retried.skipped).toBe(0)
    expect(JSON.parse(await readFile(markerPath, "utf-8"))).toMatchObject({
      snapshotIdentity: expect.not.stringMatching(JSON.parse(markerBefore).snapshotIdentity),
    })
    const auditEntries = (await readFile(join(tasksDir, sessionId, ".audit-log.jsonl"), "utf-8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { newStatus?: string })
    expect(auditEntries.map((entry) => entry.newStatus)).toEqual(["pending", "completed"])
  })

  it("does not advance the marker when sentinel persistence fails", async () => {
    const tempRoot = join(tmpdir(), `swiz-codex-plan-sentinel-failure-${crypto.randomUUID()}`)
    const tasksDir = join(tempRoot, "tasks")
    const sessionId = "codex-plan-sentinel-failure"
    const markerPath = codexPlanSyncMarkerPath(sessionId, tasksDir)

    await syncCodexUpdatePlanSnapshot(
      sessionId,
      { callId: "call_sentinel_before", plan: [{ step: "Initial plan", status: "pending" }] },
      { tasksDir }
    )
    const markerBefore = await readFile(markerPath, "utf-8")

    await expect(
      syncCodexUpdatePlanSnapshot(
        sessionId,
        { callId: "call_sentinel_after", plan: [{ step: "Changed plan", status: "completed" }] },
        {
          tasksDir,
          writeSentinel: async () => {
            throw new Error("sentinel write failed")
          },
        }
      )
    ).rejects.toThrow("sentinel write failed")
    expect(await readFile(markerPath, "utf-8")).toBe(markerBefore)

    const retried = await syncCodexUpdatePlanSnapshot(
      sessionId,
      { callId: "call_sentinel_after", plan: [{ step: "Changed plan", status: "completed" }] },
      { tasksDir }
    )
    expect(retried.skipped).toBe(0)
    expect((await readTasks(sessionId, tasksDir))[0]?.status).toBe("completed")
    const auditEntries = (await readFile(join(tasksDir, sessionId, ".audit-log.jsonl"), "utf-8"))
      .trim()
      .split("\n")
    expect(auditEntries).toHaveLength(2)
  })

  it("records content-free aggregate outcomes", async () => {
    const tempRoot = join(tmpdir(), `swiz-codex-plan-metrics-${crypto.randomUUID()}`)
    const tasksDir = join(tempRoot, "tasks")
    const sessionId = "codex-plan-repeat"
    const snapshot = {
      callId: "call_metrics",
      plan: [{ step: "Keep metrics aggregate", status: "pending" as const }],
    }

    await syncCodexUpdatePlanSnapshot(sessionId, snapshot, { tasksDir })
    await syncCodexUpdatePlanSnapshot(sessionId, snapshot, { tasksDir })

    const metrics = getCodexPlanSyncMetrics()
    expect(metrics).toMatchObject({ applied: 1, exactSnapshotSkips: 1, failed: 0 })
    expect(JSON.stringify(metrics)).not.toContain(sessionId)
    expect(JSON.stringify(metrics)).not.toContain("Keep metrics aggregate")
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
    await acquireEnvLock()
    const originalHome = process.env.HOME
    const tempHome = join(tmpdir(), `swiz-codex-home-${crypto.randomUUID()}`)
    try {
      process.env.HOME = tempHome
      const sessionId = "codex-plan-summary"
      const sessionLines = [
        codexPlanLine(
          {
            plan: [{ step: "Ignore superseded plan", status: "completed" }],
          },
          "call_superseded"
        ),
        codexPlanLine(
          {
            plan: [
              { step: "Read incoming dumps", status: "completed" },
              { step: "Wire task sync", status: "in_progress" },
            ],
          },
          "call_latest"
        ),
      ]

      const result = await syncCodexUpdatePlanFromTranscriptSummary(
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
          readFiles: [],
          writtenFiles: [],
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
      expect(result?.snapshots).toBe(1)
      const tasks = await readTasks(sessionId, tasksDir)
      expect(tasks.map((task) => [task.id, task.status, task.subject])).toEqual([
        ["codex-1", "completed", "Read incoming dumps"],
        ["codex-2", "in_progress", "Wire task sync"],
      ])
    } finally {
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
      releaseEnvLockFn()
    }
  })

  it("syncs from transcript_path when the daemon has no transcript summary", async () => {
    await acquireEnvLock()
    const originalHome = process.env.HOME
    const tempHome = join(tmpdir(), `swiz-codex-home-${crypto.randomUUID()}`)
    try {
      process.env.HOME = tempHome
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
      releaseEnvLockFn()
    }
  })
})
