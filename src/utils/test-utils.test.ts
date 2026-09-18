import { expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { getGlobalTaskStateCache, setGlobalTaskStateCache } from "../tasks/task-recovery.ts"
import { readTaskStoreMeta, sessionStoreKey } from "../tasks/task-repository.ts"
import { TaskStateCache } from "../tasks/task-state-cache.ts"
import {
  acquireEnvLock,
  neutralAgentEnv,
  releaseEnvLockFn,
  useTempDir,
  writeRawTaskFixture,
  writeTask,
} from "./test-utils.ts"

const taskHomes = useTempDir("swiz-task-fixtures-")

test("task fixtures stamp updatedAt on disk without reader backfill", async () => {
  const home = await taskHomes.create()
  const task = { id: "1", subject: "Check writer timestamps", status: "pending" as const }
  const before = Date.now()
  await writeTask(home, "fixture-timestamps", task)
  const after = Date.now()
  const record = await Bun.file(
    join(home, ".claude", "tasks", "fixture-timestamps", "1.json")
  ).json()

  expect(record.updatedAt).toBeString()
  expect(Date.parse(record.updatedAt)).toBeGreaterThanOrEqual(before)
  expect(Date.parse(record.updatedAt)).toBeLessThanOrEqual(after)
  expect(record).toMatchObject({ ...task, description: "", blocks: [], blockedBy: [] })
  expect(task).not.toHaveProperty("updatedAt")
})

test("task fixtures refresh metadata and invalidate cached counts on every write", async () => {
  const home = await taskHomes.create()
  const root = join(home, ".claude", "tasks")
  const session = "fixture-metadata"
  const key = sessionStoreKey(session)
  expect(await readTaskStoreMeta(key, root)).toBeNull()

  await writeTask(home, session, { id: "1", subject: "Count task", status: "pending" })
  const initial = await Bun.file(join(root, session, ".session-meta.json")).json()
  expect(initial).toMatchObject({ storeKind: "session", openCount: 1 })
  expect(await readTaskStoreMeta(key, root)).toEqual(initial)

  await writeTask(home, session, {
    id: "1",
    subject: "Count task",
    status: "completed",
    updatedAt: "2000-01-01T00:00:00.000Z",
    statusChangedAt: "2001-01-01T00:00:00.000Z",
    description: "Preserve supplied details",
    blocks: ["2"],
  })
  const record = await Bun.file(join(root, session, "1.json")).json()
  expect(record.updatedAt).not.toBe("2000-01-01T00:00:00.000Z")
  expect(record).toMatchObject({
    description: "Preserve supplied details",
    blocks: ["2"],
    statusChangedAt: "2001-01-01T00:00:00.000Z",
  })
  expect(await readTaskStoreMeta(key, root)).toMatchObject({ storeKind: "session", openCount: 0 })
})

test("task fixtures write through to a warm task-state cache", async () => {
  const home = await taskHomes.create()
  const session = "fixture-write-through"
  const dir = join(home, ".claude", "tasks", session)
  const cache = new TaskStateCache()
  cache.applyTaskListSnapshot(session, [{ id: "1", subject: "Cached task", status: "pending" }])
  await acquireEnvLock()
  const previous = getGlobalTaskStateCache()
  try {
    setGlobalTaskStateCache(cache)
    await writeTask(home, session, { id: "1", subject: "Updated task", status: "in_progress" })
    // No watcher and a warm, fresh cache: a disk fallback cannot hide missing write-through.
    const state = await cache.getState(session, dir)
    expect(state.inProgressCount).toBe(1)
    expect(state.tasks).toMatchObject([{ subject: "Updated task", updatedAt: expect.any(String) }])
  } finally {
    setGlobalTaskStateCache(previous)
    cache.close()
    releaseEnvLockFn()
  }
})

test("raw task fixtures preserve malformed, legacy, and historical records verbatim", async () => {
  const home = await taskHomes.create()
  const session = "fixture-raw"
  const fixtures = [
    { id: "legacy", subject: "Old task", status: "pending" },
    { id: "malformed", status: 42 },
    {
      id: "historical",
      subject: "Stale task",
      status: "pending",
      updatedAt: "2000-01-01T00:00:00.000Z",
    },
  ]
  for (const task of fixtures) {
    await writeRawTaskFixture(home, session, task)
    expect(
      await Bun.file(join(home, ".claude", "tasks", session, `${task.id}.json`)).json()
    ).toEqual(task)
  }
  expect(
    await Bun.file(join(home, ".claude", "tasks", session, ".session-meta.json")).exists()
  ).toBe(false)
})

test("task fixtures use the explicit test home even with an ambient Codex home", async () => {
  const home = await taskHomes.create()
  const ambient = await taskHomes.create()
  await acquireEnvLock()
  const originalHome = process.env.HOME
  const originalThread = process.env.CODEX_THREAD_ID
  try {
    process.env.HOME = ambient
    process.env.CODEX_THREAD_ID = "fixture-isolation"
    await writeTask(home, "fixture-isolation", {
      id: "1",
      subject: "Isolated task",
      status: "pending",
    })
    expect(
      await Bun.file(join(home, ".claude", "tasks", "fixture-isolation", "1.json")).exists()
    ).toBe(true)
    expect(await readdir(ambient)).toEqual([])
    expect(
      await writeTask("", "fixture-isolation", {
        id: "2",
        subject: "Missing home",
        status: "pending",
      }).catch((error: Error) => error.message)
    ).toContain("test home")
  } finally {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalThread === undefined) delete process.env.CODEX_THREAD_ID
    else process.env.CODEX_THREAD_ID = originalThread
    releaseEnvLockFn()
  }
})

test("missing HOME subprocesses disable Bun's relative transpiler cache", () => {
  const env = neutralAgentEnv({ HOME: undefined })

  expect(env.HOME).toBe("")
  expect(env.BUN_RUNTIME_TRANSPILER_CACHE_PATH).toBe("0")
})

test("environment lock releases queued callers in acquisition order", async () => {
  const order: string[] = []
  let markFirstAcquired!: () => void
  const firstAcquired = new Promise<void>((resolve) => {
    markFirstAcquired = resolve
  })
  let allowFirstToRelease!: () => void
  const firstReleaseGate = new Promise<void>((resolve) => {
    allowFirstToRelease = resolve
  })

  const first = (async () => {
    await acquireEnvLock()
    order.push("first")
    markFirstAcquired()
    await firstReleaseGate
    releaseEnvLockFn()
  })()

  await firstAcquired

  const second = (async () => {
    await acquireEnvLock()
    order.push("second")
    releaseEnvLockFn()
  })()

  expect(order).toEqual(["first"])
  allowFirstToRelease()
  await Promise.all([first, second])
  expect(order).toEqual(["first", "second"])
})
