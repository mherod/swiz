/**
 * The project-scoped in-progress cap enforced through the real transition path.
 *
 * Unit coverage of the pure predicate lives in task-wip-limit.test.ts; this file
 * proves `updateStatus` actually refuses the fifth concurrent in_progress task
 * and that the surrounding transitions still work.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDefaultTaskStore } from "../task-roots.ts"
import { acquireEnvLock, releaseEnvLockFn } from "../utils/test-utils.ts"
import { readAuditLog } from "./task-audit-verification.ts"
import { readTasks, type Task } from "./task-repository.ts"
import { completeTaskWithAutoTransition, updateStatus } from "./task-service.ts"
import { MAX_IN_PROGRESS_TASKS_PER_PROJECT } from "./task-wip-limit.ts"

const homes: string[] = []

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

function task(id: string, status: Task["status"], subject: string): Task {
  return { id, subject, description: subject, status, blocks: [], blockedBy: [] }
}

/** Seed one temp HOME with any number of session stores. */
async function seedSessions(sessions: Record<string, Task[]>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "swiz-wip-limit-"))
  homes.push(home)
  process.env.HOME = home
  for (const [sessionId, tasks] of Object.entries(sessions)) {
    const dir = join(createDefaultTaskStore().tasksDir, sessionId)
    mkdirSync(dir, { recursive: true })
    for (const t of tasks) await Bun.write(join(dir, `${t.id}.json`), JSON.stringify(t, null, 2))
  }
}

/** Run `body` against a temp HOME, restoring the environment afterwards. */
async function withSeededSessions(
  sessions: Record<string, Task[]>,
  body: () => Promise<void>
): Promise<void> {
  await acquireEnvLock()
  const originalHome = process.env.HOME
  try {
    await seedSessions(sessions)
    await body()
  } finally {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    releaseEnvLockFn()
  }
}

/** Single-session convenience wrapper over `withSeededSessions`. */
async function withSeededHome(
  sessionId: string,
  tasks: Task[],
  body: () => Promise<void>
): Promise<void> {
  await withSeededSessions({ [sessionId]: tasks }, body)
}

/** N in_progress tasks plus one pending task `next`. */
function atCapacity(inProgressCount: number): Task[] {
  const tasks = Array.from({ length: inProgressCount }, (_, i) =>
    task(`w${i + 1}`, "in_progress", `open work ${i + 1}`)
  )
  tasks.push(task("next", "pending", "the queued work"))
  return tasks
}

