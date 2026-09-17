import { expect, test } from "bun:test"
import { join } from "node:path"
import { useTempDir } from "../utils/test-utils.ts"

const tmp = useTempDir("swiz-store-ownership-")

test("MCP updates legacy session tasks in place while every queue retains project scope", async () => {
  const home = await tmp.create()
  const root = process.cwd()
  const script = `
    import { mock } from "bun:test"
    import { join } from "node:path"
    mock.module(${JSON.stringify(join(process.cwd(), "src/tasks/task-discovery.ts"))}, () => ({ discoverRelatedTaskAdvice: async () => "" }))
    const root = ${JSON.stringify(root)}
    const repo = await import(root + "/src/tasks/task-repository.ts")
    const { runMcpTool, readMcpTaskQueue } = await import(root + "/src/mcp-tool-core.ts")
    const { readDefaultProjectTasks } = await import(root + "/src/commands/tasks.ts")
    const { readHookTasks } = await import(root + "/src/tasks/task-recovery.ts")
    const { resolveTaskCheckContext } = await import(root + "/hooks/stop-incomplete-tasks/context.ts")
    const { createDefaultTaskStore } = await import(root + "/src/task-roots.ts")
    const cwd = join(process.env.HOME, "project")
    const foreign = join(process.env.HOME, "foreign")
    const tasksDir = createDefaultTaskStore().tasksDir
    const key = repo.projectStoreKey(cwd)
    const legacy = repo.sessionStoreKey("legacy-session")
    const make = (id, status, subject) => ({ id, status, subject, description: "fixture", blocks: [], blockedBy: [], statusChangedAt: new Date().toISOString() })
    await repo.writeTask(legacy, make("user-1", "in_progress", "Repair legacy ownership"), cwd, tasksDir)
    await repo.writeAudit(legacy, { timestamp: new Date().toISOString(), taskId: "user-1", action: "create", newStatus: "in_progress" }, tasksDir)
    await repo.writeTask(legacy, { ...make("old-2", "completed", "Retain session history"), completedAt: 1 }, cwd, tasksDir)
    await repo.writeTask(key, make("next-1", "pending", "Verify namespace rollout"), cwd, tasksDir)
    await repo.writeTask(key, { ...make("old-project", "completed", "Prune project history"), completedAt: 1 }, cwd, tasksDir)
    await repo.writeTask(repo.sessionStoreKey("foreign-session"), make("foreign-1", "pending", "Hide foreign session"), foreign, tasksDir)
    // Reproduce historical daemon corruption: a foreign path key whose cwd was overwritten.
    await repo.writeTask(repo.projectStoreKey(foreign), make("foreign-2", "pending", "Hide corrupt foreign metadata"), cwd, tasksDir)
    const text = result => result.content.map(part => part.text).join("\\n")
    const listed = await runMcpTool("TaskList", {}, cwd)
    const updated = await runMcpTool("TaskUpdate", { taskId: "user-1", description: "note: ownership regression fixed", status: "completed" }, cwd)
    const denied = await runMcpTool("TaskUpdate", { taskId: "foreign-1", status: "in_progress" }, cwd)
    const payload = { session_id: "legacy-session", cwd }
    const views = await Promise.all([
      readMcpTaskQueue(key.key, tasksDir).then(rows => rows.map(row => row.task)),
      readDefaultProjectTasks(cwd, tasksDir),
      readHookTasks(payload),
      resolveTaskCheckContext(payload).then(ctx => ctx.allTasks),
    ])
    const projection = tasks => tasks.map(t => t.id + ":" + t.status).sort()
    const stored = (await repo.readTaskStore(legacy, tasksDir)).find(t => t.id === "user-1")
    const audit = await Bun.file(join(repo.sessionDirPath(legacy, tasksDir), ".audit-log.jsonl")).text()
    console.log(JSON.stringify({
      listed: text(listed), updated, denied, views: views.map(projection), stored,
      legacyHistoryExists: await Bun.file(join(repo.sessionDirPath(legacy, tasksDir), "old-2.json")).exists(),
      projectHistoryExists: await Bun.file(join(repo.sessionDirPath(key, tasksDir), "old-project.json")).exists(),
      duplicateExists: await Bun.file(join(repo.sessionDirPath(key, tasksDir), "user-1.json")).exists(),
      owner: await repo.readSessionMeta("legacy-session", tasksDir), audit,
    }))
  `
  const proc = Bun.spawn(["bun", "-e", script], {
    cwd: home,
    env: { ...process.env, HOME: home, SWIZ_NO_DAEMON: "1", AI_TEST_NO_BACKEND: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  expect(await proc.exited, stderr).toBe(0)
  const result = JSON.parse(stdout.trim().split("\n").at(-1)!)
  expect(result.listed).toContain("user-1")
  expect(result.listed).not.toContain("foreign-")
  expect(result.updated.isError).not.toBe(true)
  expect(result.updated.structuredContent.taskMutation.changed).toBe(true)
  expect(result.denied.isError).toBe(true)
  expect(result.stored.status).toBe("completed")
  expect(result.stored.description).toBe("note: ownership regression fixed")
  expect(result.owner.cwd).toBe(join(home, "project"))
  expect(result.duplicateExists).toBe(false)
  expect(result.legacyHistoryExists).toBe(true)
  expect(result.projectHistoryExists).toBe(false)
  for (const view of result.views)
    expect(view).toEqual(["next-1:pending", "old-2:completed", "user-1:completed"])
  expect(result.audit).toContain('"taskId":"user-1"')
  expect(result.audit).toContain('"newStatus":"completed"')
}, 30_000)
