import { describe, expect, test } from "bun:test"
import { readdir, symlink } from "node:fs/promises"
import { join } from "node:path"
import { useTempDir } from "../utils/test-utils.ts"
import { readAuditLog } from "./task-audit-verification.ts"
import {
  projectStoreKey,
  readTaskStore,
  readTasks,
  sessionStoreKey,
  type Task,
  writeTask,
} from "./task-repository.ts"
import { getSessions, resolveTaskById } from "./task-resolver.ts"
import {
  migrateLegacyProjectStores,
  prepareTaskStoreWrite,
  readTaskStorePath,
} from "./task-store-layout.ts"
import { isSafeSessionId, sessionDirPath } from "./task-store-path.ts"

const temp = useTempDir("swiz-store-migration-")
const cwd = "/Users/example/project"
const project = projectStoreKey(cwd)
const task: Task = {
  id: "user-7",
  subject: "Preserve archived work",
  description: "legacy fixture",
  status: "in_progress",
  blocks: [],
  blockedBy: [],
}

function audit(taskId: string) {
  return `${JSON.stringify({ taskId, action: "create", subject: task.subject })}\n`
}

async function writeStore(dir: string, files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) await Bun.write(join(dir, name), text)
  return files
}

/** The home layout: a project store sits directly in the task store. */
function flat(root: string, owner: string | undefined = cwd) {
  return writeStore(join(root, project.key), {
    "user-7.json": JSON.stringify(task),
    ".audit-log.jsonl": audit("user-7"),
    ".session-meta.json": JSON.stringify({ cwd: owner, openCount: 1 }),
    ".hook-dedup-existing.flag": "sentinel",
    "compact-snapshot.json": '{"tasks":[]}',
  })
}

/** What the reverted `.projects` split left behind, if a session wrote under it. */
function namespaced(root: string, files?: Record<string, string>) {
  return writeStore(
    join(root, ".projects", project.key),
    files ?? {
      "split-1.json": JSON.stringify({ ...task, id: "split-1" }),
      ".audit-log.jsonl": audit("split-1"),
      ".session-meta.json": JSON.stringify({ cwd, openCount: 1 }),
    }
  )
}

