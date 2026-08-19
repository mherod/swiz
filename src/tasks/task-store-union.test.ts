import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readSessionTasks, readSessionTasksUnioned } from "./task-recovery.ts"
import { readTasks, readTasksAcrossStores, type Task } from "./task-repository.ts"

// The MCP server keys the task store by projectKeyFromCwd(cwd); native tools key it by the agent
// session UUID. Governance reads the session key, so an MCP-only session presents an empty queue.
// These cases lock in the union that closes that gap (#823).

const TASKS_DIR = join(tmpdir(), `swiz-store-union-${process.pid}`)
const SESSION_ID = "00000000-0000-0000-0000-0000000000aa"
const PROJECT_KEY = "-Users-someone-Development-demo"

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    subject: `subject ${id}`,
    description: `description ${id}`,
    status: "pending",
    blocks: [],
    blockedBy: [],
    ...overrides,
  }
}

async function writeTaskFile(storeKey: string, value: Task): Promise<void> {
  const dir = join(TASKS_DIR, storeKey)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${value.id}.json`), JSON.stringify(value))
}

/** Same fixture, rooted at a temp HOME, for readers that resolve `<home>/.claude/tasks`. */
async function writeHomeTask(home: string, storeKey: string, value: Task): Promise<void> {
  const dir = join(home, ".claude", "tasks", storeKey)
  await mkdir(dir, { recursive: true })
  await Bun.write(join(dir, `${value.id}.json`), JSON.stringify(value))
}

beforeAll(async () => {
  await mkdir(TASKS_DIR, { recursive: true })
  // Session-keyed store: one task only it has.
  await writeTaskFile(SESSION_ID, task("7ed7-1"))
  // Project-keyed store (the MCP surface): one task only it has.
  await writeTaskFile(PROJECT_KEY, task("user-1"))
  // Present in both, with the project-keyed copy strictly newer.
  await writeTaskFile(
    SESSION_ID,
    task("shared-1", { status: "pending", statusChangedAt: "2026-01-01T00:00:00.000Z" })
  )
  await writeTaskFile(
    PROJECT_KEY,
    task("shared-1", { status: "completed", statusChangedAt: "2026-06-01T00:00:00.000Z" })
  )
})

afterAll(async () => {
  await rm(TASKS_DIR, { recursive: true, force: true })
})

describe("readTasksAcrossStores", () => {
  test("session-keyed read alone cannot see project-keyed tasks (control)", async () => {
    // Without this control the union cases below could pass for the wrong reason.
    const ids = (await readTasks(SESSION_ID, TASKS_DIR)).map((t) => t.id)
    expect(ids).not.toContain("user-1")
  })

  test("returns tasks from both stores", async () => {
    const ids = (await readTasksAcrossStores(SESSION_ID, PROJECT_KEY, TASKS_DIR)).map((t) => t.id)
    expect(ids).toContain("7ed7-1")
    expect(ids).toContain("user-1")
  })

  test("counts a task present in both stores exactly once", async () => {
    const shared = (await readTasksAcrossStores(SESSION_ID, PROJECT_KEY, TASKS_DIR)).filter(
      (t) => t.id === "shared-1"
    )
    expect(shared).toHaveLength(1)
  })

  test("prefers the most recently changed copy of a duplicated task", async () => {
    const shared = (await readTasksAcrossStores(SESSION_ID, PROJECT_KEY, TASKS_DIR)).find(
      (t) => t.id === "shared-1"
    )
    expect(shared?.status).toBe("completed")
  })

  test("is unchanged from a plain read when no project key is given", async () => {
    const union = await readTasksAcrossStores(SESSION_ID, undefined, TASKS_DIR)
    const plain = await readTasks(SESSION_ID, TASKS_DIR)
    expect(union.map((t) => t.id).sort()).toEqual(plain.map((t) => t.id).sort())
  })

  test("does not double-read when both keys are identical", async () => {
    const union = await readTasksAcrossStores(SESSION_ID, SESSION_ID, TASKS_DIR)
    const plain = await readTasks(SESSION_ID, TASKS_DIR)
    expect(union).toHaveLength(plain.length)
  })

  test("returns the project store's tasks when the session store is empty", async () => {
    const ids = (await readTasksAcrossStores("no-such-session", PROJECT_KEY, TASKS_DIR)).map(
      (t) => t.id
    )
    expect(ids).toContain("user-1")
  })
})

// The same union, for the hook-facing reader that stop gates gate on. It takes a `home` and derives
// <home>/.claude/tasks/<key>, so it needs its own fixture rather than the TASKS_DIR above.
describe("readSessionTasksUnioned", () => {
  const HOME = join(tmpdir(), `swiz-session-union-${process.pid}`)
  const CWD = "/Users/someone/Development/demo"
  // projectKeyFromCwd replaces / . \ : with -
  const CWD_PROJECT_KEY = "-Users-someone-Development-demo"

  beforeAll(async () => {
    await writeHomeTask(HOME, SESSION_ID, task("7ed7-1", { status: "in_progress" }))
    await writeHomeTask(HOME, CWD_PROJECT_KEY, task("349d-1", { status: "pending" }))
    await writeHomeTask(
      HOME,
      SESSION_ID,
      task("dup-1", { status: "pending", statusChangedAt: "2026-01-01T00:00:00.000Z" })
    )
    await writeHomeTask(
      HOME,
      CWD_PROJECT_KEY,
      task("dup-1", { status: "completed", statusChangedAt: "2026-06-01T00:00:00.000Z" })
    )
  })

  afterAll(async () => {
    await rm(HOME, { recursive: true, force: true })
  })

  test("a session-only read cannot see the project store (control)", async () => {
    // Without this control the union cases below could pass for the wrong reason.
    const ids = (await readSessionTasks(SESSION_ID, HOME)).map((t) => t.id)
    expect(ids).not.toContain("349d-1")
  })

  test("unions the project-keyed store derived from cwd", async () => {
    const ids = (await readSessionTasksUnioned(SESSION_ID, CWD, HOME)).map((t) => t.id)
    expect(ids).toContain("7ed7-1")
    expect(ids).toContain("349d-1")
  })

  test("prefers the most recently changed copy of a duplicated task", async () => {
    const tasks = await readSessionTasksUnioned(SESSION_ID, CWD, HOME)
    expect(tasks.filter((t) => t.id === "dup-1")).toHaveLength(1)
    expect(tasks.find((t) => t.id === "dup-1")?.status).toBe("completed")
  })

  test("falls back to the session store when cwd is absent", async () => {
    // The daemon's in-process path has no session cwd; it must not guess one.
    const union = await readSessionTasksUnioned(SESSION_ID, null, HOME)
    const plain = await readSessionTasks(SESSION_ID, HOME)
    expect(union.map((t) => t.id)).toEqual(plain.map((t) => t.id))
  })
})
