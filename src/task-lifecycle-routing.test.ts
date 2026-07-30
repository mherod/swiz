import { describe, expect, test } from "bun:test"
import { AGENTS, getAgent } from "./agents.ts"
import {
  DISPATCH_CANONICAL_INBOUND_SCHEMAS,
  DISPATCH_ROUTES,
  executeDispatch,
} from "./dispatch/index.ts"
import { bundledHookManifest } from "./manifest.ts"
import {
  taskCompletedHookInputSchema,
  taskCreatedHookInputSchema,
  taskEventHookInputSchema,
} from "./schemas.ts"

const createdPayload = {
  cwd: process.cwd(),
  session_id: "session-1",
  transcript_path: "/transcript.jsonl",
  permission_mode: "default",
  hook_event_name: "TaskCreated",
  task_id: "task-1",
  task_subject: "Compile assets",
  task_description: "Build the production bundle",
  teammate_name: "worker-a",
  team_name: "frontend",
}

describe("task lifecycle routing", () => {
  test("maps only Claude's public lifecycle events", () => {
    const claude = getAgent("claude")
    expect(claude?.eventMap.taskCreated).toBe("TaskCreated")
    expect(claude?.eventMap.taskCompleted).toBe("TaskCompleted")

    for (const agent of AGENTS.filter((candidate) => candidate.id !== "claude")) {
      expect(agent.eventMap.taskCreated).toBeUndefined()
      expect(agent.eventMap.taskCompleted).toBeUndefined()
      expect(agent.unsupportedEvents).toContain("taskCreated")
      expect(agent.unsupportedEvents).toContain("taskCompleted")
    }
  })

  test("uses context routes and explicit canonical inbound schemas", () => {
    expect(DISPATCH_ROUTES.taskCreated).toBe("context")
    expect(DISPATCH_ROUTES.taskCompleted).toBe("context")
    expect(DISPATCH_CANONICAL_INBOUND_SCHEMAS.taskCreated).toBe(taskCreatedHookInputSchema)
    expect(DISPATCH_CANONICAL_INBOUND_SCHEMAS.taskCompleted).toBe(taskCompletedHookInputSchema)
    expect(bundledHookManifest.some((group) => group.event === "taskCreated")).toBe(true)
    expect(bundledHookManifest.some((group) => group.event === "taskCompleted")).toBe(true)
  })

  test("parses both upstream literals while preserving lifecycle metadata", () => {
    expect(taskCreatedHookInputSchema.parse(createdPayload)).toMatchObject(createdPayload)
    const completedPayload = { ...createdPayload, hook_event_name: "TaskCompleted" as const }
    expect(taskCompletedHookInputSchema.parse(completedPayload)).toMatchObject(completedPayload)
    expect(taskEventHookInputSchema.parse(createdPayload)).toMatchObject(createdPayload)
    expect(taskEventHookInputSchema.parse(completedPayload)).toMatchObject(completedPayload)

    expect(taskCreatedHookInputSchema.safeParse(completedPayload).success).toBe(false)
    expect(taskCompletedHookInputSchema.safeParse(createdPayload).success).toBe(false)
  })

  test("local fallback allows lifecycle events when the daemon is unavailable", async () => {
    const result = await executeDispatch({
      canonicalEvent: "taskCreated",
      hookEventName: "TaskCreated",
      payloadStr: JSON.stringify(createdPayload),
      daemonContext: true,
      manifestProvider: async () => [],
    })

    expect(result.response).toEqual({})
  })

  test("planning task state has no lifecycle registry coupling", async () => {
    const source = await Bun.file(new URL("./tasks/task-event-state.ts", import.meta.url)).text()
    expect(source).not.toContain("LifecycleTaskRegistry")
    expect(source).not.toContain("taskCreated")
    expect(source).not.toContain("taskCompleted")
  })
})
