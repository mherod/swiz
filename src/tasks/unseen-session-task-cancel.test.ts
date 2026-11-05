import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  cancelIdleProjectTasks,
  cancelTasksOfUnseenSessions,
} from "./unseen-session-task-cancel.ts"

const HOUR_MS = 60 * 60_000
const NOW_MS = Date.now()
const SEVEN_HOURS_AGO = new Date(NOW_MS - 7 * HOUR_MS).toISOString()
const ONE_HOUR_AGO = new Date(NOW_MS - HOUR_MS).toISOString()

interface FixtureTask {
  id: string
  status: string
  updatedAt?: string
  statusChangedAt?: string
}

function task(id: string, status: string, updatedAt?: string): FixtureTask {
  return {
    id,
    status,
    ...(updatedAt ? { updatedAt, statusChangedAt: updatedAt } : {}),
    // Repository readers expect the full task shape.
    ...{ subject: `Task ${id}`, description: "", blocks: [], blockedBy: [] },
  }
}

async function makeTasksDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "swiz-unseen-session-"))
}

async function seedStore(
  tasksDir: string,
  name: string,
  tasks: FixtureTask[],
  meta: Record<string, unknown> | null = { storeKind: "session", cwd: "/tmp/swiz-project" }
): Promise<string> {
  const dir = join(tasksDir, name)
  await mkdir(dir, { recursive: true })
  for (const t of tasks) await writeFile(join(dir, `${t.id}.json`), JSON.stringify(t))
  if (meta) {
    await writeFile(
      join(dir, ".session-meta.json"),
      JSON.stringify({ openCount: 0, updatedAt: new Date(NOW_MS).toISOString(), ...meta })
    )
  }
  return dir
}

async function statusOf(dir: string, id: string): Promise<string> {
  return (JSON.parse(await readFile(join(dir, `${id}.json`), "utf-8")) as { status: string }).status
}

describe("cancelTasksOfUnseenSessions", () => {
  it("cancels the open tasks of a session unseen for over six hours", async () => {
    const tasksDir = await makeTasksDir()
    const dir = await seedStore(tasksDir, "session-old", [
      task("1", "pending", SEVEN_HOURS_AGO),
      task("2", "in_progress", SEVEN_HOURS_AGO),
      task("3", "completed", SEVEN_HOURS_AGO),
    ])

    const cancelled = await cancelTasksOfUnseenSessions({ tasksDir, nowMs: NOW_MS })

    expect(cancelled.map((c) => c.taskId).sort()).toEqual(["1", "2"])
    expect(await statusOf(dir, "1")).toBe("cancelled")
    expect(await statusOf(dir, "2")).toBe("cancelled")
    expect(await statusOf(dir, "3")).toBe("completed")
    const audit = await readFile(join(dir, ".audit-log.jsonl"), "utf-8").catch(() => "")
    expect(audit).toContain("auto-cancelled")
  })

  it("keeps a session whose external sighting is recent", async () => {
    const tasksDir = await makeTasksDir()
    const dir = await seedStore(tasksDir, "session-live", [task("1", "pending", SEVEN_HOURS_AGO)])
    const seen: Array<[string, string | undefined]> = []

    const cancelled = await cancelTasksOfUnseenSessions({
      tasksDir,
      nowMs: NOW_MS,
      sessionLastSeenMs: (id, cwd) => {
        seen.push([id, cwd])
        return NOW_MS - HOUR_MS
      },
    })

    expect(cancelled).toEqual([])
    expect(await statusOf(dir, "1")).toBe("pending")
    expect(seen).toEqual([["session-live", "/tmp/swiz-project"]])
  })

  it("keeps a session that wrote any task recently, even a completed one", async () => {
    const tasksDir = await makeTasksDir()
    const dir = await seedStore(tasksDir, "session-busy", [
      task("1", "pending", SEVEN_HOURS_AGO),
      task("2", "completed", ONE_HOUR_AGO),
    ])

    expect(await cancelTasksOfUnseenSessions({ tasksDir, nowMs: NOW_MS })).toEqual([])
    expect(await statusOf(dir, "1")).toBe("pending")
  })

  it("keeps a session whose sighting lookup fails", async () => {
    const tasksDir = await makeTasksDir()
    const dir = await seedStore(tasksDir, "session-err", [task("1", "pending", SEVEN_HOURS_AGO)])

    const cancelled = await cancelTasksOfUnseenSessions({
      tasksDir,
      nowMs: NOW_MS,
      sessionLastSeenMs: () => {
        throw new Error("transcript scan failed")
      },
    })

    expect(cancelled).toEqual([])
    expect(await statusOf(dir, "1")).toBe("pending")
  })

  it("dates an unstamped record by its file mtime, so a fresh file is kept", async () => {
    const tasksDir = await makeTasksDir()
    const dir = await seedStore(tasksDir, "session-undated", [task("1", "pending")])
    expect(await cancelTasksOfUnseenSessions({ tasksDir, nowMs: NOW_MS })).toEqual([])
    expect(await statusOf(dir, "1")).toBe("pending")
  })

  it("never treats project-keyed stores as sessions", async () => {
    const tasksDir = await makeTasksDir()
    const legacy = await seedStore(
      tasksDir,
      "-Users-someone-project",
      [task("1", "pending", SEVEN_HOURS_AGO)],
      null
    )
    const explicit = await seedStore(
      tasksDir,
      "project-explicit",
      [task("1", "pending", SEVEN_HOURS_AGO)],
      { storeKind: "project" }
    )
    // Control: the same records in a session store are cancelled.
    const control = await seedStore(tasksDir, "session-control", [
      task("1", "pending", SEVEN_HOURS_AGO),
    ])

    const cancelled = await cancelTasksOfUnseenSessions({ tasksDir, nowMs: NOW_MS })

    expect(cancelled.map((c) => c.storeKey)).toEqual([{ kind: "session", id: "session-control" }])
    expect(await statusOf(legacy, "1")).toBe("pending")
    expect(await statusOf(explicit, "1")).toBe("pending")
    expect(await statusOf(control, "1")).toBe("cancelled")
  })
})

describe("cancelIdleProjectTasks", () => {
  it("cancels only open project tasks untouched for over six hours", async () => {
    const tasksDir = await makeTasksDir()
    const key = "-tmp-swiz-project"
    const dir = await seedStore(
      tasksDir,
      key,
      [
        task("p-1", "pending", SEVEN_HOURS_AGO),
        task("p-2", "in_progress", ONE_HOUR_AGO),
        task("p-3", "completed", SEVEN_HOURS_AGO),
      ],
      { storeKind: "project" }
    )

    const cancelled = await cancelIdleProjectTasks(key, { tasksDir, nowMs: NOW_MS })

    expect(cancelled.map((c) => c.taskId)).toEqual(["p-1"])
    expect(await statusOf(dir, "p-1")).toBe("cancelled")
    expect(await statusOf(dir, "p-2")).toBe("in_progress")
    expect(await statusOf(dir, "p-3")).toBe("completed")
  })
})
