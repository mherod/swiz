import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { useTempDir } from "./test-utils.ts"

const temp = useTempDir("swiz-hook-task-store-")
const repo = process.cwd()

/** Exercise the real hook/MCP boundary without touching the user's task queue. */
async function probe(body: string): Promise<void> {
  const home = await temp.create()
  const modulePath = (path: string) => JSON.stringify(join(repo, path))
  const script = `
    import { mkdir } from "node:fs/promises"
    import { join } from "node:path"
    import { runMcpTool } from ${modulePath("src/mcp-tool-core.ts")}
    import { projectKeyFromCwd } from ${modulePath("src/project-key.ts")}
    import { createDefaultTaskStore } from ${modulePath("src/task-roots.ts")}
    import { readTasks, writeTask, writeAudit } from ${modulePath("src/tasks/task-repository.ts")}
    import { createTaskInProcess } from ${modulePath("src/tasks/task-service.ts")}
    import { completeSessionTask } from ${modulePath("src/utils/session-task-io.ts")}
    import { mergeActionPlanIntoTasks } from ${modulePath("src/action-plan.ts")}
    import { prepareBlockingChecklistTasks } from ${modulePath("hooks/stop-ship-checklist/evaluate.ts")}
    import { resolveCompletionAuditContext } from ${modulePath("hooks/stop-completion-auditor/context.ts")}
    import { detectOrphanedCompletedTasks } from ${modulePath("hooks/stop-completion-auditor/task-integrity-validator.ts")}
    import { evaluateStopIncompleteTasks } from ${modulePath("hooks/stop-incomplete-tasks/evaluate.ts")}
    const cwd = join(process.env.HOME, "project")
    await mkdir(cwd, { recursive: true })
    await Bun.write(join(process.env.HOME, ".swiz", "settings.json"), JSON.stringify({ actionPlanMerge: true }))
    const sessionId = crypto.randomUUID()
    const projectKey = projectKeyFromCwd(cwd)
    const tasksRoot = createDefaultTaskStore().tasksDir
    const payload = { session_id: sessionId, cwd, _env: { CLAUDECODE: "1" } }
    const check = (ok, message) => { if (!ok) throw new Error(message) }
    const textOf = result => result.content.map(part => part.text ?? "").join("\\n")
    ${body}
  `
  const proc = Bun.spawn(["bun", "-e", script], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      CLAUDECODE: "1",
      AI_TEST_NO_BACKEND: "1",
      SWIZ_NO_DAEMON: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  expect(await proc.exited, `${stdout}\n${stderr}`).toBe(0)
}

describe("hook task addressing (#868)", () => {
  test("checklist and action-plan tasks appear in MCP and complete through TaskUpdate", async () => {
    await probe(`
      await prepareBlockingChecklistTasks({ blocked: true, steps: [] }, sessionId, cwd)
      check(await mergeActionPlanIntoTasks(["Repair the upload handler"], sessionId, cwd) === 1, "plan task missing")
      const tasks = await readTasks(projectKey)
      check(tasks.length === 2, "both hook writers must use the project store")
      check((await readTasks(sessionId)).length === 0, "new writes must not create a split queue")
      const listed = textOf(await runMcpTool("TaskList", {}, cwd))
      for (const task of tasks) {
        check(listed.includes(task.id), "MCP did not list " + task.id)
        check(!(await runMcpTool("TaskUpdate", { taskId: task.id, status: "in_progress" }, cwd)).isError, "cannot start " + task.id)
        check(!(await runMcpTool("TaskUpdate", { taskId: task.id, status: "completed", description: "test: hook task addressing verified" }, cwd)).isError, "cannot complete " + task.id)
      }
      check((await readTasks(projectKey)).every(task => task.status === "completed"), "MCP completion was not persisted")
    `)
  })

  test("settlement finds the subject in either store and preserves its audit location", async () => {
    await probe(`
      for (const [key, subject] of [[sessionId, "Settle legacy work"], [projectKey, "Settle project work"]]) {
        const task = await createTaskInProcess({ sessionId: key, subject, description: "test fixture", cwd })
        check(await completeSessionTask(sessionId, subject, { cwd, evidence: "test: checklist passed" }), "settlement failed for " + key)
        const settled = (await readTasks(key)).find(item => item.id === task.id)
        check(settled.status === "completed", "wrong store was updated")
        const trail = await Bun.file(join(tasksRoot, key, ".audit-log.jsonl")).text()
        check(trail.includes('"newStatus":"in_progress"') && trail.includes('"newStatus":"completed"'), "transition audit missing")
      }
    `)
  })

  test("newer completed duplicates win in settlement and both stop readers", async () => {
    await probe(`
      const task = await createTaskInProcess({ sessionId, subject: "Preserve completed work", description: "fixture", cwd })
      task.statusChangedAt = "2026-01-01T00:00:00Z"
      await writeTask(sessionId, task, cwd)
      await writeTask(projectKey, { ...task, status: "completed", statusChangedAt: "2026-01-02T00:00:00Z" }, cwd)
      await writeAudit(projectKey, { timestamp: "2026-01-02T00:00:00Z", taskId: task.id, action: "status_change", newStatus: "completed" })
      check(!(await completeSessionTask(sessionId, task.subject, { cwd, evidence: "test: already completed" })), "resurrected stale task")
      check((await evaluateStopIncompleteTasks(payload)).decision !== "block", "stale session copy blocked stop")
      const ctx = await resolveCompletionAuditContext(payload, payload)
      check(ctx.allTasks.length === 1 && ctx.allTasks[0].status === "completed", "auditor read stale copy")
      check((await detectOrphanedCompletedTasks(ctx)).length === 0, "project trail was ignored")
    `)
  })

  test("project-only unfinished work blocks even without a session directory", async () => {
    await probe(`
      const task = await createTaskInProcess({ sessionId: projectKey, subject: "Finish real work", description: "fixture", cwd })
      for (let i = 0; i < 4; i++) {
        const output = await evaluateStopIncompleteTasks(payload)
        check(output.decision === "block" && output.reason.includes(task.id), "genuine incomplete task released")
      }
      const ctx = await resolveCompletionAuditContext(payload, payload)
      check(ctx.allTasks.some(item => item.id === task.id), "auditor missed project task")
    `)
  })

  test("three identical absent-ID checks release only stale blockers and reset on changes", async () => {
    await probe(`
      const ghost = { id: "ghost-1", subject: "Missing work", status: "in_progress" }
      const snapshot = () => ({ sessionId, home: process.env.HOME, tasksDir: join(tasksRoot, sessionId), tasksRoot, projectKey, allTasks: [{ ...ghost }] })
      const dependencies = { resolveContext: async () => snapshot() }
      for (let i = 1; i <= 3; i++) {
        const output = await evaluateStopIncompleteTasks(payload, dependencies)
        check((output.decision === "block") === (i < 3), "wrong missing-ID threshold at " + i)
        if (i === 3) check(output.systemMessage.includes("absent from both"), "release reason missing")
      }
      ghost.id = "ghost-2"
      check((await evaluateStopIncompleteTasks(payload, dependencies)).decision === "block", "different ID inherited release")
      await Bun.write(join(tasksRoot, sessionId, ".stop-missing-tasks.json"), "null")
      check((await evaluateStopIncompleteTasks(payload, dependencies)).decision === "block", "invalid counter should restart")
      const task = await createTaskInProcess({ sessionId: projectKey, subject: "Protect actual work", description: "fixture", cwd })
      for (let i = 0; i < 4; i++) {
        const output = await evaluateStopIncompleteTasks(payload, dependencies)
        check(output.decision === "block" && output.reason.includes(task.id), "fresh real task was released with ghost")
      }
      await evaluateStopIncompleteTasks(payload)
      check((await evaluateStopIncompleteTasks(payload, dependencies)).reason.includes("ghost-2"), "nonidentical check did not reset counter")
      check(!(await completeSessionTask("../outside", task.subject, { cwd, evidence: "test: invalid session" })), "invalid session settled a project task")
    `)
  })
})
