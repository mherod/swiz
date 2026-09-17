import { describe, expect, test } from "bun:test"
import { readdir, symlink } from "node:fs/promises"
import { join } from "node:path"
import { useTempDir } from "../utils/test-utils.ts"
import { readAuditLog } from "./task-audit-verification.ts"
import {
  projectStoreKey,
  readTaskStore,
  readTasks,
  readTasksAcrossStores,
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

async function legacy(root: string, owner: string | undefined = cwd) {
  const dir = join(root, project.key)
  const files = {
    "user-7.json": JSON.stringify(task),
    ".audit-log.jsonl": `${JSON.stringify({ taskId: task.id, action: "create", subject: task.subject })}\n`,
    ".session-meta.json": JSON.stringify({ cwd: owner, openCount: 1 }),
    ".hook-dedup-existing.flag": "sentinel",
    "compact-snapshot.json": '{"tasks":[]}',
  }
  for (const [name, text] of Object.entries(files)) await Bun.write(join(dir, name), text)
  return files
}

describe("project namespace migration (#831)", () => {
  test("read-only compatibility preserves the flat directory; migration preserves every byte and legacy ID", async () => {
    const root = await temp.create()
    const files = await legacy(root)
    expect((await readTaskStore(project, root))[0]?.id).toBe("user-7")
    expect(await readdir(root)).toEqual([project.key])
    const target = await prepareTaskStoreWrite(project, root)
    expect(target).toBe(join(root, ".projects", project.key))
    expect(await readdir(root)).toEqual([".projects"])
    for (const [name, text] of Object.entries(files))
      expect(await Bun.file(join(target, name)).text()).toBe(text)
    expect((await readTasks(project.key, root))[0]?.id).toBe("user-7")
    expect((await readAuditLog(project.key, root))[0]?.taskId).toBe("user-7")
    expect(
      (await resolveTaskById("user-7", "new-session", cwd, root, join(root, "transcripts")))
        .sessionId
    ).toBe(project.key)
    expect(await getSessions(cwd, root, join(root, "transcripts"))).toEqual([])
    expect(await prepareTaskStoreWrite(project, root)).toBe(target)
  })

  test("simultaneous first writes migrate once and retain all records", async () => {
    const root = await temp.create()
    await legacy(root)
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        writeTask(project, { ...task, id: `next-${i}` }, cwd, root)
      )
    )
    expect(await readTaskStore(project, root)).toHaveLength(13)
    expect(await readdir(join(root, ".projects"))).toEqual([project.key])
    expect((await readAuditLog(project.key, root))[0]?.taskId).toBe("user-7")
  })

  test("concurrent readers never lose an existing task while its directory moves", async () => {
    const root = await temp.create()
    await legacy(root)
    const readers = Array.from({ length: 20 }, async () => {
      for (let i = 0; i < 3; i++)
        expect((await readTaskStore(project, root)).map((t) => t.id)).toContain("user-7")
    })
    await Promise.all([...readers, prepareTaskStoreWrite(project, root)])
  })

  test("bulk migration reports uncertain ownership and moves only confirmed projects", async () => {
    const root = await temp.create()
    await legacy(root)
    const held = projectStoreKey("/Users/example/foreign")
    await Bun.write(join(root, held.key, ".session-meta.json"), JSON.stringify({ cwd }))
    const preview = await migrateLegacyProjectStores(root)
    expect(preview).toContainEqual({ directory: project.key, status: "ready" })
    expect(preview.find((result) => result.directory === held.key)?.status).toBe("held")
    expect(await Bun.file(join(root, project.key, "user-7.json")).exists()).toBe(true)
    expect(await migrateLegacyProjectStores(root, true)).toContainEqual({
      directory: project.key,
      status: "migrated",
    })
    expect(await Bun.file(join(root, held.key, ".session-meta.json")).exists()).toBe(true)
    expect(await migrateLegacyProjectStores(root, true)).toHaveLength(1)
  })

  test("conflicting destinations preserve both directories and refuse reads and writes", async () => {
    const root = await temp.create()
    const files = await legacy(root)
    const target = sessionDirPath(project, root)
    await Bun.write(join(target, "other.json"), "destination")
    await expect(readTaskStore(project, root)).rejects.toThrow("Conflicting task stores")
    await expect(writeTask(project, task, cwd, root)).rejects.toThrow("Conflicting task stores")
    expect(await Bun.file(join(root, project.key, "user-7.json")).text()).toBe(files["user-7.json"])
    expect(await Bun.file(join(target, "other.json")).text()).toBe("destination")
  })

  test("contradictory metadata prevents migration without hiding explicit legacy reads", async () => {
    const root = await temp.create()
    await legacy(root, "/different/project")
    await expect(prepareTaskStoreWrite(project, root, cwd)).rejects.toThrow("ownership")
    expect((await readTaskStore(project, root))[0]?.id).toBe("user-7")
    expect(await getSessions(undefined, root, join(root, "transcripts"))).toEqual([])
    expect(await Bun.file(join(root, project.key, "user-7.json")).exists()).toBe(true)
  })

  test("the same logical string can address distinct explicit session and project stores", async () => {
    const root = await temp.create()
    const session = sessionStoreKey(project.key)
    await writeTask(session, { ...task, id: "native-1" }, cwd, root)
    await writeTask(project, task, cwd, root)
    expect((await readTaskStore(session, root)).map((t) => t.id)).toEqual(["native-1"])
    expect((await readTaskStore(project, root)).map((t) => t.id)).toEqual(["user-7"])
    expect((await readTasksAcrossStores(project.key, project.key, root)).map((t) => t.id)).toEqual([
      "native-1",
      "user-7",
    ])
    expect(isSafeSessionId(sessionStoreKey(`.projects/${project.key}`), root)).toBe(false)
    expect(isSafeSessionId(sessionStoreKey(`nested/../.projects/${project.key}`), root)).toBe(false)
  })

  test("rejects namespace symlinks without modifying their target", async () => {
    const root = await temp.create()
    const outside = await temp.create()
    await symlink(outside, join(root, ".projects"))
    await expect(prepareTaskStoreWrite(project, root, cwd)).rejects.toThrow("not a directory")
    await expect(readTaskStorePath(project, root)).rejects.toThrow("not a directory")
    expect(await readdir(outside)).toEqual([])
  })
})