describe("project namespace fold-back (reverts #831)", () => {
  test("a flat project store is the home directory and no write relocates it", async () => {
    const root = await temp.create()
    const files = await flat(root)
    expect((await readTaskStore(project, root))[0]?.id).toBe("user-7")
    const target = await prepareTaskStoreWrite(project, root)
    expect(target).toBe(join(root, project.key))
    // The reserved namespace is never created by an ordinary write.
    expect(await readdir(root)).toEqual([project.key])
    for (const [name, text] of Object.entries(files))
      expect(await Bun.file(join(target, name)).text()).toBe(text)
    expect((await readTasks(project.key, root))[0]?.id).toBe("user-7")
    expect((await readAuditLog(project.key, root))[0]?.taskId).toBe("user-7")
    expect(
      (await resolveTaskById("user-7", "new-session", cwd, root, join(root, "transcripts")))
        .sessionId
    ).toBe(project.key)
    expect(await getSessions(cwd, root, join(root, "transcripts"))).toEqual([])
  })

  test("a namespaced leftover reads before any write, then folds back into the flat store", async () => {
    const root = await temp.create()
    const files = await namespaced(root)
    // Readable while still namespaced: reads never wait on a migration.
    expect(await readTaskStorePath(project, root)).toBe(join(root, ".projects", project.key))
    expect((await readTaskStore(project, root))[0]?.id).toBe("split-1")
    const target = await prepareTaskStoreWrite(project, root)
    expect(target).toBe(join(root, project.key))
    for (const [name, text] of Object.entries(files))
      expect(await Bun.file(join(target, name)).text()).toBe(text)
    expect(await readdir(root)).toEqual([project.key])
    expect(await readTaskStorePath(project, root)).toBe(target)
  })

  test("merging both stores unions the audit logs and keeps every task record", async () => {
    const root = await temp.create()
    const flatFiles = await flat(root)
    await namespaced(root)
    const target = await prepareTaskStoreWrite(project, root)
    expect(target).toBe(join(root, project.key))
    expect(await readdir(root)).toEqual([project.key])
    expect((await readTaskStore(project, root)).map((t) => t.id).sort()).toEqual([
      "split-1",
      "user-7",
    ])
    // Destination history first, then the namespaced store's: neither copy loses an entry.
    expect((await readAuditLog(project.key, root)).map((entry) => entry.taskId)).toEqual([
      "user-7",
      "split-1",
    ])
    // The derived index keeps the destination copy rather than the stale legacy one.
    expect(await Bun.file(join(target, ".session-meta.json")).text()).toBe(
      flatFiles[".session-meta.json"] as string
    )
  })

  test("a genuine record collision preserves both copies and refuses to pick a winner", async () => {
    const root = await temp.create()
    await flat(root)
    await namespaced(root, { "user-7.json": "namespaced copy" })
    const legacyPath = join(root, ".projects", project.key)
    await expect(prepareTaskStoreWrite(project, root)).rejects.toThrow("exist in both")
    expect(await Bun.file(join(legacyPath, "user-7.json")).text()).toBe("namespaced copy")
    expect((await readTaskStore(project, root))[0]?.id).toBe("user-7")
    expect(await Bun.file(join(root, project.key, "user-7.json")).text()).toBe(JSON.stringify(task))
  })

  test("simultaneous first writes fold back once and retain all records", async () => {
    const root = await temp.create()
    await namespaced(root)
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        writeTask(project, { ...task, id: `next-${i}` }, cwd, root)
      )
    )
    expect(await readTaskStore(project, root)).toHaveLength(13)
    expect(await readdir(root)).toEqual([project.key])
    expect((await readAuditLog(project.key, root))[0]?.taskId).toBe("split-1")
  })

  test("concurrent readers never lose an existing task while its directory moves", async () => {
    const root = await temp.create()
    await namespaced(root)
    const readers = Array.from({ length: 20 }, async () => {
      for (let i = 0; i < 3; i++)
        expect((await readTaskStore(project, root)).map((t) => t.id)).toContain("split-1")
    })
    await Promise.all([...readers, prepareTaskStoreWrite(project, root)])
  })

  test("bulk fold-back previews every namespaced store before moving it", async () => {
    const root = await temp.create()
    await namespaced(root)
    const preview = await migrateLegacyProjectStores(root)
    expect(preview).toContainEqual({ directory: project.key, status: "ready" })
    expect(await Bun.file(join(root, ".projects", project.key, "split-1.json")).exists()).toBe(true)
    expect(await migrateLegacyProjectStores(root, true)).toContainEqual({
      directory: project.key,
      status: "migrated",
    })
    expect(await Bun.file(join(root, project.key, "split-1.json")).exists()).toBe(true)
    // Nothing is left to fold back, and a flat store is never a migration candidate.
    expect(await migrateLegacyProjectStores(root, true)).toEqual([])
  })

  test("a symlinked namespace is ignored without reading or modifying its target", async () => {
    const root = await temp.create()
    const outside = await temp.create()
    await Bun.write(join(outside, project.key, "user-7.json"), "outside")
    await symlink(outside, join(root, ".projects"))
    expect(await readTaskStorePath(project, root)).toBe(join(root, project.key))
    expect(await prepareTaskStoreWrite(project, root)).toBe(join(root, project.key))
    expect(await migrateLegacyProjectStores(root, true)).toEqual([])
    expect(await Bun.file(join(outside, project.key, "user-7.json")).text()).toBe("outside")
    expect(await readdir(outside)).toEqual([project.key])
  })

  test("a session id may not address the reserved namespace", async () => {
    const root = await temp.create()
    expect(isSafeSessionId(sessionStoreKey(`.projects/${project.key}`), root)).toBe(false)
    expect(isSafeSessionId(sessionStoreKey(`nested/../.projects/${project.key}`), root)).toBe(false)
    expect(isSafeSessionId(sessionStoreKey(".projects"), root)).toBe(false)
    // Both kinds share the flat namespace again, so one logical string is one store.
    expect(sessionDirPath(sessionStoreKey(project.key), root)).toBe(sessionDirPath(project, root))
  })
})
