import { describe, expect, test } from "bun:test"
import stopLifecycleTasks from "../../../hooks/stop-lifecycle-tasks.ts"
import type { HookGroup } from "../../manifest.ts"
import type { SwizHook } from "../../SwizHook.ts"
import { resolveSessionLines } from "../../utils/transcript.ts"
import { CappedMap } from "./cache/capped-map.ts"
import { LastUserMessageCache } from "./cache/last-user-message-cache.ts"
import { createMetrics, serializeMetrics } from "./cache/metrics.ts"
import { TranscriptIndexCache } from "./cache/transcript-index-cache.ts"
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
  "repositoryCapabilityCache",
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
    repositoryCapabilityCache: {
      get: async (cwd: string) => ({
        canonicalRoot: cwd,
        repoKey: "dispatch-route-test",
        isRepo: true,
        repoSlug: "owner/repo",
        hasGhCli: true,
        resolvedAt: Date.now(),
      }),
    } as unknown as DispatchRoutesContext["repositoryCapabilityCache"],
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
  test("injects one shared transcript summary across concurrent requests", async () => {
    let releaseBuild!: () => void
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve
    })
    let buildCalls = 0
    const sessionLine = JSON.stringify({ type: "user", message: { content: "current" } })
    const transcriptIndex = new TranscriptIndexCache({
      readMetadata: () => Promise.resolve({ mtimeMs: 123, size: sessionLine.length }),
      async buildIndex(_path, _size, mtimeMs) {
        buildCalls++
        await buildGate
        return {
          summary: {
            toolNames: [],
            toolCallCount: 0,
            bashCommands: [],
            skillInvocations: [],
            hasGitPush: false,
            sessionLines: [sessionLine],
            sessionDurationMs: 0,
            successfulTestRuns: 0,
            lastVerificationTime: null,
            sessionScope: "trivial",
          },
          blockedToolUseIds: [],
          mtimeMs,
          computedAt: Date.now(),
        }
      },
    })
    const observedSummaries: Array<Record<string, any> | undefined> = []
    const observedSessionLines: string[][] = []
    const observer: SwizHook = {
      name: "test-transcript-summary-observer",
      event: "preToolUse",
      matcher: "Bash",
      async run(input) {
        observedSummaries.push(
          (input as Record<string, any>)._transcriptSummary as Record<string, any> | undefined
        )
        observedSessionLines.push(
          await resolveSessionLines(input as Record<string, any>, "/mock/summary.jsonl")
        )
        return {}
      },
    }
    const ctx = createDispatchContext([
      { event: "preToolUse", matcher: "Bash", hooks: [{ hook: observer }] },
    ])
    ctx.transcriptIndex = transcriptIndex
    const url = new URL("http://daemon/dispatch?event=preToolUse&hookEventName=PreToolUse")
    const request = () =>
      new Request(url, {
        method: "POST",
        body: JSON.stringify({
          cwd: process.cwd(),
          session_id: "summary-concurrency",
          transcript_path: "/mock/summary.jsonl",
          tool_name: "Bash",
          tool_input: { command: "true" },
        }),
      })

    const pending = [
      handleDispatchRoute(request(), url, ctx),
      handleDispatchRoute(request(), url, ctx),
    ]
    await Promise.resolve()
    releaseBuild()
    const responses = await Promise.all(pending)

    expect(responses.every((response) => response.status === 200)).toBe(true)
    expect(buildCalls).toBe(1)
    expect(observedSummaries).toHaveLength(2)
    expect(observedSummaries.every((summary) => summary?.sessionLines.length === 0)).toBe(true)
    expect(observedSessionLines.every((lines) => lines[0] === sessionLine)).toBe(true)
  })

  test("resolves repository capability through the daemon cache", async () => {
    const ctx = createDispatchContext()
    let cacheCalls = 0
    ctx.repositoryCapabilityCache = {
      get: async (cwd: string) => {
        cacheCalls++
        return {
          canonicalRoot: cwd,
          repoKey: "daemon-cache-test",
          isRepo: true,
          repoSlug: "owner/repo",
          hasGhCli: true,
          resolvedAt: Date.now(),
        }
      },
    } as unknown as DispatchRoutesContext["repositoryCapabilityCache"]
    const url = new URL(
      "http://daemon/dispatch?event=nonexistentEvent&hookEventName=NonexistentEvent"
    )
    const response = await handleDispatchRoute(
      new Request(url, {
        method: "POST",
        body: JSON.stringify({ cwd: process.cwd(), session_id: "capability-cache-test" }),
      }),
      url,
      ctx
    )

    expect(response.status).toBe(200)
    expect(cacheCalls).toBe(1)
  })

  test("records full-path route and stage distributions", async () => {
    const syncHook: SwizHook = {
      name: "test-metrics-sync",
      event: "preToolUse",
      matcher: "Bash",
      run: () => ({}),
    }
    const asyncHook: SwizHook = {
      name: "test-metrics-async",
      event: "preToolUse",
      matcher: "Bash",
      async: true,
      async run() {
        return {}
      },
    }
    const ctx = createDispatchContext([
      {
        event: "preToolUse",
        matcher: "Bash",
        hooks: [{ hook: syncHook }, { hook: asyncHook }],
      },
    ])
    const url = new URL("http://daemon/dispatch?event=preToolUse&hookEventName=PreToolUse")
    const response = await handleDispatchRoute(
      new Request(url, {
        method: "POST",
        body: JSON.stringify({
          cwd: process.cwd(),
          session_id: "metrics-stage-test",
          tool_name: "Bash",
          tool_input: { command: "true" },
          _swizTiming: { cliBootstrapMs: 12 },
        }),
      }),
      url,
      ctx
    )

    expect(response.status).toBe(200)
    const event = serializeMetrics(ctx.globalMetrics).byEvent.preToolUse
    expect(event).toMatchObject({ count: 1, errorCount: 0, timeoutCount: 0, maxHookCount: 2 })
    const route = event?.routes.preToolUse
    expect(route?.stages).toEqual(
      expect.objectContaining({
        cliBootstrap: expect.objectContaining({ count: 1, minMs: 12 }),
        capture: expect.objectContaining({ count: 1 }),
        repository: expect.objectContaining({ count: 1 }),
        replay: expect.objectContaining({ count: 1 }),
        manifest: expect.objectContaining({ count: 1 }),
        enrichment: expect.objectContaining({ count: 1 }),
        syncHooks: expect.objectContaining({ count: 1 }),
        asyncHooks: expect.objectContaining({ count: 1 }),
        persistence: expect.objectContaining({ count: 1 }),
      })
    )
    expect(ctx.projectMetrics.get(process.cwd())?.dispatches.get("preToolUse")?.count).toBe(1)
  })

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
