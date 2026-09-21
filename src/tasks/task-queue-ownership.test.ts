import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  evaluatePretooluseEnforceTaskupdate,
  evaluateTaskCreatePath,
} from "../../hooks/pretooluse-task-governance.ts"
import { detectCurrentAgent } from "../agent-paths.ts"
import { readMcpTaskQueue, runMcpTool } from "../mcp-tool-core.ts"
import { projectKeyFromCwd } from "../project-key.ts"
import { createTaskStoreForProvider } from "../task-roots.ts"
import { acquireEnvLock, releaseEnvLockFn } from "../utils/test-utils.ts"
import { applyTaskListEvent, overlayEventState, pruneSession } from "./task-event-state.ts"
import { projectQueueTasks } from "./task-queue-view.ts"
import {
  projectStoreKey,
  readTaskRecordsAcrossStores,
  readTaskStore,
  sessionDirPath,
  sessionStoreKey,
  type Task,
  type TaskStoreKey,
  writeTask,
} from "./task-repository.ts"
import { ensureFileBackedTask, updateStatus, writeTaskUpdate } from "./task-service.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(forMcp = false) {
  const home = await mkdtemp(join(tmpdir(), "swiz-931-"))
  roots.push(home)
  const cwd = join(home, "project")
  const tasksDir = forMcp
    ? createTaskStoreForProvider(detectCurrentAgent()?.id ?? "claude", home).tasksDir
    : join(home, ".claude", "tasks")
  const project = projectStoreKey(cwd)
  const context = { filterCwd: cwd, tasksDir }
  async function seed(key: TaskStoreKey, id: string, status: Task["status"], owner?: string) {
    const task: Task = {
      id,
      status,
      subject: `Work ${key.kind === "session" ? key.id : "project"} ${id}`,
      description: "private task details",
      blocks: [],
      blockedBy: [],
    }
    await writeTask(key, task, owner, tasksDir)
    return task
  }
  return { home, cwd, tasksDir, project, context, seed }
}

test("WIP excludes foreign and unattributed history exactly like TaskList", async () => {
  const f = await fixture()
  await f.seed(f.project, "next", "pending", f.cwd)
  for (let i = 0; i < 4; i++) {
    await f.seed(sessionStoreKey(`unknown-${i}`), `${i}`, "in_progress")
    await f.seed(sessionStoreKey(`foreign-${i}`), `${i}`, "in_progress", join(f.home, "foreign"))
  }
  expect(await readMcpTaskQueue(projectKeyFromCwd(f.cwd), f.tasksDir)).toHaveLength(1)
  await updateStatus(f.project, "next", "in_progress", f.context)
  expect((await readTaskStore(f.project, f.tasksDir))[0]?.status).toBe("in_progress")
})

test("distinct owners with the same bare ID all occupy capacity", async () => {
  const f = await fixture()
  for (let i = 0; i < 4; i++) await f.seed(sessionStoreKey(`owner-${i}`), "1", "in_progress", f.cwd)
  await f.seed(f.project, "1", "pending", f.cwd)
  const records = await readMcpTaskQueue(projectKeyFromCwd(f.cwd), f.tasksDir)
  expect(records).toHaveLength(5)
  await expect(updateStatus(f.project, "1", "in_progress", f.context)).rejects.toThrow(
    "already has 4"
  )
})

test("stale zero metadata cannot hide blockers and diagnostics preserve ownership", async () => {
  const f = await fixture()
  const key = sessionStoreKey("owned-session")
  for (let i = 0; i < 4; i++) await f.seed(key, `${i}`, "in_progress", f.cwd)
  await Bun.write(
    join(sessionDirPath(key, f.tasksDir), ".session-meta.json"),
    JSON.stringify({ cwd: f.cwd, storeKind: "session", openCount: 0 })
  )
  const pending = await f.seed(f.project, "next", "pending", f.cwd)
  await expect(
    writeTaskUpdate(f.project, "next", pending, "in_progress", f.context)
  ).rejects.toThrow("owned-session")
  expect(
    (await readMcpTaskQueue(projectKeyFromCwd(f.cwd), f.tasksDir)).filter(
      (r) => r.task.status === "in_progress"
    )
  ).toHaveLength(4)
})

