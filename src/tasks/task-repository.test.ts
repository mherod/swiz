import { describe, expect, it } from "bun:test"
import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { useTempDir } from "../utils/test-utils.ts"
import { readTasks, type Task, writeTask } from "./task-repository.ts"

const tmp = useTempDir("swiz-task-repo-")

function makeTask(id: string, status: Task["status"], subject?: string): Task {
  return {
    id,
    subject: subject ?? `Task ${id}`,
    description: `Task ${id} description`,
    status,
    blocks: [],
    blockedBy: [],
    statusChangedAt: new Date().toISOString(),
    elapsedMs: 0,
    startedAt: status === "in_progress" ? Date.now() : null,
    completedAt: status === "completed" ? Date.now() : null,
  }
}

describe("writeTask atomicity", () => {
  it("does not leave .tmp files behind after a successful write", async () => {
    // Atomic writes go through a `${path}.${pid}.${ts}.${rand}.tmp` staging
    // file and rename. A successful write must leave only the .json file.
    const base = await tmp.create()
    await writeTask("sess-atomic-1", makeTask("1", "pending"), undefined, base)
    await writeTask("sess-atomic-1", makeTask("2", "in_progress"), undefined, base)

    const sessionDir = join(base, "sess-atomic-1")
    const files = await readdir(sessionDir)
    const tempFiles = files.filter((f) => f.endsWith(".tmp"))
    expect(tempFiles).toEqual([])
  })

  it("survives a concurrent burst of writes without producing unreadable rows", async () => {
    // Without atomic rename, parallel writers and readers occasionally observe
    // a partial JSON payload — readTasks silently drops those, so a task
    // appears to "slip past" until the next event.
    const base = await tmp.create()
    const sessionId = "sess-atomic-burst"

    const writers = Array.from({ length: 25 }, (_, i) =>
      writeTask(sessionId, makeTask(String(i + 1), "pending"), undefined, base)
    )
    const readers = Array.from({ length: 25 }, () => readTasks(sessionId, base))

    const [, ...readResults] = await Promise.all([Promise.all(writers), ...readers])

    for (const read of readResults) {
      // Each read either sees a subset of the in-flight writes (rename hasn't
      // landed yet) OR sees fully-formed task records — never partial junk.
      for (const task of read) {
        expect(task.id).toBeTruthy()
        expect(task.subject).toBeTruthy()
        expect(task.status).toBe("pending")
      }
    }

    // Final read must observe all 25 tasks.
    const final = await readTasks(sessionId, base)
    expect(final).toHaveLength(25)
    const sessionDir = join(base, sessionId)
    const leftovers = (await readdir(sessionDir)).filter((f) => f.endsWith(".tmp"))
    expect(leftovers).toEqual([])
  })

  it("replaces an existing task file in a single atomic step", async () => {
    // The original file must remain valid right up until the rename — a
    // reader interleaved between two writeTask calls should never observe a
    // truncated JSON file. We verify the file's mtime is monotonic and the
    // parsed content reflects the latest write.
    const base = await tmp.create()
    const sessionId = "sess-atomic-replace"

    await writeTask(sessionId, makeTask("1", "pending"), undefined, base)
    const filePath = join(base, sessionId, "1.json")
    const mtime1 = (await stat(filePath)).mtimeMs

    await Bun.sleep(15)
    await writeTask(sessionId, makeTask("1", "in_progress"), undefined, base)
    const mtime2 = (await stat(filePath)).mtimeMs
    expect(mtime2).toBeGreaterThan(mtime1)

    const tasks = await readTasks(sessionId, base)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.status).toBe("in_progress")
  })
})
