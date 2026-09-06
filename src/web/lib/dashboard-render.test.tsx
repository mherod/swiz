import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { Window } from "happy-dom"
import { act, Profiler } from "react"
import { createRoot, type Root } from "react-dom/client"
import { Header } from "../components/header.tsx"
import * as browserUtils from "../components/session-browser-utils.ts"
import { SessionMessages } from "../components/session-messages.tsx"
import { type DashboardState, useDashboardState } from "./dashboard-state.ts"

let window: Window
let root: Root
let container: HTMLElement
let latest: DashboardState
let renders: number
let headerRenders: number
let payloads: Record<string, unknown>
let deferSession: string | null
const deferred: Array<() => void> = []
let nextIntervalId = 0
const intervals = new Map<number, () => void>()
const globals = new Map<string, PropertyDescriptor | undefined>()
let restoreMocks: Array<() => void> = []
let rowRenders: ReturnType<typeof spyOn<typeof browserUtils, "formatTime">>

function Harness() {
  latest = useDashboardState()
  renders++
  return (
    <>
      <Profiler
        id="header"
        onRender={() => {
          headerRenders++
        }}
      >
        <Header
          clock={latest.clock}
          totalDispatches={latest.m.totalDispatches ?? 0}
          projects={latest.projectCount}
          activeWatches={latest.watchCount}
          activeHooks={0}
        />
      </Profiler>
      <SessionMessages messages={latest.sessionMessages} loading={false} hideTasks />
    </>
  )
}

