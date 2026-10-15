import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { DeadlineStore } from "../deadlines/store.ts"
import { writeResponse } from "../dispatch/cli-output.ts"
import { injectDeadlineContext } from "../dispatch/deadline-context.ts"
import { executeDispatch } from "../dispatch/execute.ts"
import { runStrategyPipeline } from "../dispatch/strategy-base.ts"
import { runMcpTool } from "../mcp-tool-core.ts"
import { canonicalClaimPath } from "../session-file-claims.ts"
import { planDuplicateMerges } from "../tasks/task-merge-duplicates.ts"
import { projectStoreKey, readTaskStore, writeTask } from "../tasks/task-repository.ts"
import { acquireEnvLock, releaseEnvLockFn, useTempDir } from "../utils/test-utils.ts"
import { CappedMap } from "./daemon/cache/capped-map.ts"
import { maybeSuppressDuplicateAllowMessage } from "./daemon/dispatch-routes.ts"
import { handleMcpToolRoute } from "./daemon/mcp-tool-routes.ts"
import { registerDeadlineTool } from "./mcp.ts"

const tmp = useTempDir("swiz-mcp-deadline-")
let cwd: string
let saved: Record<string, string | undefined>
beforeEach(async () => {
  await acquireEnvLock()
  saved = { HOME: process.env.HOME, SWIZ_NO_DAEMON: process.env.SWIZ_NO_DAEMON }
  cwd = canonicalClaimPath(await tmp.create())
  process.env.HOME = cwd
  process.env.SWIZ_NO_DAEMON = "1"
})
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  releaseEnvLockFn()
})

const create = {
  action: "set",
  sessionId: "agent",
  requestId: "create",
  label: "Release",
  completionCriteria: "Verified deployment",
  durationMinutes: 20,
}

test("Deadline get requires attachment in the caller's session, agent and worktree", async () => {
  const original = await runMcpTool("Deadline", create, cwd)
  const deadlineId = original.structuredContent!.deadlines![0]!.id
  for (const [sessionId, agentId, callerCwd] of [
    ["another-session", undefined, cwd],
    ["agent", "child", cwd],
    ["agent", undefined, canonicalClaimPath(await tmp.create())],
  ] as const) {
    const get = { action: "get", sessionId, agentId, deadlineId }
    const denied = await runMcpTool("Deadline", get, callerCwd)
    expect(denied.isError).toBe(true)
    expect(denied.structuredContent?.deadlineHistory).toBeUndefined()
    expect(
      (await runMcpTool("Deadline", { ...get, action: "attach", requestId: "attach" }, callerCwd))
        .isError
    ).toBeUndefined()
    const allowed = await runMcpTool("Deadline", get, callerCwd)
    expect(allowed.isError).toBeUndefined()
    expect(allowed.structuredContent?.deadlines?.[0]?.id).toBe(deadlineId)
    expect(allowed.structuredContent?.deadlineHistory).toHaveLength(1)
  }
})

test("advertises and executes Deadline over MCP and the daemon route with identical retry semantics", async () => {
  const server = new McpServer({ name: "test", version: "0" })
  const client = new Client({ name: "test", version: "0" })
  registerDeadlineTool(server, cwd)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    expect((await client.listTools()).tools[0]?.name).toBe("Deadline")
    const result = await client.callTool({ name: "Deadline", arguments: create })
    expect(result.isError).toBeUndefined()
    const route = await handleMcpToolRoute(
      new Request("http://localhost/mcp/tool", {
        method: "POST",
        body: JSON.stringify({ tool: "Deadline", cwd, input: create }),
      })
    )
    const retried = await route.json()
    expect(result.structuredContent).toMatchObject({
      deadlines: retried.structuredContent.deadlines,
    })
    expect(retried.structuredContent.summary).toContain("UTC")
    const ambiguous = await client.callTool({
      name: "Deadline",
      arguments: { ...create, requestId: "bad", durationMinutes: undefined, dueAt: "4:55" },
    })
    expect(ambiguous.isError).toBe(true)
  } finally {
    await client.close()
    await server.close()
  }
})

