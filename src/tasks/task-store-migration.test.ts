import { describe, expect, test } from "bun:test"
import { readdir, realpath, symlink } from "node:fs/promises"
import { join } from "node:path"
import { tasksCommand } from "../commands/tasks.ts"
import { neutralAgentEnvOverrides, runCommandInProcess, useTempDir } from "../utils/test-utils.ts"
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
import { findTaskAcrossSessions, getSessions, resolveTaskById } from "./task-resolver.ts"
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
        .storeKey
    ).toEqual(project)
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

describe("resolver store ownership (#934)", () => {
  test.each([
    "7",
    "user-7",
  ])("retains both namespaces when task %s has the same logical store name", async (id) => {
    const root = await temp.create()
    const session = sessionStoreKey(project.key)
    await writeTask(session, { ...task, id, subject: "Native task" }, cwd, root)
    await writeTask(project, { ...task, id, subject: "Project task" }, cwd, root)
    const projects = join(root, "transcripts")

    const matches = await findTaskAcrossSessions(id, cwd, root, projects)
    expect(matches.map((match) => match.storeKey)).toEqual([project, session])
    await expect(resolveTaskById(id, "missing-primary", cwd, root, projects)).rejects.toThrow(
      /ambiguous|exists in 2/
    )

    for (const selected of [project, session]) {
      const resolved = await resolveTaskById(id, selected, cwd, root, projects)
      expect(resolved.storeKey).toEqual(selected)
      expect(resolved.task.subject).toBe(
        selected.kind === "project" ? "Project task" : "Native task"
      )
    }
  })

  test("returns the project address from legacy string input", async () => {
    const root = await temp.create()
    await legacy(root)
    const resolved = await resolveTaskById(
      "user-7",
      project.key,
      cwd,
      root,
      join(root, "transcripts")
    )
    expect(resolved.storeKey).toEqual(project)
    expect(await readdir(root)).toEqual([project.key])
  })

  test.each([
    ["project", "update"],
    ["project", "status"],
    ["project", "complete"],
    ["session", "update"],
    ["session", "status"],
    ["session", "complete"],
  ] as const)("CLI %s-store %s preserves sibling records and audit ownership", async (kind, command) => {
    const home = await temp.create()
    const repo = await realpath(await temp.create())
    const root = join(home, ".claude", "tasks")
    const projectKey = projectStoreKey(repo)
    const sessionKey = sessionStoreKey(projectKey.key)
    const selected = kind === "project" ? projectKey : sessionKey
    const sibling = kind === "project" ? sessionKey : projectKey
    // The CLI's primary is the project store. Native selection exercises fallback;
    // project selection exercises the same bare ID in both namespaces.
    const siblingId = kind === "project" ? "7" : "8"
    await writeTask(
      sessionKey,
      { ...task, id: kind === "session" ? "7" : siblingId, subject: "Native record" },
      repo,
      root
    )
    await writeTask(
      projectKey,
      { ...task, id: kind === "project" ? "7" : siblingId, subject: "Project record" },
      repo,
      root
    )
    const siblingPath = join(sessionDirPath(sibling, root), `${siblingId}.json`)
    const before = await Bun.file(siblingPath).text()
    const args =
      command === "update"
        ? [command, "7", "--description", "Changed through selected address"]
        : command === "status"
          ? [command, "7", "completed"]
          : [command, "7", "--evidence", "test:store ownership"]
    const result = await runCommandInProcess(tasksCommand, [...args, "--session", projectKey.key], {
      cwd: repo,
      env: { ...neutralAgentEnvOverrides(), HOME: home, AI_TEST_NO_BACKEND: "1" },
    })
    expect(result.stderr).toBe("")
    expect(result.exitCode).toBe(0)
    const changed = (await readTaskStore(selected, root))[0]!
    expect(changed.id).toBe("7")
    if (command === "update") expect(changed.description).toBe("Changed through selected address")
    else {
      expect(changed.status).toBe("completed")
      expect(result.stdout).toContain(kind === "project" ? "Project record" : "Native record")
    }
    expect(await readTaskStore(sibling, root)).toHaveLength(1)
    expect(await Bun.file(siblingPath).text()).toBe(before)
    const audit = await Bun.file(join(sessionDirPath(selected, root), ".audit-log.jsonl")).text()
    expect(JSON.parse(audit.trim()).taskId).toBe("7")
    expect(await Bun.file(join(sessionDirPath(sibling, root), ".audit-log.jsonl")).exists()).toBe(
      false
    )
  })
})