test("concurrent project sessions cannot both take the last available slot", async () => {
  const f = await fixture()
  for (let i = 0; i < 3; i++) await f.seed(f.project, `active-${i}`, "in_progress", f.cwd)
  const a = sessionStoreKey("session-a")
  const b = sessionStoreKey("session-b")
  await f.seed(a, "a-next", "pending", f.cwd)
  await f.seed(b, "b-next", "pending", f.cwd)
  const results = await Promise.allSettled([
    updateStatus(a, "a-next", "in_progress", f.context),
    updateStatus(b, "b-next", "in_progress", f.context),
  ])
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
  expect(
    (await readMcpTaskQueue(projectKeyFromCwd(f.cwd), f.tasksDir)).filter(
      (r) => r.task.status === "in_progress"
    )
  ).toHaveLength(4)
})

test("native current-session exception is explicit in recency diagnostics", async () => {
  const f = await fixture()
  const key = sessionStoreKey("current-session")
  const task = await f.seed(key, "1", "in_progress")
  task.updatedAt = new Date(Date.now() - 15 * 60_000).toISOString()
  await Bun.write(join(sessionDirPath(key, f.tasksDir), "1.json"), JSON.stringify(task))
  expect(await readMcpTaskQueue(projectKeyFromCwd(f.cwd), f.tasksDir)).toHaveLength(0)
  expect(
    await readTaskRecordsAcrossStores("current-session", projectKeyFromCwd(f.cwd), f.tasksDir)
  ).toHaveLength(1)
  const outcome = await evaluateTaskCreatePath(
    {
      cwd: f.cwd,
      session_id: "current-session",
      _taskHome: f.home,
      _env: { CLAUDECODE: "1" },
      tool_name: "TaskCreate",
    },
    { subject: "Inspect results" }
  )
  const text = JSON.stringify(outcome)
  expect(text).toContain("current-session")
  expect(text).toContain("explicit current session")
  expect(text).not.toContain("private task details")
})

test("MCP preserves colliding owners and accepts the displayed full taskId", async () => {
  const f = await fixture(true)
  await acquireEnvLock()
  const originalHome = process.env.HOME
  try {
    process.env.HOME = f.home
    for (let i = 0; i < 4; i++)
      await f.seed(sessionStoreKey(`owner-${i}`), "1", "in_progress", f.cwd)
    const list = JSON.stringify(await runMcpTool("TaskList", {}, f.cwd))
    expect(list).toContain("4 in progress")
    for (let i = 0; i < 4; i++) expect(list).toContain(`session:owner-${i}#1`)
    const rejected = await runMcpTool("TaskUpdate", { taskId: "1", status: "completed" }, f.cwd)
    expect(rejected.isError).toBe(true)
    expect(JSON.stringify(rejected)).toContain("ambiguous")
    const updated = await runMcpTool(
      "TaskUpdate",
      { taskId: "session:owner-0#1", status: "completed", description: "note:verified" },
      f.cwd
    )
    expect(updated.isError).toBeUndefined()
    expect((await readTaskStore(sessionStoreKey("owner-0"), f.tasksDir))[0]?.status).toBe(
      "completed"
    )
    for (let i = 1; i < 4; i++)
      expect((await readTaskStore(sessionStoreKey(`owner-${i}`), f.tasksDir))[0]?.status).toBe(
        "in_progress"
      )
  } finally {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    releaseEnvLockFn()
  }
})

