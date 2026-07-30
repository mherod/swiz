import { describe, expect, test } from "bun:test"
import stopLifecycleTasks from "../../../hooks/stop-lifecycle-tasks.ts"
import type { HookGroup } from "../../manifest.ts"
import type { SwizHook } from "../../SwizHook.ts"
import { CappedMap } from "./cache/capped-map.ts"
import { LastUserMessageCache } from "./cache/last-user-message-cache.ts"
import { createMetrics } from "./cache/metrics.ts"
import {
  buildDispatchRoutesContext,
  type DispatchRoutesContext,
  handleDispatchActive,
  handleDispatchRoute,
  prepareLifecycleTaskDispatch,
  reapStaleDispatches,
} from "./dispatch-routes.ts"
import {
  ACTIVE_LIFECYCLE_TASKS_PAYLOAD_KEY,
  LifecycleTaskRegistry,
} from "./lifecycle-task-registry.ts"
import type { ActiveHookDispatch } from "./types.ts"
import type { DaemonWebServerContext } from "./web-server-context.ts"
import { DaemonWorkerRuntime } from "./worker-runtime.ts"

const DISPATCH_CONTEXT_KEYS = [
  "projectMetrics",
  "getProjectMetrics",
  "globalMetrics",
  "sessionActivity",
  "sessionToolCalls",
  "sessionToolUsage",
  "activeHookDispatches",
  "workerRuntime",
  "touchProject",
  "registerProjectWatchers",
  "manifestCache",
  "resolveSnapshot",
  "upstreamSyncRegistry",
  "transcriptIndex",
  "lastUserMessageCache",
  "taskStateCache",
  "lifecycleTaskRegistry",
  "recentHookAllowMessages",
] as const satisfies readonly (keyof DispatchRoutesContext)[]

function activeDispatch(
  requestId: string,
  startedAt: number,
  cwd = "/repo",
  sessionId: string | null = "session-1"
): ActiveHookDispatch {
  return {
    requestId,
    canonicalEvent: "preToolUse",
    hookEventName: "PreToolUse",
    cwd,
    sessionId,
    hooks: ["test-hook"],
    startedAt,
  }
}

function createDispatchContext(manifest: HookGroup[] = []): DispatchRoutesContext {
  const projectMetrics = new Map<string, ReturnType<typeof createMetrics>>()
  return {
    projectMetrics,
    getProjectMetrics: (cwd) => {
      const existing = projectMetrics.get(cwd)
      if (existing) return existing
      const metrics = createMetrics()
      projectMetrics.set(cwd, metrics)
      return metrics
    },
    globalMetrics: createMetrics(),
    sessionActivity: new Map(),
    sessionToolCalls: new Map(),
    sessionToolUsage: new Map(),
    activeHookDispatches: new Map(),
    workerRuntime: new DaemonWorkerRuntime({ enabled: false }),
    touchProject: () => {},
    registerProjectWatchers: () => {},
    manifestCache: {
      get: async () => manifest,
    } as unknown as DispatchRoutesContext["manifestCache"],
    resolveSnapshot: async () => {
      throw new Error("snapshot resolution is not expected in dispatch route tests")
    },
    upstreamSyncRegistry: {} as DispatchRoutesContext["upstreamSyncRegistry"],
    transcriptIndex: {
      get: async () => null,
    } as unknown as DispatchRoutesContext["transcriptIndex"],
    lastUserMessageCache: new LastUserMessageCache(),
    taskStateCache: {
      watchSession: () => {},
    } as unknown as DispatchRoutesContext["taskStateCache"],
    lifecycleTaskRegistry: new LifecycleTaskRegistry(),
    recentHookAllowMessages: new CappedMap(10),
  }
}

