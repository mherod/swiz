import { describe, expect, test } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { TMP_ROOT } from "../../temp-paths.ts"
import { projectKeyFromCwd } from "../../transcript-utils.ts"
import { sessionDataCache } from "./session-data.ts"

const TEST_DIR = join(TMP_ROOT, "swiz-session-data-tests")

async function createSession(name: string, timestamp: string) {
  const path = join(TEST_DIR, `${name}.jsonl`)
  await Bun.write(
    path,
    `${JSON.stringify({
      type: "assistant",
      timestamp,
      message: { content: [{ type: "text", text: name }] },
    })}\n`
  )
  return { path, format: "jsonl" as const }
}

describe("sessionDataCache", () => {
  test("coalesces concurrent reads of the same transcript", async () => {
    await mkdir(TEST_DIR, { recursive: true })
    try {
      const session = await createSession("concurrent-session", "2026-08-26T10:00:00.000Z")
      const results = await Promise.all([
        sessionDataCache.get(session, TEST_DIR),
        sessionDataCache.get(session, TEST_DIR),
        sessionDataCache.get(session, TEST_DIR),
      ])

      expect(results[0]).not.toBeNull()
      expect(results[1]).toBe(results[0])
      expect(results[2]).toBe(results[0])
    } finally {
      sessionDataCache.invalidateAll()
      await rm(TEST_DIR, { recursive: true, force: true })
    }
  })

  test("assigns a stable fallback to malformed message timestamps", async () => {
    await rm(TEST_DIR, { recursive: true, force: true })
    await mkdir(TEST_DIR, { recursive: true })
    const path = join(TEST_DIR, "malformed-timestamp.jsonl")
    await Bun.write(
      path,
      `${JSON.stringify({
        type: "assistant",
        timestamp: "not-a-timestamp",
        message: { content: [{ type: "text", text: "hello" }] },
      })}\n`
    )

    try {
      const result = await sessionDataCache.get({ path, format: "jsonl" })
      const assignedTimestamp = result?.messages[0]?.timestamp

      expect(result).not.toBeNull()
      expect(assignedTimestamp).not.toBe("not-a-timestamp")
      expect(Number.isFinite(Date.parse(assignedTimestamp ?? ""))).toBe(true)
      expect(Number.isFinite(result?.startedAt)).toBe(true)
      expect(Number.isFinite(result?.lastMessageAt)).toBe(true)
    } finally {
      sessionDataCache.invalidateAll()
      await rm(TEST_DIR, { recursive: true, force: true })
    }
  })

  test("stores an explicit project identity for nonstandard session paths", async () => {
    await mkdir(TEST_DIR, { recursive: true })
    const alphaCwd = join(TEST_DIR, "alpha")
    const betaCwd = join(TEST_DIR, "beta")

    try {
      const alpha = await sessionDataCache.get(
        await createSession("alpha-session", "2026-08-26T10:00:00.000Z"),
        alphaCwd
      )
      const beta = await sessionDataCache.get(
        await createSession("beta-session", "2026-08-26T10:01:00.000Z"),
        betaCwd
      )

      expect(alpha?.projectIdentity).toBe(projectKeyFromCwd(alphaCwd))
      expect(beta?.projectIdentity).toBe(projectKeyFromCwd(betaCwd))
      expect(alpha?.projectIdentity).not.toBe(beta?.projectIdentity)
      expect(alpha?.projectIdentity).not.toBe("unknown")
      expect(beta?.projectIdentity).not.toBe("unknown")
    } finally {
      sessionDataCache.invalidateAll()
      await rm(TEST_DIR, { recursive: true, force: true })
    }
  })

  test("invalidates only entries owned by the exact canonical project identity", async () => {
    await mkdir(TEST_DIR, { recursive: true })
    const alphaCwd = join(TEST_DIR, "project")
    const betaCwd = join(TEST_DIR, "project-extra")

    try {
      const alphaSession = await createSession("first-provider", "2026-08-26T10:00:00.000Z")
      const betaSession = await createSession("second-provider", "2026-08-26T10:01:00.000Z")
      const alpha = await sessionDataCache.get(alphaSession, alphaCwd)
      const beta = await sessionDataCache.get(betaSession, betaCwd)

      sessionDataCache.invalidateProject(alphaCwd)

      expect(await sessionDataCache.get(alphaSession, alphaCwd)).not.toBe(alpha)
      expect(await sessionDataCache.get(betaSession, betaCwd)).toBe(beta)
    } finally {
      sessionDataCache.invalidateAll()
      await rm(TEST_DIR, { recursive: true, force: true })
    }
  })

  test("prunes each explicitly owned project independently", async () => {
    await mkdir(TEST_DIR, { recursive: true })
    const alphaCwd = join(TEST_DIR, "alpha")
    const betaCwd = join(TEST_DIR, "beta")

    try {
      const alphaOlder = await createSession("alpha-older", "2026-08-26T10:00:00.000Z")
      const alphaNewer = await createSession("alpha-newer", "2026-08-26T10:01:00.000Z")
      const betaOnly = await createSession("beta-only", "2026-08-26T10:02:00.000Z")
      const older = await sessionDataCache.get(alphaOlder, alphaCwd)
      const newer = await sessionDataCache.get(alphaNewer, alphaCwd)
      const beta = await sessionDataCache.get(betaOnly, betaCwd)

      sessionDataCache.pruneSessionsPerProject(1)

      expect(await sessionDataCache.get(alphaNewer, alphaCwd)).toBe(newer)
      expect(await sessionDataCache.get(betaOnly, betaCwd)).toBe(beta)
      expect(await sessionDataCache.get(alphaOlder, alphaCwd)).not.toBe(older)
    } finally {
      sessionDataCache.invalidateAll()
      await rm(TEST_DIR, { recursive: true, force: true })
    }
  })
})

