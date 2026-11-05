import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createSessionSightingLookup,
  sweepUnseenSessionTasks,
} from "./unseen-session-task-sweep.ts"

const HOUR_MS = 60 * 60_000
const NOW_MS = Date.now()
const CUTOFF_MS = NOW_MS - 6 * HOUR_MS

describe("createSessionSightingLookup", () => {
  it("prefers a recent live sighting without scanning transcripts", async () => {
    let scans = 0
    const lookup = createSessionSightingLookup(
      () => NOW_MS - HOUR_MS,
      CUTOFF_MS,
      async () => {
        scans++
        return []
      }
    )
    expect(await lookup("s1", "/tmp/project")).toBe(NOW_MS - HOUR_MS)
    expect(scans).toBe(0)
  })

  it("falls back to a recent transcript mtime and scans each project once", async () => {
    const calls: Array<[string, number]> = []
    const lookup = createSessionSightingLookup(
      () => undefined,
      CUTOFF_MS,
      async (cwd, since) => {
        calls.push([cwd, since])
        return [{ id: "s1", mtime: NOW_MS - 2 * HOUR_MS }]
      }
    )
    expect(await lookup("s1", "/tmp/project")).toBe(NOW_MS - 2 * HOUR_MS)
    expect(await lookup("s2", "/tmp/project")).toBeNull()
    expect(calls).toEqual([["/tmp/project", CUTOFF_MS]])
  })

  it("returns null when the session has no cwd and no live sighting", async () => {
    const lookup = createSessionSightingLookup(
      () => undefined,
      CUTOFF_MS,
      async () => []
    )
    expect(await lookup("s1", undefined)).toBeNull()
  })
})

describe("sweepUnseenSessionTasks", () => {
  async function seedOldSession(tasksDir: string, id: string): Promise<string> {
    const dir = join(tasksDir, id)
    await mkdir(dir, { recursive: true })
    const stamp = new Date(NOW_MS - 7 * HOUR_MS).toISOString()
    await writeFile(
      join(dir, "1.json"),
      JSON.stringify({
        id: "1",
        subject: "Old work",
        description: "",
        status: "in_progress",
        blocks: [],
        blockedBy: [],
        updatedAt: stamp,
        statusChangedAt: stamp,
      })
    )
    await writeFile(
      join(dir, ".session-meta.json"),
      JSON.stringify({ storeKind: "session", openCount: 1, updatedAt: stamp, cwd: "/tmp/p" })
    )
    return dir
  }

  it("spares a session whose transcript moved recently and cancels one that did not", async () => {
    const tasksDir = await mkdtemp(join(tmpdir(), "swiz-unseen-sweep-"))
    const alive = await seedOldSession(tasksDir, "alive")
    const gone = await seedOldSession(tasksDir, "gone")
    const reported: string[] = []

    const cancelled = await sweepUnseenSessionTasks({
      tasksDir,
      now: () => NOW_MS,
      liveLastSeenMs: () => undefined,
      findSessions: async () => [{ id: "alive", mtime: NOW_MS - 10 * 60_000 }],
      onCancelled: (refs) => reported.push(...refs.map((r) => r.taskId)),
    })

    expect(cancelled.map((c) => c.storeKey)).toEqual([{ kind: "session", id: "gone" }])
    expect(reported).toEqual(["1"])
    const status = (dir: string) =>
      readFile(join(dir, "1.json"), "utf-8").then(
        (t) => (JSON.parse(t) as { status: string }).status
      )
    expect(await status(alive)).toBe("in_progress")
    expect(await status(gone)).toBe("cancelled")
  })
})