describe("updateStatus in-progress cap", () => {
  test(`refuses the transition that would make ${MAX_IN_PROGRESS_TASKS_PER_PROJECT + 1} in_progress`, async () => {
    await withSeededHome("wip-at-cap", atCapacity(MAX_IN_PROGRESS_TASKS_PER_PROJECT), async () => {
      await expect(
        updateStatus("wip-at-cap", "next", "in_progress", { filterCwd: process.cwd() })
      ).rejects.toThrow(/already has \d+ in_progress tasks/)

      const after = await readTasks("wip-at-cap")
      expect(after.find((t) => t.id === "next")?.status).toBe("pending")
    })
  })

  test("ignores in-progress tasks held by stores outside this project", async () => {
    // A store with no transcript and no cwd metadata is admitted by the
    // resolver's unattributable-session fallback, so it landed in every
    // project's cwd-scoped scan. The cap then counted unrelated repositories:
    // a session with nothing of its own in progress was refused because four
    // foreign tasks filled the limit, while TaskList correctly showed zero.
    const sessions: Record<string, Task[]> = {}
    for (let i = 1; i <= MAX_IN_PROGRESS_TASKS_PER_PROJECT; i++) {
      sessions[`wip-foreign-${i}`] = [task("1", "in_progress", `another project's work ${i}`)]
    }
    sessions["wip-local"] = [task("next", "pending", "the queued work")]

    await withSeededSessions(sessions, async () => {
      await updateStatus("wip-local", "next", "in_progress", { filterCwd: process.cwd() })

      const after = await readTasks("wip-local")
      expect(after.find((t) => t.id === "next")?.status).toBe("in_progress")
    })
  })

  test("control: one below the cap the same transition succeeds", async () => {
    await withSeededHome(
      "wip-below-cap",
      atCapacity(MAX_IN_PROGRESS_TASKS_PER_PROJECT - 1),
      async () => {
        await updateStatus("wip-below-cap", "next", "in_progress", { filterCwd: process.cwd() })
        const after = await readTasks("wip-below-cap")
        expect(after.find((t) => t.id === "next")?.status).toBe("in_progress")
      }
    )
  })

  test("completing at the cap is unaffected", async () => {
    await withSeededHome(
      "wip-complete-at-cap",
      atCapacity(MAX_IN_PROGRESS_TASKS_PER_PROJECT),
      async () => {
        await updateStatus("wip-complete-at-cap", "w1", "completed", {
          filterCwd: process.cwd(),
          evidence: "note:done",
        })
        const after = await readTasks("wip-complete-at-cap")
        expect(after.find((t) => t.id === "w1")?.status).toBe("completed")
      }
    )
  })

  test("cancelling a pending task at the cap is unaffected", async () => {
    await withSeededHome(
      "wip-cancel-at-cap",
      atCapacity(MAX_IN_PROGRESS_TASKS_PER_PROJECT),
      async () => {
        await updateStatus("wip-cancel-at-cap", "next", "cancelled", { filterCwd: process.cwd() })
        const after = await readTasks("wip-cancel-at-cap")
        expect(after.find((t) => t.id === "next")?.status).toBe("cancelled")
      }
    )
  })

  test("the cap frees up once an open task closes", async () => {
    await withSeededHome(
      "wip-frees-up",
      atCapacity(MAX_IN_PROGRESS_TASKS_PER_PROJECT),
      async () => {
        await updateStatus("wip-frees-up", "w1", "completed", {
          filterCwd: process.cwd(),
          evidence: "note:done",
        })
        await updateStatus("wip-frees-up", "next", "in_progress", { filterCwd: process.cwd() })
        const after = await readTasks("wip-frees-up")
        expect(after.find((t) => t.id === "next")?.status).toBe("in_progress")
      }
    )
  })

  test("auto-transition completion of a pending task is not blocked by the cap", async () => {
    await withSeededHome(
      "wip-auto-transition",
      atCapacity(MAX_IN_PROGRESS_TASKS_PER_PROJECT),
      async () => {
        await completeTaskWithAutoTransition("wip-auto-transition", "next", {
          filterCwd: process.cwd(),
          evidence: "note:the work was already done",
        })
        const after = await readTasks("wip-auto-transition")
        const next = after.find((t) => t.id === "next")
        expect(next?.status).toBe("completed")
        // The evidence and both legal edges survive the capacity bypass (#930).
        expect(next?.completionEvidence).toBe("note:the work was already done")
        const edges = (await readAuditLog("wip-auto-transition"))
          .filter((entry) => entry.taskId === "next")
          .map((entry) => `${entry.oldStatus}→${entry.newStatus}`)
        expect(edges).toEqual(["pending→in_progress", "in_progress→completed"])
      }
    )
  })

  // Controls for the bypass above: the capacity exemption is the evidenced, setting-gated hop
  // only. Each refusal leaves the finished work pending — never cancelled.
  test("at the cap, a pending completion without evidence is refused and stays pending", async () => {
    await withSeededHome(
      "wip-no-evidence",
      atCapacity(MAX_IN_PROGRESS_TASKS_PER_PROJECT),
      async () => {
        await expect(
          completeTaskWithAutoTransition("wip-no-evidence", "next", {
            filterCwd: process.cwd(),
            evidence: "   ",
          })
        ).rejects.toThrow(/no evidence of work/)
        const after = await readTasks("wip-no-evidence")
        expect(after.find((t) => t.id === "next")?.status).toBe("pending")
      }
    )
  })

  test("at the cap, disabled auto-transition refuses the hop and leaves the task pending", async () => {
    await withSeededHome(
      "wip-auto-transition-off",
      atCapacity(MAX_IN_PROGRESS_TASKS_PER_PROJECT),
      async () => {
        await Bun.write(
          join(process.env.HOME ?? "", ".swiz", "settings.json"),
          JSON.stringify({ taskAutoTransition: false })
        )
        await expect(
          completeTaskWithAutoTransition("wip-auto-transition-off", "next", {
            filterCwd: process.cwd(),
            evidence: "note:the work was already done",
          })
        ).rejects.toThrow(/auto-transition is disabled/)
        const after = await readTasks("wip-auto-transition-off")
        expect(after.find((t) => t.id === "next")?.status).toBe("pending")
      }
    )
  })
})