test("a rejected MCP start cannot partially persist its field changes", async () => {
  const f = await fixture(true)
  await acquireEnvLock()
  const originalHome = process.env.HOME
  try {
    process.env.HOME = f.home
    for (let i = 0; i < 4; i++) await f.seed(f.project, `active-${i}`, "in_progress", f.cwd)
    await f.seed(f.project, "next", "pending", f.cwd)
    const path = join(sessionDirPath(f.project, f.tasksDir), "next.json")
    const before = await Bun.file(path).text()
    const result = await runMcpTool(
      "TaskUpdate",
      {
        taskId: "next",
        status: "in_progress",
        description: "must not persist",
        subject: "Changed subject",
      },
      f.cwd
    )
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain("already has 4")
    expect(await Bun.file(path).text()).toBe(before)
    await expect(
      ensureFileBackedTask({
        sessionId: f.project.key,
        taskId: "missing-stub",
        filterCwd: f.cwd,
        subject: "Inspect output",
        status: "in_progress",
      })
    ).rejects.toThrow("already has 4")
    expect(
      await Bun.file(join(sessionDirPath(f.project, f.tasksDir), "missing-stub.json")).exists()
    ).toBe(false)
  } finally {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    releaseEnvLockFn()
  }
})

test("explicit foreign sessions stay excluded and changed ownership metadata is refreshed", async () => {
  const f = await fixture()
  const key = sessionStoreKey("reassigned")
  await f.seed(key, "1", "in_progress", join(f.home, "foreign"))
  expect(await readTaskRecordsAcrossStores("reassigned", f.project.key, f.tasksDir)).toHaveLength(0)
  await Bun.write(
    join(sessionDirPath(key, f.tasksDir), ".session-meta.json"),
    JSON.stringify({
      storeKind: "session",
      cwd: f.cwd,
      openCount: 0,
    })
  )
  expect(await readMcpTaskQueue(f.project.key, f.tasksDir)).toHaveLength(1)
})

test("dependency projections preserve owner-local and explicit references", async () => {
  const f = await fixture()
  const a = sessionStoreKey("a")
  const b = sessionStoreKey("b")
  const first = await f.seed(a, "1", "in_progress", f.cwd)
  const second = await f.seed(b, "1", "in_progress", f.cwd)
  const dependent = await f.seed(a, "2", "pending", f.cwd)
  dependent.blockedBy = ["1"]
  const records = [
    { storeKey: a, task: first },
    { storeKey: b, task: second },
    { storeKey: a, task: dependent },
  ]
  expect(projectQueueTasks(records)[2]?.blockedBy).toEqual(["session:a#1"])
  dependent.blockedBy = ["session:a#1"]
  expect(
    projectQueueTasks(records.filter((record) => record.storeKey !== b))[1]?.blockedBy
  ).toEqual(["1"])
})

test("native WIP uses the same four colliding owners without mistaking one for its pending target", async () => {
  const f = await fixture()
  for (let i = 0; i < 4; i++) await f.seed(sessionStoreKey(`owner-${i}`), "1", "in_progress", f.cwd)
  await f.seed(sessionStoreKey("current-session"), "1", "pending")
  const result = await evaluatePretooluseEnforceTaskupdate({
    cwd: f.cwd,
    session_id: "current-session",
    _taskHome: f.home,
    _env: { CLAUDECODE: "1" },
    tool_name: "TaskUpdate",
    tool_input: { taskId: "1", status: "in_progress" },
  })
  expect(JSON.stringify(result)).toContain("already has 4")
  expect(JSON.stringify(result)).toContain("session:owner-0#1")
})

test("recency excludes foreign history and event overlays cannot change another owner", async () => {
  const f = await fixture()
  const foreign = sessionStoreKey("foreign")
  const stale = await f.seed(foreign, "1", "in_progress", join(f.home, "other-project"))
  stale.updatedAt = new Date(Date.now() - 15 * 60_000).toISOString()
  await Bun.write(join(sessionDirPath(foreign, f.tasksDir), "1.json"), JSON.stringify(stale))
  const result = await evaluateTaskCreatePath(
    { cwd: f.cwd, session_id: "current", _taskHome: f.home },
    { subject: "Inspect results" }
  )
  expect(JSON.stringify(result)).not.toContain("not been updated")
  const owned = await f.seed(sessionStoreKey("colleague"), "1", "in_progress", f.cwd)
  applyTaskListEvent("current", [{ id: "1", subject: "Own work", status: "completed" }])
  try {
    const projection = projectQueueTasks([{ storeKey: sessionStoreKey("colleague"), task: owned }])
    expect(overlayEventState(projection, "current")[0]?.status).toBe("in_progress")
  } finally {
    pruneSession("current")
  }
})
