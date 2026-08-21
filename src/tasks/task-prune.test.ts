import { describe, expect, it } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pruneStaleCompletedTasks } from "./task-prune.ts"

interface FixtureTask {
  id: string
  status: string
  completedAt?: number | null
}

async function makeStoreDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "swiz-task-prune-"))
}

async function writeTaskFile(dir: string, task: FixtureTask): Promise<void> {
  await writeFile(join(dir, `${task.id}.json`), JSON.stringify(task))
}

function fileExists(dir: string, id: string): Promise<boolean> {
  return Bun.file(join(dir, `${id}.json`)).exists()
}

describe("pruneStaleCompletedTasks", () => {
  it("deletes completed files older than the retention age and returns survivors", async () => {
    const dir = await makeStoreDir()
    const maxAgeMs = 1_000
    const tasks: FixtureTask[] = [
      { id: "1", status: "completed", completedAt: Date.now() - 5_000 },
      { id: "2", status: "completed", completedAt: Date.now() },
      { id: "3", status: "pending" },
      { id: "4", status: "in_progress" },
      { id: "5", status: "cancelled" },
    ]
    for (const task of tasks) await writeTaskFile(dir, task)

    const surviving = await pruneStaleCompletedTasks(dir, tasks, maxAgeMs)

    expect(surviving.map((t) => t.id)).toEqual(["2", "3", "4", "5"])
    expect(await fileExists(dir, "1")).toBe(false)
    for (const id of ["2", "3", "4", "5"]) {
      expect(await fileExists(dir, id)).toBe(true)
    }
  })

  it("keeps completed tasks with no usable completedAt", async () => {
    const dir = await makeStoreDir()
    const tasks: FixtureTask[] = [
      { id: "1", status: "completed" },
      { id: "2", status: "completed", completedAt: null },
    ]
    for (const task of tasks) await writeTaskFile(dir, task)

    const surviving = await pruneStaleCompletedTasks(dir, tasks, 0)

    expect(surviving.map((t) => t.id)).toEqual(["1", "2"])
    expect(await fileExists(dir, "1")).toBe(true)
    expect(await fileExists(dir, "2")).toBe(true)
  })

  it("drops a stale completed task from the result even when its file is already gone", async () => {
    const dir = await makeStoreDir()
    const tasks: FixtureTask[] = [{ id: "1", status: "completed", completedAt: Date.now() - 5_000 }]

    const surviving = await pruneStaleCompletedTasks(dir, tasks, 1_000)

    expect(surviving).toEqual([])
  })
})
