import { describe, expect, expectTypeOf, it } from "bun:test"
import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { projectKeyFromCwd } from "../project-key.ts"
import { useTempDir } from "../utils/test-utils.ts"
import { readAuditLog } from "./task-audit-verification.ts"
import {
  isSafeSessionId,
  mergeTaskStoresByRecency,
  projectStoreKey,
  readSessionMeta,
  readTasks,
  resolveLegacyTaskStoreKey,
  sessionDirPath,
  type Task,
  type TaskStoreKey,
  taskStoreDirName,
  writeAudit,
  writeTask,
  writeTaskBatch,
} from "./task-repository.ts"
import { sessionStoreKey } from "./task-store-path.ts"

const tmp = useTempDir("swiz-task-repo-")

describe("typed task store keys", () => {
  it("requires explicit keys for writers and containment while preserving string readers", () => {
    expectTypeOf<Parameters<typeof writeTask>[0]>().toEqualTypeOf<TaskStoreKey>()
    expectTypeOf<Parameters<typeof writeTaskBatch>[0]>().toEqualTypeOf<TaskStoreKey>()
    expectTypeOf<Parameters<typeof writeAudit>[0]>().toEqualTypeOf<TaskStoreKey>()
    expectTypeOf<Parameters<typeof sessionDirPath>[0]>().toEqualTypeOf<TaskStoreKey>()
    expectTypeOf<Parameters<typeof isSafeSessionId>[0]>().toEqualTypeOf<TaskStoreKey>()
    expectTypeOf<Parameters<typeof readTasks>[0]>().toEqualTypeOf<string>()
    expectTypeOf<Parameters<typeof readSessionMeta>[0]>().toEqualTypeOf<string>()
    expectTypeOf<string>().not.toMatchTypeOf<Parameters<typeof writeTask>[0]>()
    expectTypeOf(sessionStoreKey("id").kind).toEqualTypeOf<"session">()
    expectTypeOf(projectStoreKey("/project").kind).toEqualTypeOf<"project">()
  })

  it("keeps native session paths while separating project paths without changing IDs", async () => {
    const base = await tmp.create()
    const cwd = "/workspace/project"
    const keys = [sessionStoreKey("abcd-session"), projectStoreKey(cwd)]
    const names = ["abcd-session", join(".projects", projectKeyFromCwd(cwd))]
    for (const [index, key] of keys.entries()) {
      const name = names[index]!
      expect(taskStoreDirName(key)).toBe(name)
      expect(sessionDirPath(key, base)).toBe(join(base, name))
      const task = makeTask("user-1", "in_progress")
      await writeTask(key, task, cwd, base)
      await writeAudit(
        key,
        { timestamp: "2026-09-17T00:00:00Z", taskId: task.id, action: "create" },
        base
      )
      expect(await readTasks(name, base)).toEqual([task])
      expect((await readAuditLog(name, base))[0]?.taskId).toBe("user-1")
      expect(await resolveLegacyTaskStoreKey(name, "/different-project", base)).toEqual(key)
      task.status = "completed"
      await writeTask(key, task, undefined, base)
      expect(await Bun.file(join(base, name, "user-1.json")).json()).toEqual(task)
    }
    expect((await readdir(base)).sort()).toEqual([".projects", "abcd-session"])
  })

  it("classifies first writes from explicit cwd without guessing from a directory prefix", async () => {
    const base = await tmp.create()
    const project = projectStoreKey("/workspace/project")
    expect(await resolveLegacyTaskStoreKey(project.key, "/workspace/project", base)).toEqual(
      project
    )
    expect(
      await resolveLegacyTaskStoreKey("-arbitrary-session", "/workspace/project", base)
    ).toEqual(sessionStoreKey("-arbitrary-session"))
    expect(await readdir(base)).toEqual([])
  })

  it("enforces containment for project keys as well as session keys", () => {
    expect(isSafeSessionId({ kind: "project", key: "../escape" }, "/tmp/store")).toBe(false)
    expect(() => sessionDirPath({ kind: "project", key: "../escape" }, "/tmp/store")).toThrow()
  })

  it("ignores malformed metadata ownership without changing the legacy write address", async () => {
    const base = await tmp.create()
    const key = projectStoreKey("/workspace/project")
    await Bun.write(join(base, key.key, ".session-meta.json"), JSON.stringify({ cwd: 42 }))
    expect(await resolveLegacyTaskStoreKey(key.key, "/workspace/project", base)).toEqual(key)
    const task = makeTask("user-2", "pending")
    await writeTask(key, task, "/workspace/project", base)
    expect(await readTasks(key.key, base)).toEqual([task])
  })
})

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
      expect(isSafeSessionId(sessionStoreKey(sessionId), "/tmp/store")).toBe(false)
      expect(() => sessionDirPath(sessionStoreKey(sessionId), "/tmp/store")).toThrow(
        /Unsafe task session id/
      )
    }
  })

  it("accepts ordinary session ids", () => {
    // Control for the rejection case above: proves the guard is not refusing everything.
    for (const sessionId of CONTAINED) {
      expect(isSafeSessionId(sessionStoreKey(sessionId), "/tmp/store")).toBe(true)
      expect(sessionDirPath(sessionStoreKey(sessionId), "/tmp/store")).toStartWith("/tmp/store/")
    }
  })

  it("rejects empty and whitespace-only session ids", () => {
    for (const sessionId of ["", "   ", "."]) {
      expect(isSafeSessionId(sessionStoreKey(sessionId), "/tmp/store")).toBe(false)
    }
  })

  it("writes nothing outside the store when given a traversing id", async () => {
    const base = await tmp.create()
    await expect(
      writeTask(sessionStoreKey("../escapee"), makeTask("1", "pending"), undefined, base)
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
    await writeTask(sessionStoreKey("sess-atomic-1"), makeTask("1", "pending"), undefined, base)
    await writeTask(sessionStoreKey("sess-atomic-1"), makeTask("2", "in_progress"), undefined, base)

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
      writeTask(sessionStoreKey(sessionId), makeTask(String(i + 1), "pending"), undefined, base)
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

    await writeTask(sessionStoreKey(sessionId), makeTask("1", "pending"), undefined, base)
    const filePath = join(base, sessionId, "1.json")
    const mtime1 = (await stat(filePath)).mtimeMs

    await Bun.sleep(15)
    await writeTask(sessionStoreKey(sessionId), makeTask("1", "in_progress"), undefined, base)
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
      sessionStoreKey(sessionId),
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
      sessionStoreKey(sessionId),
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

describe("mergeTaskStoresByRecency", () => {
  const base = { subject: "shared task", status: "in_progress" as const }

  it("prefers the copy written most recently, not the one whose status moved last", () => {
    // A description-only TaskUpdate bumps updatedAt and leaves statusChangedAt alone.
    // Tie-breaking on statusChangedAt kept returning the stale duplicate, which made the
    // task-recency gate unsatisfiable: recording progress could not change what it read.
    const stale = {
      id: "1",
      ...base,
      statusChangedAt: "2026-09-18T10:00:00.000Z",
      updatedAt: "2026-09-18T10:00:00.000Z",
    }
    const refreshed = {
      id: "1",
      ...base,
      statusChangedAt: "2026-09-18T10:00:00.000Z",
      updatedAt: "2026-09-18T10:30:00.000Z",
    }

    expect(mergeTaskStoresByRecency([stale], [refreshed])[0]?.updatedAt).toBe(refreshed.updatedAt)
    // Group order must not decide the winner.
    expect(mergeTaskStoresByRecency([refreshed], [stale])[0]?.updatedAt).toBe(refreshed.updatedAt)
  })

  it("still falls back to statusChangedAt when no write stamp exists", () => {
    const older = { id: "1", ...base, statusChangedAt: "2026-09-18T10:00:00.000Z" }
    const newer = { id: "1", ...base, statusChangedAt: "2026-09-18T11:00:00.000Z" }

    expect(mergeTaskStoresByRecency([newer], [older])[0]?.statusChangedAt).toBe(
      newer.statusChangedAt
    )
  })

  it("keeps one copy per id across stores", () => {
    const merged = mergeTaskStoresByRecency(
      [{ id: "1", ...base, updatedAt: "2026-09-18T10:00:00.000Z" }],
      [
        { id: "1", ...base, updatedAt: "2026-09-18T10:30:00.000Z" },
        { id: "2", ...base, updatedAt: "2026-09-18T10:00:00.000Z" },
      ]
    )
    expect(merged.map((task) => task.id)).toEqual(["1", "2"])
  })
})
