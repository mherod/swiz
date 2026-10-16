import { expect, test } from "bun:test"
import { canonicalClaimPath } from "../../session-file-claims.ts"
import { createDefaultTaskStore } from "../../task-roots.ts"
import { readTaskStore, type Task, writeTask } from "../../tasks/task-repository.ts"
import { createTaskInProcess } from "../../tasks/task-service.ts"
import { projectStoreKey, sessionStoreKey } from "../../tasks/task-store-path.ts"
import { useTempDir, withSandboxHome } from "../../utils/test-utils.ts"
import type { SessionRoutesContext } from "./session-routes.ts"
import { handleWorkActionRoutes } from "./work-action-routes.ts"

const tmp = useTempDir("swiz-work-actions-")
const ctx: SessionRoutesContext = {
  touchProject: () => {},
  registerProjectWatchers: () => {},
  getKnownProjects: () => [],
  getProjectLastSeen: () => 0,
  getProjectStatusLine: async () => "",
  listProjectSessions: async () => ({ sessionCount: 0, sessions: [] }),
  getSessionData: async () => ({ messages: [], toolStats: [] }),
  getSessionTasks: async () => null,
  getProjectTasks: async () => ({
    tasks: [],
    summary: { total: 0, open: 0, completed: 0, cancelled: 0 },
  }),
  getAgentProcessSnapshot: async () => ({ providers: {}, pidCwds: {} }),
}
async function request(path: string, body: unknown, method = "POST") {
  const req = new Request(`http://localhost/work/${path}`, {
    method,
    ...(method === "POST"
      ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
      : {}),
  })
  return (await handleWorkActionRoutes(req, new URL(req.url), ctx))!
}
function statusInput(cwd: string, task: Task, status: string, storeId = projectStoreKey(cwd).key) {
  return {
    cwd,
    storeId,
    taskId: task.id,
    status,
    expectedStatus: task.status,
    expectedStatusChangedAt: task.statusChangedAt,
  }
}

test("Reminders completion starts pending tasks, reopens completed tasks and rejects stale or cancelled work", () =>
  withSandboxHome(async () => {
    const cwd = canonicalClaimPath(await tmp.create())
    const task: Task = (
      await (await request("tasks/create", { cwd, subject: "Verify reverse sync" })).json()
    ).task
    const input = (item: Task, completed: boolean) => {
      const { status: _status, ...identity } = statusInput(cwd, item, "completed")
      return { ...identity, completed }
    }
    const response = await request("tasks/completion", input(task, true))
    expect(response.status).toBe(200)
    const done: Task = (await response.json()).task
    expect(done.status).toBe("completed")
    expect(done.completionEvidence).toContain("Apple Reminders")
    expect((await request("tasks/completion", input(task, true))).status).toBe(409)
    const reopened = await request("tasks/completion", input(done, false))
    expect(reopened.status).toBe(200)
    const active: Task = (await reopened.json()).task
    expect(active.status).toBe("in_progress")
    expect(active.completionEvidence).toBeUndefined()
    const cancelled: Task = (
      await (await request("tasks/status", statusInput(cwd, active, "cancelled"))).json()
    ).task
    expect((await request("tasks/completion", input(cancelled, false))).status).toBe(409)
    expect(
      (await request("tasks/completion", { ...input(cancelled, false), cwd: await tmp.create() }))
        .status
    ).toBe(404)
  }))

test("Reminders completion cannot bypass task blockers", () =>
  withSandboxHome(async () => {
    const cwd = canonicalClaimPath(await tmp.create())
    const task: Task = (
      await (await request("tasks/create", { cwd, subject: "Verify blockers" })).json()
    ).task
    task.blockedBy = ["unresolved"]
    await writeTask(projectStoreKey(cwd), task, cwd, createDefaultTaskStore().tasksDir)
    const { status: _status, ...identity } = statusInput(cwd, task, "completed")
    expect((await request("tasks/completion", { ...identity, completed: true })).status).toBe(409)
    expect((await readTaskStore(projectStoreKey(cwd)))[0]?.status).toBe("pending")
  }))

test("creates project tasks and validates status, evidence, stale edits and exact stores", () =>
  withSandboxHome(async () => {
    const cwd = canonicalClaimPath(await tmp.create())
    const created = await request("tasks/create", {
      cwd,
      subject: "Verify desktop controls",
      description: "Lifecycle test",
    })
    expect(created.status).toBe(200)
    const task: Task = (await created.json()).task
    expect(task.status).toBe("pending")
    expect((await readTaskStore(projectStoreKey(cwd))).map((item) => item.id)).toContain(task.id)
    expect((await request("tasks/create", { cwd, subject: task.subject })).status).toBe(409)
    expect(
      (
        await request("tasks/status", {
          ...statusInput(cwd, task, "completed"),
          evidence: "test: passed",
        })
      ).status
    ).toBe(400)
    const started = await request("tasks/status", statusInput(cwd, task, "in_progress"))
    expect(started.status).toBe(200)
    const running: Task = (await started.json()).task
    expect((await request("tasks/status", statusInput(cwd, task, "cancelled"))).status).toBe(409)
    expect((await request("tasks/status", statusInput(cwd, running, "completed"))).status).toBe(400)
    const finished = await request("tasks/status", {
      ...statusInput(cwd, running, "completed"),
      evidence: "test: lifecycle passed",
    })
    expect(finished.status).toBe(200)
    const completed: Task = (await finished.json()).task
    expect(completed.completionEvidence).toBe("test: lifecycle passed")
    const other = await tmp.create()
    expect(
      (
        await request("tasks/status", {
          ...statusInput(other, completed, "in_progress"),
          storeId: projectStoreKey(cwd).key,
        })
      ).status
    ).toBe(404)
    expect(
      (await request("tasks/status", statusInput(cwd, completed, "in_progress", "missing-store")))
        .status
    ).toBe(404)
    const reopened = await request("tasks/status", statusInput(cwd, completed, "in_progress"))
    const active: Task = (await reopened.json()).task
    const cancelled = await request("tasks/status", statusInput(cwd, active, "cancelled"))
    expect((await cancelled.json()).task.status).toBe("cancelled")
  }))