// ─── getProjectTasks cache tests ────────────────────────────────────────────

import { writeFile } from "node:fs/promises"
import type { SessionTask } from "../../tasks/task-recovery.ts"
import { TaskStateCache } from "../../tasks/task-state-cache.ts"
import { makeSessionTask, useTempDir } from "../../utils/test-utils.ts"
import { getProjectTasks } from "./session-data.ts"

const tmp = useTempDir("swiz-get-project-tasks-")
const makeTask = makeSessionTask

async function createProjectSession(
  tasksDir: string,
  sessionId: string,
  cwd: string,
  tasks: SessionTask[]
): Promise<string> {
  const sessionDir = join(tasksDir, sessionId)
  await mkdir(sessionDir, { recursive: true })
  // Write .session-meta.json so getSessions(cwd) matches this session by cwd
  const incomplete = tasks.filter((t) => t.status !== "completed" && t.status !== "cancelled")
  await writeFile(
    join(sessionDir, ".session-meta.json"),
    JSON.stringify({
      openCount: incomplete.length,
      updatedAt: new Date().toISOString(),
      cwd,
    })
  )
  for (const task of tasks) {
    await writeFile(join(sessionDir, `${task.id}.json`), JSON.stringify(task))
  }
  return sessionDir
}

describe("getProjectTasks", () => {
  test("returns correct tasks without a cache (backward-compatible)", async () => {
    const base = await tmp.create()
    const tasksDir = join(base, "tasks")
    const cwd = join(base, "project")
    const sessionId = "test-proj-task-session-001"

    await createProjectSession(tasksDir, sessionId, cwd, [
      makeTask("1", "in_progress", "Alpha task"),
      makeTask("2", "pending", "Beta task"),
    ])

    const { tasks, summary } = await getProjectTasks(cwd, 100, undefined, tasksDir, base)
    expect(tasks.some((t) => t.subject === "Alpha task")).toBe(true)
    expect(tasks.some((t) => t.subject === "Beta task")).toBe(true)
    expect(summary.open).toBe(2)
  })

  test("repeated polls reuse cached snapshot — no new disk reads for unchanged sessions", async () => {
    const base = await tmp.create()
    const tasksDir = join(base, "tasks")
    const cwd = join(base, "project")
    const sessionId = "test-proj-task-session-002"
    const sessionDir = join(tasksDir, sessionId)

    await createProjectSession(tasksDir, sessionId, cwd, [
      makeTask("1", "in_progress", "Cached task"),
    ])

    const cache = new TaskStateCache({ maxEntries: 20 })
    try {
      // First poll — cold load
      const first = await getProjectTasks(cwd, 100, cache, tasksDir, base)
      expect(first.tasks.some((t) => t.subject === "Cached task")).toBe(true)
      expect(cache.trackedCount).toBeGreaterThanOrEqual(1)

      const state1 = await cache.getState(sessionId, sessionDir)

      // Second poll — unchanged session: cache snapshot must be reused (no disk reload)
      const second = await getProjectTasks(cwd, 100, cache, tasksDir, base)
      expect(second.tasks.some((t) => t.subject === "Cached task")).toBe(true)

      const state2 = await cache.getState(sessionId, sessionDir)
      expect(state1).toBe(state2)
      expect(state1.syncedAtMs).toBe(state2.syncedAtMs)
    } finally {
      cache.close()
    }
  })

  test("invalidation causes re-read on next poll", async () => {
    const base = await tmp.create()
    const tasksDir = join(base, "tasks")
    const cwd = join(base, "project")
    const sessionId = "test-proj-task-session-003"
    const sessionDir = join(tasksDir, sessionId)

    await createProjectSession(tasksDir, sessionId, cwd, [
      makeTask("1", "in_progress", "Original task"),
    ])

    const cache = new TaskStateCache({ maxEntries: 20 })
    try {
      // Cold load
      const first = await getProjectTasks(cwd, 100, cache, tasksDir, base)
      expect(first.tasks).toHaveLength(1)

      const stateBefore = await cache.getState(sessionId, sessionDir)

      // Write a new task and invalidate
      await writeFile(
        join(tasksDir, sessionId, "2.json"),
        JSON.stringify(makeTask("2", "pending", "Added after invalidation"))
      )
      cache.invalidate(sessionId)

      // Next poll should reload from disk
      const second = await getProjectTasks(cwd, 100, cache, tasksDir, base)
      expect(second.tasks.some((t) => t.subject === "Added after invalidation")).toBe(true)
      expect(second.tasks).toHaveLength(2)

      const stateAfter = await cache.getState(sessionId, sessionDir)
      expect(stateAfter).not.toBe(stateBefore)
    } finally {
      cache.close()
    }
  })

  test("project isolation — different cwds never share cached snapshots", async () => {
    const base = await tmp.create()
    const tasksDir = join(base, "tasks")
    const cwdAlpha = join(base, "project-alpha")
    const cwdBeta = join(base, "project-beta")

    await createProjectSession(tasksDir, "test-proj-task-session-004", cwdAlpha, [
      makeTask("1", "in_progress", "Alpha task"),
    ])
    await createProjectSession(tasksDir, "test-proj-task-session-005", cwdBeta, [
      makeTask("1", "completed", "Beta task"),
    ])

    const cache = new TaskStateCache({ maxEntries: 20 })
    try {
      const alpha = await getProjectTasks(cwdAlpha, 100, cache, tasksDir, base)
      const beta = await getProjectTasks(cwdBeta, 100, cache, tasksDir, base)

      expect(alpha.tasks.every((t) => t.subject === "Alpha task")).toBe(true)
      expect(beta.tasks.every((t) => t.subject === "Beta task")).toBe(true)
      expect(alpha.tasks.some((t) => t.subject === "Beta task")).toBe(false)
      expect(beta.tasks.some((t) => t.subject === "Alpha task")).toBe(false)
    } finally {
      cache.close()
    }
  })
})