test("task deadlines survive retries, description/status updates and completion without completing delivery", async () => {
  const delivery = await runMcpTool("Deadline", create, cwd)
  const parentId = delivery.structuredContent!.deadlines![0]!.id
  const taskInput = {
    subject: "Prepare release patch",
    description: "Provide an integration-ready patch",
    deadline: {
      sessionId: "agent",
      requestId: "task-create",
      durationMinutes: 10,
      parentDeadlineId: parentId,
    },
  }
  const first = await runMcpTool("TaskCreate", taskInput, cwd)
  expect(first.isError).toBeUndefined()
  expect(first.structuredContent?.taskMutation?.changed).toBe(true)
  const tasks = await readTaskStore(projectStoreKey(cwd))
  expect(tasks).toHaveLength(1)
  const task = tasks[0]!
  expect(task.deadlineId).toBeDefined()
  const retry = await runMcpTool("TaskCreate", taskInput, cwd)
  expect(retry.isError).toBeUndefined()
  expect(retry.structuredContent?.taskMutation?.changed).toBe(false)
  expect(retry.structuredContent?.summary).toContain(`Recovered #${task.id}`)
  expect(retry.structuredContent?.summary).toContain("(no change)")
  expect(await readTaskStore(projectStoreKey(cwd))).toHaveLength(1)
  const updated = await runMcpTool(
    "TaskUpdate",
    { taskId: task.id, description: "note: progress recorded", status: "in_progress" },
    cwd
  )
  expect(updated.isError).toBeUndefined()
  const store = (await DeadlineStore.open())!
  const originalDue = store.get(task.deadlineId!).dueAt
  store.close()
  const extension = {
    taskId: task.id,
    deadline: {
      sessionId: "agent",
      requestId: "task-extend",
      durationMinutes: 12,
      expectedRevision: 1,
      reason: "User approved two more minutes",
    },
  }
  expect(
    (await runMcpTool("TaskUpdate", extension, cwd)).structuredContent?.taskMutation?.changed
  ).toBe(true)
  expect(
    (await runMcpTool("TaskUpdate", extension, cwd)).structuredContent?.taskMutation?.changed
  ).toBe(false)
  expect((await runMcpTool("TaskList", {}, cwd)).content[0]?.text).toContain("Task deadlines")
  expect(
    (
      await runMcpTool(
        "TaskUpdate",
        { taskId: task.id, status: "completed", description: "file: release.patch" },
        cwd
      )
    ).isError
  ).toBeUndefined()
  const reopened = (await DeadlineStore.open())!
  expect(reopened.get(task.deadlineId!).originalDueAt).toBe(originalDue)
  expect(reopened.get(task.deadlineId!).status).toBe("completed")
  expect(reopened.get(parentId).status).toBe("active")
  reopened.close()
  const response: Record<string, any> = {}
  await injectDeadlineContext(response, "postToolUse", "PostToolUse", { cwd, session_id: "agent" })
  expect(response.systemMessage).toContain(parentId)
  expect(response.systemMessage).not.toContain(task.deadlineId)
  expect(
    planDuplicateMerges([task, { ...task, id: "other", deadlineId: "other-deadline" }]).merges
  ).toEqual([])
})

test("TaskUpdate can introduce a deadline and safely retry a partial binding", async () => {
  const delivery = await runMcpTool("Deadline", create, cwd)
  const parentDeadlineId = delivery.structuredContent!.deadlines![0]!.id
  await runMcpTool(
    "TaskCreate",
    { subject: "Verify release", description: "Run required checks" },
    cwd
  )
  const task = (await readTaskStore(projectStoreKey(cwd)))[0]!
  const update = {
    taskId: task.id,
    deadline: {
      sessionId: "agent",
      requestId: "attach-task",
      durationMinutes: 5,
      parentDeadlineId,
    },
  }
  expect((await runMcpTool("TaskUpdate", update, cwd)).isError).toBeUndefined()
  expect(
    (await runMcpTool("TaskUpdate", update, cwd)).structuredContent?.taskMutation?.changed
  ).toBe(false)
  // Simulate interruption after the durable deadline/binding but before the task-file write.
  await writeTask(projectStoreKey(cwd), task, cwd)
  expect((await runMcpTool("TaskUpdate", update, cwd)).isError).toBeUndefined()
  expect((await readTaskStore(projectStoreKey(cwd)))[0]?.deadlineId).toBeDefined()
  const mixed = await runMcpTool("TaskUpdate", { ...update, status: "completed" }, cwd)
  expect(mixed.isError).toBe(true)
  expect((await readTaskStore(projectStoreKey(cwd)))[0]?.status).toBe("pending")
})