test("legacy session tasks require project metadata and blockers stay enforced", () =>
  withSandboxHome(async () => {
    const cwd = await tmp.create()
    const storeKey = sessionStoreKey(`legacy-${crypto.randomUUID()}`)
    const blocker = await createTaskInProcess({
      storeKey,
      sessionId: storeKey.id,
      cwd,
      subject: "Prepare fixture",
      description: "",
    })
    const task = await createTaskInProcess({
      storeKey,
      sessionId: storeKey.id,
      cwd,
      subject: "Verify result",
      description: "",
    })
    task.blockedBy = [blocker.id]
    await writeTask(storeKey, task, cwd, createDefaultTaskStore().tasksDir)
    expect(
      (await request("tasks/status", statusInput(cwd, task, "in_progress", storeKey.id))).status
    ).toBe(409)
    const cancelled = await request(
      "tasks/status",
      statusInput(cwd, blocker, "cancelled", storeKey.id)
    )
    expect(cancelled.status).toBe(200)
    expect(
      (await request("tasks/status", statusInput(cwd, task, "in_progress", storeKey.id))).status
    ).toBe(200)
    expect(
      (await request("tasks/status", statusInput(cwd, task, "cancelled", "../../outside"))).status
    ).toBe(404)
  }))

test("deadline HTTP lifecycle is project scoped with revision conflicts and strict inputs", () =>
  withSandboxHome(async () => {
    const cwd = await tmp.create()
    const base = {
      cwd,
      action: "set",
      requestId: crypto.randomUUID(),
      label: "Desktop deadline",
      completionCriteria: "Verified",
      durationMinutes: 30,
    }
    const response = await request("deadlines", base)
    expect(response.status).toBe(200)
    const first = (await response.json()).deadline
    expect((await (await request("deadlines", base)).json()).deadline.id).toBe(first.id)
    expect((await request("deadlines", { ...base, sessionId: "agent" })).status).toBe(400)
    const change = {
      cwd,
      action: "revise",
      requestId: crypto.randomUUID(),
      deadlineId: first.id,
      expectedRevision: 1,
      durationMinutes: 45,
      reason: "Allow verification",
    }
    const revised = await request("deadlines", change)
    expect((await revised.json()).deadline.revision).toBe(2)
    expect((await request("deadlines", { ...change, requestId: crypto.randomUUID() })).status).toBe(
      409
    )
    const cancel = {
      cwd,
      action: "cancel",
      requestId: crypto.randomUUID(),
      deadlineId: first.id,
      expectedRevision: 2,
      reason: "Test finished",
    }
    expect((await (await request("deadlines", cancel)).json()).deadline.status).toBe("cancelled")
    expect((await request("deadlines", { ...cancel, cwd: await tmp.create() })).status).toBe(400)
  }))

test("deadline completion endpoint reopens the same deadline with strict versioned inputs", () =>
  withSandboxHome(async () => {
    const cwd = await tmp.create()
    const first = (
      await (
        await request("deadlines", {
          cwd,
          action: "set",
          requestId: "new",
          label: "Reminders round trip",
          completionCriteria: "Verify checkboxes",
          durationMinutes: 60,
        })
      ).json()
    ).deadline
    const input = {
      cwd,
      deadlineId: first.id,
      expectedRevision: 1,
      requestId: "checked",
      completed: true,
    }
    const response = await request("deadlines/completion", input)
    expect(response.status).toBe(200)
    expect((await response.json()).deadline.status).toBe("completed")
    expect((await request("deadlines/completion", { ...input, completed: "false" })).status).toBe(
      400
    )
    const reopened = await request("deadlines/completion", {
      ...input,
      expectedRevision: 2,
      requestId: "unchecked",
      completed: false,
    })
    expect(reopened.status).toBe(200)
    const active = (await reopened.json()).deadline
    expect(active.status).toBe("active")
    expect(active.id).toBe(first.id)
    expect(active.dueAt).toBe(first.dueAt)
    expect(
      (await request("deadlines/completion", { ...input, cwd: await tmp.create() })).status
    ).toBe(400)
  }))

test("work actions reject invalid projects, JSON shapes, fields and methods", async () => {
  const cwd = await tmp.create()
  for (const body of [
    null,
    {},
    { cwd: "." },
    { cwd: "/" },
    { cwd, subject: "" },
    { cwd, subject: "Valid", extra: true },
  ]) {
    expect((await request("tasks/create", body)).status).toBe(400)
  }
  expect((await request("tasks/create", null, "GET")).status).toBe(405)
})