async function settle() {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

async function tick() {
  await act(async () => {
    for (const refresh of intervals.values()) refresh()
    await settle()
  })
}

beforeEach(async () => {
  window = new Window({ url: "http://localhost/?project=%2Fproject&session=first" })
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  intervals.clear()
  nextIntervalId = 0
  deferSession = null
  deferred.length = 0
  const schedule = (callback: () => void) => {
    const id = ++nextIntervalId
    intervals.set(id, callback)
    return id
  }
  const intervalSpy = spyOn(globalThis, "setInterval").mockImplementation(
    schedule as typeof setInterval
  )
  const clearSpy = spyOn(globalThis, "clearInterval").mockImplementation((id) => {
    intervals.delete(Number(id))
  })
  payloads = {
    "/metrics": { uptimeMs: 1000, uptimeHuman: "1s", totalDispatches: 2, byEvent: {} },
    "/metrics?project=%2Fproject": { byEvent: {}, transcriptMonitor: { count: 1 } },
    "/cache/status": {},
    "/ci-watches": { active: [] },
    "/sessions/projects": { projects: [] },
    "/process/agents": { providers: {} },
    "/sessions/messages": {
      messages: [{ role: "assistant", timestamp: "2026-09-06T00:00:00Z", text: "Before" }],
      toolStats: [],
      tokenStats: {
        totalTokens: 10,
        inputTokens: 5,
        outputTokens: 5,
        cachedInputTokens: 0,
        outputTokensPerMinute: 1,
      },
    },
    "/sessions/tasks": { tasks: [], summary: null },
    "/projects/tasks": { tasks: [], summary: null },
  }
  const respond = async (...[input, init]: Parameters<typeof fetch>): Promise<Response> => {
    const url = String(input)
    const response = Response.json(payloads[url] ?? { active: [] })
    if (
      url === "/sessions/messages" &&
      deferSession &&
      JSON.parse(String(init?.body)).sessionId === deferSession
    ) {
      return new Promise<Response>((resolve) => deferred.push(() => resolve(response)))
    }
    return response
  }
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(respond, { preconnect: globalThis.fetch.preconnect })
  )
  rowRenders = spyOn(browserUtils, "formatTime")
  restoreMocks = [
    () => intervalSpy.mockRestore(),
    () => clearSpy.mockRestore(),
    () => fetchSpy.mockRestore(),
    () => rowRenders.mockRestore(),
  ]
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  renders = 0
  headerRenders = 0
  await act(async () => {
    root.render(<Harness />)
    await settle()
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  expect(intervals.size).toBe(0)
  for (const restore of restoreMocks) restore()
  await window.happyDOM.close()
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
  globals.clear()
})

describe("mounted dashboard polling", () => {
  it("keeps equal polls from rerendering the root or memoized message rows", async () => {
    const baseline = renders
    const rows = rowRenders.mock.calls.length
    const messages = latest.sessionMessages
    expect(rows).toBeGreaterThan(0)
    for (let index = 0; index < 3; index++) await tick()
    expect(latest.sessionMessages).toBe(messages)
    expect(renders).toBe(baseline)
    expect(rowRenders.mock.calls.length).toBe(rows)
  })

  it("keeps uptime ticks out of root state", async () => {
    const baseline = renders
    const headers = headerRenders
    payloads["/metrics"] = {
      ...(payloads["/metrics"] as object),
      uptimeMs: 2000,
      uptimeHuman: "2s",
    }
    await tick()
    expect(renders).toBe(baseline)
    expect(headerRenders).toBeGreaterThan(headers)
    expect(container.textContent).toContain("2s uptime")
  })

  it("propagates telemetry-only changes while retaining message identities", async () => {
    const messages = latest.sessionMessages
    const rows = rowRenders.mock.calls.length
    payloads["/sessions/messages"] = {
      ...(payloads["/sessions/messages"] as object),
      tokenStats: {
        totalTokens: 20,
        inputTokens: 5,
        outputTokens: 15,
        cachedInputTokens: 0,
        outputTokensPerMinute: 3,
      },
    }
    await tick()
    expect(latest.sessionTokenStats?.totalTokens).toBe(20)
    expect(latest.sessionMessages).toBe(messages)
    expect(rowRenders.mock.calls.length).toBe(rows)
  })

  it("renders changed message content through the real memoized row", async () => {
    const rows = rowRenders.mock.calls.length
    payloads["/sessions/messages"] = {
      ...(payloads["/sessions/messages"] as object),
      messages: [{ role: "assistant", timestamp: "2026-09-06T00:00:00Z", text: "After!" }],
    }
    await tick()
    expect(container.textContent).toContain("After!")
    expect(rowRenders.mock.calls.length).toBeGreaterThan(rows)
  })

  it.each(["session", "project"])("rejects late replies after a %s switch", async (kind) => {
    deferSession = "first"
    await tick()
    await act(async () => {
      latest.handleSelectSession("/project", "first")
      await settle()
    })
    expect(deferred.length).toBeGreaterThan(1)
    payloads["/sessions/messages"] = {
      ...(payloads["/sessions/messages"] as object),
      messages: [
        { role: "assistant", timestamp: "2026-09-06T01:00:00Z", text: "Current selection" },
      ],
    }
    await act(async () => {
      latest.handleSelectSession(kind === "project" ? "/other" : "/project", "second")
      await settle()
    })
    expect(container.textContent).toContain("Current selection")
    await act(async () => {
      for (const resolve of deferred) resolve()
      await settle()
    })
    expect(latest.optimisticSessionId).toBe("second")
    expect(container.textContent).toContain("Current selection")
    expect(container.textContent).not.toContain("Before")
  })

  it("propagates real task, session, status and diagnostic changes", async () => {
    payloads["/sessions/tasks"] = {
      tasks: [{ id: "task-1", subject: "Changed", status: "pending" }],
      summary: null,
    }
    payloads["/projects/tasks"] = {
      tasks: [{ id: "task-2", subject: "Project task", status: "pending" }],
      summary: null,
    }
    payloads["/ci-watches"] = { active: ["watch-1"] }
    payloads["/sessions/projects"] = {
      projects: [
        {
          cwd: "/project",
          name: "Project",
          lastSeenAt: 1,
          sessionCount: 1,
          sessions: [{ id: "first", mtime: 1 }],
        },
      ],
    }
    payloads["/metrics"] = { ...(payloads["/metrics"] as object), totalDispatches: 5 }
    await tick()
    const messages = latest.sessionMessages
    expect(latest.sessionTasks[0]?.subject).toBe("Changed")
    expect(latest.projectTasks[0]?.subject).toBe("Project task")
    expect(latest.watchCount).toBe(1)
    expect(latest.m.totalDispatches).toBe(5)
    expect(latest.visibleProjects[0]?.name).toBe("Project")
    const tasks = latest.sessionTasks
    const projectTasks = latest.projectTasks
    const metrics = latest.m
    const projects = latest.visibleProjects
    await tick()
    expect(latest.sessionTasks).toBe(tasks)
    expect(latest.projectTasks).toBe(projectTasks)
    expect(latest.m).toBe(metrics)
    expect(latest.visibleProjects).toBe(projects)
    expect(latest.sessionMessages).toBe(messages)
  })

  it("ignores object property order without suppressing tool-only content changes", async () => {
    const messages = latest.sessionMessages
    const baseline = renders
    payloads["/sessions/messages"] = {
      ...(payloads["/sessions/messages"] as object),
      messages: [{ text: "Before", timestamp: "2026-09-06T00:00:00Z", role: "assistant" }],
    }
    await tick()
    expect(renders).toBe(baseline)
    expect(latest.sessionMessages).toBe(messages)
    payloads["/sessions/messages"] = {
      ...(payloads["/sessions/messages"] as object),
      messages: [{ ...messages[0], toolCalls: [{ name: "Read", detail: "changed input" }] }],
    }
    const rows = rowRenders.mock.calls.length
    await tick()
    expect(container.textContent).toContain("changed input")
    expect(rowRenders.mock.calls.length).toBeGreaterThan(rows)
  })
})