test("duplicate TaskCreate rejects before persisting a clock or retry receipt", async () => {
  const input = {
    subject: "Prepare collision patch",
    description: "file: collision.patch",
    deadline: { sessionId: "agent", requestId: "duplicate", durationMinutes: 5 },
  }
  await runMcpTool("TaskCreate", { subject: input.subject, description: input.description }, cwd)
  const rejected = await runMcpTool("TaskCreate", input, cwd)
  expect(rejected.isError).toBe(true)
  expect(rejected.content[0]?.text).toContain("Duplicate task")
  expect(
    (await runMcpTool("Deadline", { action: "list", sessionId: "agent" }, cwd)).structuredContent
      ?.deadlines
  ).toEqual([])
  const existing = (await readTaskStore(projectStoreKey(cwd)))[0]!
  await runMcpTool("TaskUpdate", { taskId: existing.id, status: "cancelled" }, cwd)
  expect((await runMcpTool("TaskCreate", input, cwd)).isError).toBeUndefined()
  const list = await runMcpTool("Deadline", { action: "list", sessionId: "agent" }, cwd)
  expect(list.structuredContent?.deadlines).toHaveLength(1)
  expect(list.structuredContent?.deadlines?.[0]?.task?.taskId).not.toBe(existing.id)
})

test.each([
  "cancelled",
  "completed",
] as const)("replaces a %s task clock without reopening its history", async (closedStatus) => {
  const delivery = await runMcpTool("Deadline", create, cwd)
  const parentDeadlineId = delivery.structuredContent!.deadlines![0]!.id
  await runMcpTool(
    "TaskCreate",
    {
      subject: "Validate replacement clock",
      description: "file: replacement.patch",
    },
    cwd
  )
  const task = (await readTaskStore(projectStoreKey(cwd)))[0]!
  const initial = {
    taskId: task.id,
    deadline: { sessionId: "agent", requestId: "initial", durationMinutes: 5, parentDeadlineId },
  }
  expect((await runMcpTool("TaskUpdate", initial, cwd)).isError).toBeUndefined()
  const oldId = (await readTaskStore(projectStoreKey(cwd)))[0]!.deadlineId!
  if (closedStatus === "cancelled") {
    expect(
      (
        await runMcpTool(
          "Deadline",
          {
            action: "cancel",
            sessionId: "agent",
            requestId: "cancel",
            deadlineId: oldId,
            expectedRevision: 1,
            reason: "Reschedule",
          },
          cwd
        )
      ).isError
    ).toBeUndefined()
  } else {
    expect(
      (
        await runMcpTool(
          "TaskUpdate",
          { taskId: task.id, status: "completed", description: "file: replacement.patch" },
          cwd
        )
      ).isError
    ).toBeUndefined()
    expect(
      (await runMcpTool("TaskUpdate", { taskId: task.id, status: "in_progress" }, cwd)).isError
    ).toBeUndefined()
  }
  const replacement = {
    taskId: task.id,
    deadline: { sessionId: "agent", requestId: "replacement", durationMinutes: 8 },
  }
  expect(
    (await runMcpTool("TaskUpdate", replacement, cwd)).structuredContent?.taskMutation?.changed
  ).toBe(true)
  const newId = (await readTaskStore(projectStoreKey(cwd)))[0]!.deadlineId!
  expect(newId).not.toBe(oldId)
  expect(
    (await runMcpTool("TaskUpdate", replacement, cwd)).structuredContent?.taskMutation?.changed
  ).toBe(false)
  expect((await runMcpTool("TaskUpdate", initial, cwd)).isError).toBe(true)
  expect((await readTaskStore(projectStoreKey(cwd)))[0]!.deadlineId).toBe(newId)
  const store = (await DeadlineStore.open())!
  try {
    expect(store.get(oldId).status).toBe(closedStatus)
    expect(store.history(oldId)).toHaveLength(2)
    expect(store.get(newId)).toMatchObject({
      status: "active",
      revision: 1,
      parentDeadlineId,
      task: { taskId: task.id },
    })
    expect(store.get(parentDeadlineId).status).toBe("active")
  } finally {
    store.close()
  }
})

test("invalid task subjects do not create clocks and retries do not recreate pruned tasks", async () => {
  const input = {
    subject: "Prepare release",
    description: "file: release.patch",
    deadline: { sessionId: "agent", requestId: "pruned-task", durationMinutes: 5 },
  }
  expect((await runMcpTool("TaskCreate", { ...input, subject: " " }, cwd)).isError).toBe(true)
  expect(await DeadlineStore.open()).toBeNull()
  expect((await runMcpTool("TaskCreate", input, cwd)).isError).toBeUndefined()
  const task = (await readTaskStore(projectStoreKey(cwd)))[0]!
  await writeTask(
    projectStoreKey(cwd),
    {
      ...task,
      status: "completed",
      completedAt: 1,
      completionTimestamp: new Date(1).toISOString(),
    },
    cwd
  )
  await runMcpTool("TaskList", {}, cwd)
  expect(await readTaskStore(projectStoreKey(cwd))).toHaveLength(0)
  expect((await runMcpTool("TaskCreate", input, cwd)).isError).toBe(true)
  expect(await readTaskStore(projectStoreKey(cwd))).toHaveLength(0)
})