describe("dispatch route context", () => {
  test("copies exactly the dispatch route capabilities", () => {
    const sentinels = new Map<PropertyKey, unknown>()
    const source = new Proxy<Record<PropertyKey, unknown>>(
      {},
      {
        get: (_target, key) => {
          if (!sentinels.has(key)) sentinels.set(key, Object.freeze({ key }))
          return sentinels.get(key)
        },
      }
    ) as unknown as DaemonWebServerContext

    const result = buildDispatchRoutesContext(source)

    expect(Object.keys(result).sort()).toEqual([...DISPATCH_CONTEXT_KEYS].sort())
    for (const key of DISPATCH_CONTEXT_KEYS) {
      expect(result[key]).toBe(source[key])
    }
  })
})

describe("reapStaleDispatches", () => {
  test("removes stale entries while preserving active dispatches", () => {
    const now = Date.now()
    const entries = new Map<string, ActiveHookDispatch>([
      ["stale", activeDispatch("stale", now - 300_001)],
      ["active", activeDispatch("active", now)],
    ])

    reapStaleDispatches(entries)

    expect([...entries.keys()]).toEqual(["active"])
  })
})

describe("handleDispatchActive", () => {
  test("filters by cwd and session then sorts newest first", async () => {
    const ctx = createDispatchContext()
    ctx.activeHookDispatches.set("older", activeDispatch("older", 100, "/repo", "session-1"))
    ctx.activeHookDispatches.set("newer", activeDispatch("newer", 300, "/repo", "session-1"))
    ctx.activeHookDispatches.set(
      "other-cwd",
      activeDispatch("other-cwd", 400, "/other", "session-1")
    )
    ctx.activeHookDispatches.set(
      "other-session",
      activeDispatch("other-session", 500, "/repo", "session-2")
    )
    const url = new URL("http://daemon/dispatch/active?cwd=%2Frepo&sessionId=session-1")

    const body = await handleDispatchActive(url, ctx).json()

    expect(body.active.map((entry: ActiveHookDispatch) => entry.requestId)).toEqual([
      "newer",
      "older",
    ])
  })
})

describe("handleDispatchRoute", () => {
  test("maps invalid dispatch payloads to a structured 400 response", async () => {
    const url = new URL("http://daemon/dispatch?event=preToolUse&hookEventName=PreToolUse")
    const response = await handleDispatchRoute(
      new Request(url, { method: "POST", body: "not-json{{{" }),
      url,
      createDispatchContext()
    )
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.error).toBe('Invalid dispatch payload for event "preToolUse"')
    expect(body.issues).toBeArray()
    expect(body.issues).not.toHaveLength(0)
  })

  test("fails open for malformed lifecycle payloads", async () => {
    const ctx = createDispatchContext()
    const url = new URL("http://daemon/dispatch?event=taskCreated&hookEventName=TaskCreated")
    const response = await handleDispatchRoute(
      new Request(url, {
        method: "POST",
        body: JSON.stringify({
          cwd: process.cwd(),
          session_id: "session-1",
          hook_event_name: "TaskCreated",
        }),
      }),
      url,
      ctx
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({})
    expect(ctx.lifecycleTaskRegistry.size).toBe(0)
  })

  test("suppresses repeated non-blocking hook messages", async () => {
    const allowHook: SwizHook = {
      name: "test-repeated-allow-message",
      event: "preToolUse",
      matcher: "Bash",
      run: () => ({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: "Repeated daemon hint",
        },
      }),
    }
    const ctx = createDispatchContext([
      {
        event: "preToolUse",
        matcher: "Bash",
        hooks: [{ hook: allowHook }],
      },
    ])
    const url = new URL("http://daemon/dispatch?event=preToolUse&hookEventName=PreToolUse")
    const request = () =>
      new Request(url, {
        method: "POST",
        body: JSON.stringify({
          cwd: process.cwd(),
          tool_name: "Bash",
          tool_input: { command: "echo ok" },
          _env: { CODEX_THREAD_ID: "dispatch-route-dedupe" },
        }),
      })

    const first = await handleDispatchRoute(request(), url, ctx).then((response) => response.json())
    const second = await handleDispatchRoute(request(), url, ctx).then((response) =>
      response.json()
    )

    expect(first.systemMessage).toContain("Repeated daemon hint")
    expect(second.systemMessage).toBeUndefined()
    expect(second.hookSpecificOutput?.additionalContext).toBeUndefined()
  })
})

