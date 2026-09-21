import { describe, expect, test } from "bun:test"
import { readdir, realpath, symlink } from "node:fs/promises"
import { join, relative } from "node:path"
import { collectUnknownOptionWarnings } from "../cli.ts"
import { runTasks, tasksCommand } from "../commands/tasks.ts"
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
        .storeKey
    ).toEqual(project)
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

describe("flat store identity and ownership", () => {
  test("native writes through a project alias count once in the project queue", async () => {
    const root = await temp.create()
    await writeTask(sessionStoreKey(project.key), { ...task, id: "7" }, cwd, root)
    expect(await readTasksAcrossStores(project.key, project.key, root)).toHaveLength(1)
    expect(await readTasksAcrossStores("another-session", project.key, root)).toHaveLength(1)
  })

  test.each([
    "update",
    "status",
    "complete",
  ])("CLI %s mutates the shared alias and audit", async (command) => {
    const home = await temp.create()
    const repo = await realpath(await temp.create())
    const root = join(home, ".claude", "tasks")
    const key = projectStoreKey(repo)
    const alias = sessionStoreKey(key.key)
    await writeTask(alias, { ...task, id: "7" }, repo, root)
    const args =
      command === "update"
        ? [command, "7", "--description", "Shared progress"]
        : command === "status"
          ? [command, "7", "completed"]
          : [command, "7", "--evidence", "test:flat alias"]
    const result = await runCommandInProcess(tasksCommand, args, {
      cwd: repo,
      env: { ...neutralAgentEnvOverrides(), HOME: home, AI_TEST_NO_BACKEND: "1" },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const shared = await readTaskStore(key, root)
    expect(await readTaskStore(alias, root)).toEqual(shared)
    if (command === "update") expect(shared[0]?.description).toBe("Shared progress")
    else expect(shared[0]?.status).toBe("completed")
    const history = await readAuditLog(key.key, root)
    expect(history).toHaveLength(1)
    expect(history[0]?.taskId).toBe("7")
    expect(await readdir(root)).toEqual([key.key])
  })

  test.each([
    "7",
    "user-7",
  ])("aliases project and session addresses with the same logical name for task %s", async (id) => {
    const root = await temp.create()
    const session = sessionStoreKey(project.key)
    await writeTask(session, { ...task, id, subject: "Native task" }, cwd, root)
    await writeTask(project, { ...task, id, subject: "Project task" }, cwd, root)
    const projects = join(root, "transcripts")

    const matches = await findTaskAcrossSessions(id, cwd, root, projects)
    expect(sessionDirPath(project, root)).toBe(sessionDirPath(session, root))
    expect(matches.map((match) => match.storeKey)).toEqual([project])
    expect((await resolveTaskById(id, "missing-primary", cwd, root, projects)).task.subject).toBe(
      "Project task"
    )

    for (const selected of [project, session]) {
      const resolved = await resolveTaskById(id, selected, cwd, root, projects)
      expect(resolved.storeKey).toEqual(selected)
      expect(resolved.task.subject).toBe("Project task")
    }
  })

  test("returns the project address from legacy string input", async () => {
    const root = await temp.create()
    await flat(root)
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
  ] as const)("CLI %s-store %s preserves differently named stores and audit ownership", async (kind, command) => {
    const home = await temp.create()
    const repo = await realpath(await temp.create())
    const root = join(home, ".claude", "tasks")
    const projectKey = projectStoreKey(repo)
    const sessionKey = sessionStoreKey(`native-${projectKey.key}`)
    const selected = kind === "project" ? projectKey : sessionKey
    const sibling = kind === "project" ? sessionKey : projectKey
    // The CLI's primary is the project store. Native selection exercises fallback;
    // project selection exercises the same bare ID in two differently named stores.
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

describe("directory-scoped task updates (#933)", () => {
  test("rejects missing, repeated and non-directory --dir arguments", async () => {
    const directory = await temp.create()
    const file = join(directory, "file.txt")
    await Bun.write(file, "not a directory")
    await expect(runTasks(["update", "7", "--dir"])).rejects.toThrow("requires a directory path")
    await expect(runTasks(["--dir", directory, "--dir", directory])).rejects.toThrow(
      "only be supplied once"
    )
    await expect(runTasks(["--dir", file])).rejects.toThrow("must name a directory")
  })
  test.each([
    "update",
    "status",
    "complete",
  ])("CLI %s uses --dir for selection and persistence", async (command) => {
    const home = await temp.create()
    const ambient = await realpath(await temp.create())
    const selectedCwd = await realpath(await temp.create())
    const root = join(home, ".claude", "tasks")
    const selected = projectStoreKey(selectedCwd)
    const other = projectStoreKey(ambient)
    await writeTask(selected, { ...task, id: "7", subject: "Selected record" }, selectedCwd, root)
    await writeTask(other, { ...task, id: "7", subject: "Ambient record" }, ambient, root)
    const otherPath = join(sessionDirPath(other, root), "7.json")
    const before = await Bun.file(otherPath).text()
    const args =
      command === "update"
        ? [command, "7", "--description", "Scoped change", "--dir", relative(ambient, selectedCwd)]
        : command === "status"
          ? [command, "7", "completed", "--dir", selectedCwd]
          : [command, "7", "--evidence", "test:directory scope", "--dir", selectedCwd]
    expect(collectUnknownOptionWarnings("tasks", args, tasksCommand.options)).toEqual([])
    const result = await runCommandInProcess(tasksCommand, args, {
      cwd: ambient,
      env: { ...neutralAgentEnvOverrides(), HOME: home, AI_TEST_NO_BACKEND: "1" },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("Selected record")
    const updated = (await readTaskStore(selected, root))[0]!
    if (command === "update") expect(updated.description).toBe("Scoped change")
    else expect(updated.status).toBe("completed")
    expect(await Bun.file(otherPath).text()).toBe(before)
    const meta = await Bun.file(join(sessionDirPath(selected, root), ".session-meta.json")).json()
    expect(meta.cwd).toBe(selectedCwd)
    const audit = await Bun.file(join(sessionDirPath(selected, root), ".audit-log.jsonl")).text()
    expect(JSON.parse(audit.trim()).action).toBe(
      command === "update" ? "field_update" : "status_change"
    )
    expect(await Bun.file(join(sessionDirPath(other, root), ".audit-log.jsonl")).exists()).toBe(
      false
    )
  })
})
