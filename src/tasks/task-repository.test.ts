import { describe, expect, it } from "bun:test"
import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { useTempDir } from "../utils/test-utils.ts"
import {
  isSafeSessionId,
  readSessionMeta,
  readTasks,
  sessionDirPath,
  type Task,
  writeTask,
  writeTaskBatch,
} from "./task-repository.ts"

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

describe("session directory containment", () => {
  // `session_id` comes straight from agent hook stdin. Before the guard, `join(tasksDir, id)`
  // let `..` segments escape: `"../../etc/passwd"` created a real `~/etc/passwd/` task
  // directory. Reproduction: `scripts/debug-session-dir-traversal.ts`.
  const ESCAPING = ["../../etc/passwd", "a/../../../../escaped", "..", "../sibling"]
  const CONTAINED = [
    "7ed7644d-3b7c-4d02-8278-9aa2d4059950",
    "-Users-matthewherod-Development-swiz",
    // `join` keeps an absolute-looking id under the root, unlike `resolve` — so it is contained.
    "/tmp/not-actually-absolute",
    // Contained despite the shell metacharacters: nothing here traverses.
    "$(whoami)",
  ]

  it("rejects session ids that resolve outside the store", () => {
    for (const sessionId of ESCAPING) {
      expect(isSafeSessionId(sessionId, "/tmp/store")).toBe(false)
      expect(() => sessionDirPath(sessionId, "/tmp/store")).toThrow(/Unsafe task session id/)
    }
  })

  it("accepts ordinary session ids", () => {
    // Control for the rejection case above: proves the guard is not refusing everything.
    for (const sessionId of CONTAINED) {
      expect(isSafeSessionId(sessionId, "/tmp/store")).toBe(true)
      expect(sessionDirPath(sessionId, "/tmp/store")).toStartWith("/tmp/store/")
    }
  })

  it("rejects empty and whitespace-only session ids", () => {
    for (const sessionId of ["", "   ", "."]) {
      expect(isSafeSessionId(sessionId, "/tmp/store")).toBe(false)
    }
  })

  it("writes nothing outside the store when given a traversing id", async () => {
    const base = await tmp.create()
    await expect(
      writeTask("../escapee", makeTask("1", "pending"), undefined, base)
    ).rejects.toThrow(/Unsafe task session id/)
    expect(await readdir(base)).toEqual([])
  })

  it("reads a traversing id as empty rather than throwing", async () => {
    // Read paths (status lines, governance gates) must not crash on a malformed payload.
    const base = await tmp.create()
    expect(await readTasks("../../etc/passwd", base)).toEqual([])
    expect(await readSessionMeta("../../etc/passwd", base)).toBeNull()
  })
})

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

  it("writes a task batch with ordered audit entries and one final metadata state", async () => {
    const base = await tmp.create()
    const sessionId = "sess-atomic-batch"
    const first = makeTask("1", "pending", "First task")
    const second = makeTask("2", "completed", "Second task")

    const result = await writeTaskBatch(
      sessionId,
      [
        {
          task: first,
          audit: {
            timestamp: new Date().toISOString(),
            taskId: first.id,
            action: "create",
            newStatus: first.status,
            subject: first.subject,
          },
        },
        {
          task: second,
          audit: {
            timestamp: new Date().toISOString(),
            taskId: second.id,
            action: "create",
            newStatus: second.status,
            subject: second.subject,
          },
        },
      ],
      [first, second],
      process.cwd(),
      base
    )

    expect((await readTasks(sessionId, base)).map((task) => task.id)).toEqual(["1", "2"])
    expect(await readSessionMeta(sessionId, base)).toMatchObject({
      cwd: process.cwd(),
      openCount: 1,
    })

    const auditLines = (await readFile(join(base, sessionId, ".audit-log.jsonl"), "utf-8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { taskId: string })
    expect(auditLines.map((entry) => entry.taskId)).toEqual(["1", "2"])
    expect(result).toMatchObject({
      taskWrites: 2,
      auditWrites: 2,
      metadataWrites: 1,
      maxConcurrentTaskWrites: 2,
    })
  })

  it("bounds a 100-task batch while writing one metadata record", async () => {
    const base = await tmp.create()
    const sessionId = "sess-atomic-large-batch"
    const tasks = Array.from({ length: 100 }, (_, index) =>
      makeTask(String(index + 1), "pending", `Task ${index + 1}`)
    )

    const result = await writeTaskBatch(
      sessionId,
      tasks.map((task) => ({
        task,
        audit: {
          timestamp: new Date().toISOString(),
          taskId: task.id,
          action: "create" as const,
          newStatus: task.status,
          subject: task.subject,
          operationId: `batch-${task.id}`,
        },
      })),
      tasks,
      process.cwd(),
      base
    )

    expect(result).toMatchObject({ taskWrites: 100, auditWrites: 100, metadataWrites: 1 })
    expect(result.maxConcurrentTaskWrites).toBeGreaterThan(0)
    expect(result.maxConcurrentTaskWrites).toBeLessThanOrEqual(8)
    expect(await readTasks(sessionId, base)).toHaveLength(100)
    expect(await readSessionMeta(sessionId, base)).toMatchObject({ openCount: 100 })
    const auditLines = (await readFile(join(base, sessionId, ".audit-log.jsonl"), "utf-8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { taskId: string })
    expect(auditLines.map((entry) => entry.taskId)).toEqual(tasks.map((task) => task.id))
  })
})