test.each([
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
])("silent dispatch still emits clock context for %s", async (event) => {
  await runMcpTool("Deadline", create, cwd)
  const request = {
    canonicalEvent: event,
    hookEventName: event[0]!.toUpperCase() + event.slice(1),
    daemonContext: true,
    payloadStr: JSON.stringify({
      cwd,
      session_id: "agent",
      tool_name: "mcp__example__query",
      tool_input: {},
      tool_response: {},
      _agent: "claude",
    }),
    manifestProvider: async () => [],
    replayPendingMutations: async () => {},
    repositoryCapabilityProvider: async () => ({
      canonicalRoot: cwd,
      repoKey: "test",
      isRepo: true,
      repoSlug: null,
      hasGhCli: false,
      resolvedAt: Date.now(),
    }),
  }
  const { response } = await executeDispatch(request)
  expect(response.systemMessage).toContain("[Swiz deadline clock]")
  expect(response.hookSpecificOutput?.permissionDecision).toBeUndefined()
  const ctx = { recentHookAllowMessages: new CappedMap<string, string>(10) }
  for (let index = 0; index < 2; index++)
    maybeSuppressDuplicateAllowMessage(
      ctx,
      { cwd, session_id: "agent" },
      event,
      request.hookEventName,
      response
    )
  expect(response.systemMessage).toContain("[Swiz deadline clock]")
})

test("bounds hook context to one delivery and one task deadline", async () => {
  for (let index = 0; index < 5; index++)
    await runMcpTool("Deadline", { ...create, requestId: `release-${index}` }, cwd)
  await runMcpTool(
    "TaskCreate",
    {
      subject: "Deliver bounded patch",
      description: "file: patch",
      deadline: { sessionId: "agent", requestId: "one-task", durationMinutes: 5 },
    },
    cwd
  )
  const response: Record<string, any> = {}
  await injectDeadlineContext(response, "postToolUse", "PostToolUse", { cwd, session_id: "agent" })
  expect(response.systemMessage.match(/due .*reserve/g)).toHaveLength(2)
})

test("appends the clock after response processing and writes one provider-compatible envelope", async () => {
  await runMcpTool("Deadline", create, cwd)
  for (const agentId of ["claude", "codex"]) {
    const chunks: string[] = []
    const output = spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      chunks.push(String(chunk))
      return true
    }) as typeof process.stdout.write)
    try {
      const response = await runStrategyPipeline(
        {
          canonicalEvent: "preToolUse",
          hookEventName: "PreToolUse",
          cwd,
          agentId,
          filteredGroups: [],
          enrichedPayloadStr: JSON.stringify({ cwd, session_id: "agent" }),
        },
        {
          processResults: async () => ({
            systemMessage: "Processed guidance",
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              additionalContext: "Processed guidance",
            },
          }),
        }
      )
      expect(response.systemMessage).toContain("Processed guidance")
      expect(response.systemMessage).toContain("[Swiz deadline clock]")
      expect(chunks).toEqual([])
      writeResponse(response)
      expect(chunks).toHaveLength(1)
      const wire = JSON.parse(chunks.join(""))
      expect(wire.systemMessage).toContain("[Swiz deadline clock]")
      expect(wire.hookSpecificOutput?.permissionDecision).toBeUndefined()
      expect(response.systemMessage.match(/\[Swiz deadline clock\]/g)).toHaveLength(1)
    } finally {
      output.mockRestore()
    }
  }
})

test("local no-hook dispatch emits exactly one JSON response", async () => {
  await runMcpTool("Deadline", create, cwd)
  const chunks: string[] = []
  const output = spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    chunks.push(String(chunk))
    return true
  }) as typeof process.stdout.write)
  try {
    const { response } = await executeDispatch({
      canonicalEvent: "preToolUse",
      hookEventName: "PreToolUse",
      payloadStr: JSON.stringify({
        cwd,
        session_id: "agent",
        tool_name: "Read",
        tool_input: {},
        _agent: "claude",
      }),
      manifestProvider: async () => [],
      replayPendingMutations: async () => {},
      repositoryCapabilityProvider: async () => ({
        canonicalRoot: cwd,
        repoKey: "test",
        isRepo: true,
        repoSlug: null,
        hasGhCli: false,
        resolvedAt: Date.now(),
      }),
    })
    expect(chunks).toEqual([])
    writeResponse(response)
    expect(chunks).toHaveLength(1)
    expect(JSON.parse(chunks.join("")).systemMessage).toContain("[Swiz deadline clock]")
  } finally {
    output.mockRestore()
  }
})