describe("prepareLifecycleTaskDispatch", () => {
  test("tracks create/complete at the daemon boundary and injects Stop snapshots", async () => {
    const ctx = createDispatchContext()
    const projectCwd = process.cwd()
    const created = {
      cwd: projectCwd,
      session_id: "session-1",
      hook_event_name: "TaskCreated",
      task_id: "task-1",
      task_subject: "Compile assets",
      task_description: "Build the production bundle",
      teammate_name: "worker-a",
      team_name: "frontend",
    }

    expect(await prepareLifecycleTaskDispatch(ctx, "taskCreated", created)).toEqual({
      failOpen: false,
      payloadChanged: false,
    })

    const stopPayload: Record<string, unknown> = {
      cwd: projectCwd,
      session_id: "session-1",
      hook_event_name: "Stop",
    }
    expect(await prepareLifecycleTaskDispatch(ctx, "stop", stopPayload)).toEqual({
      failOpen: false,
      payloadChanged: true,
      advisory: expect.stringContaining("task-1: Compile assets"),
    })
    expect(stopPayload[ACTIVE_LIFECYCLE_TASKS_PAYLOAD_KEY]).toEqual([
      expect.objectContaining({
        taskId: "task-1",
        subject: "Compile assets",
        description: "Build the production bundle",
        teammateName: "worker-a",
        teamName: "frontend",
      }),
    ])

    expect(
      await prepareLifecycleTaskDispatch(ctx, "taskCompleted", {
        ...created,
        hook_event_name: "TaskCompleted",
      })
    ).toEqual({ failOpen: false, payloadChanged: false })
    expect(ctx.lifecycleTaskRegistry.size).toBe(0)
  })

  test("clears the matching project/session on sessionEnd", async () => {
    const ctx = createDispatchContext()
    const payload = {
      cwd: process.cwd(),
      session_id: "session-1",
      hook_event_name: "TaskCreated",
      task_id: "task-1",
      task_subject: "Compile assets",
    }
    await prepareLifecycleTaskDispatch(ctx, "taskCreated", payload)

    expect(
      await prepareLifecycleTaskDispatch(ctx, "sessionEnd", {
        cwd: process.cwd(),
        session_id: "session-1",
        hook_event_name: "SessionEnd",
      })
    ).toEqual({ failOpen: false, payloadChanged: false })
    expect(ctx.lifecycleTaskRegistry.size).toBe(0)
  })

  test("surfaces the lifecycle advisory through the full daemon Stop response", async () => {
    const ctx = createDispatchContext([
      { event: "taskCreated", hooks: [] },
      { event: "stop", hooks: [{ hook: stopLifecycleTasks }] },
    ])
    const projectCwd = process.cwd()
    const createUrl = new URL("http://daemon/dispatch?event=taskCreated&hookEventName=TaskCreated")
    await handleDispatchRoute(
      new Request(createUrl, {
        method: "POST",
        body: JSON.stringify({
          cwd: projectCwd,
          session_id: "session-advisory",
          hook_event_name: "TaskCreated",
          task_id: "task-1",
          task_subject: "Compile assets",
        }),
      }),
      createUrl,
      ctx
    )

    const stopUrl = new URL("http://daemon/dispatch?event=stop&hookEventName=Stop")
    const response = await handleDispatchRoute(
      new Request(stopUrl, {
        method: "POST",
        body: JSON.stringify({
          cwd: projectCwd,
          session_id: "session-advisory",
          hook_event_name: "Stop",
        }),
      }),
      stopUrl,
      ctx
    )
    const body = (await response.json()) as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(body.continue).toBe(true)
    expect(body.reason).toEqual(expect.stringContaining("task-1: Compile assets"))
    expect(body.systemMessage).toEqual(expect.stringContaining("advisory only"))
  })
})
