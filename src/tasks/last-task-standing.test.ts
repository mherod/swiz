/**
 * Completing the final open task must be allowed.
 *
 * It used to throw `Completing task #X would leave zero incomplete tasks`, which combined with
 * `pretooluse-require-tasks` into a ratchet: an open task is needed before Bash/Edit/Write, and
 * the last one could not be closed, so the only exit was to invent a successor. Agents did — one
 * session logged 8 such rejections — so the rule produced the fabricated state it existed to
 * prevent. Fixes #834.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readTasks, type Task } from "./task-repository.ts"
import { completingEmptiesQueue, updateStatus } from "./task-service.ts"

const homes: string[] = []

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

function task(id: string, status: Task["status"], subject: string): Task {
  return { id, subject, description: subject, status, blocks: [], blockedBy: [] }
}

/** Temp HOME with a session store holding exactly the given tasks. */
async function seed(sessionId: string, tasks: Task[]): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "swiz-last-task-"))
  homes.push(home)
  const dir = join(home, ".claude", "tasks", sessionId)
  mkdirSync(dir, { recursive: true })
  for (const t of tasks) await writeFile(join(dir, `${t.id}.json`), JSON.stringify(t, null, 2))
  return home
}

describe("completingEmptiesQueue", () => {
  test("true when no other task is still open", () => {
    const tasks = [task("1", "in_progress", "only"), task("2", "completed", "done")]
    expect(completingEmptiesQueue("1", tasks)).toBe(true)
  })

  test("control: false while another task is still open", () => {
    const tasks = [task("1", "in_progress", "one"), task("2", "pending", "two")]
    expect(completingEmptiesQueue("1", tasks)).toBe(false)
  })
})

describe("updateStatus on the final open task", () => {
  test("completes it instead of rejecting, and the queue really does empty", async () => {
    const sessionId = "last-task-allowed"
    const originalHome = process.env.HOME
    process.env.HOME = await seed(sessionId, [task("1", "in_progress", "the only task")])
    try {
      // Before #834 this threw "would leave zero incomplete tasks".
      await updateStatus(sessionId, "1", "completed", { evidence: "note:done" })
      const after = await readTasks(sessionId)
      expect(after.find((t) => t.id === "1")?.status).toBe("completed")
      expect(after.filter((t) => t.status === "pending" || t.status === "in_progress")).toEqual([])
    } finally {
      process.env.HOME = originalHome
    }
  })

  test("control: completing a non-final task still works, so the case above is not special", async () => {
    const sessionId = "non-final-task"
    const originalHome = process.env.HOME
    process.env.HOME = await seed(sessionId, [
      task("1", "in_progress", "first"),
      task("2", "pending", "second"),
    ])
    try {
      await updateStatus(sessionId, "1", "completed", { evidence: "note:done" })
      const after = await readTasks(sessionId)
      expect(after.find((t) => t.id === "1")?.status).toBe("completed")
      expect(after.find((t) => t.id === "2")?.status).toBe("pending")
    } finally {
      process.env.HOME = originalHome
    }
  })
})
