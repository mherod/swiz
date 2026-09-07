import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { appendFile } from "node:fs/promises"
import { join } from "node:path"
import { Window } from "happy-dom"
import { act, Profiler } from "react"
import { createRoot, type Root } from "react-dom/client"
import { SessionDataCache, scopeRevisionToWindow } from "../../commands/daemon/session-data.ts"
import { sessionUsageLine } from "../../commands/daemon/test-fixtures/session.ts"
import { useTempDir } from "../../utils/test-utils.ts"
import { Header } from "../components/header.tsx"
import { ProjectIssuesPanel } from "../components/project-issues-panel.tsx"
import * as browserUtils from "../components/session-browser-utils.ts"
import { SessionMessages } from "../components/session-messages.tsx"
import { LogsView } from "../components/views/logs-view.tsx"
import { type DashboardState, useDashboardState } from "./dashboard-state.ts"

let window: Window
let root: Root
let container: HTMLElement
let latest: DashboardState
let renders: number
let headerRenders: number
let payloads: Record<string, unknown>
let deferSession: string | null
const requests: Array<{ url: string; signal: AbortSignal | null | undefined }> = []
const deferred: Array<() => void> = []
let nextIntervalId = 0
const intervals = new Map<number, () => void>()
const globals = new Map<string, PropertyDescriptor | undefined>()
let restoreMocks: Array<() => void> = []
let rowRenders: ReturnType<typeof spyOn<typeof browserUtils, "formatTime">>
const transcriptHomes = useTempDir("swiz-dashboard-telemetry-")

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
      {latest.activeView === "dashboard" || latest.activeView === "issues" ? (
        <ProjectIssuesPanel cwd={latest.optimisticProjectCwd} />
      ) : null}
      {latest.activeView === "logs" ? <LogsView /> : null}
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

async function setVisibility(value: "hidden" | "visible") {
  await act(async () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value })
    window.document.dispatchEvent(new window.Event("visibilitychange"))
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
  requests.length = 0
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
    "/projects/issues": { repo: null, issues: [] },
    "/api/hook-logs?limit=300": { entries: [] },
  }
  const respond = async (...[input, init]: Parameters<typeof fetch>): Promise<Response> => {
    const url = String(input)
    requests.push({ url, signal: init?.signal })
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
  it("uses real cache revisions for telemetry, content, token removal and selection changes", async () => {
    const home = await transcriptHomes.create()
    const session = { path: join(home, "session.jsonl"), format: "codex-jsonl" as const }
    const cache = new SessionDataCache()
    const message = (text: string) =>
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-09-07T10:00:00Z",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
      })
    const publish = async () => {
      const value = (await cache.get(session, home))!
      expect(value).not.toBeNull()
      payloads["/sessions/messages"] = {
        messages: value.messages,
        toolStats: value.toolStats,
        tokenStats: value.tokenStats,
        revision: scopeRevisionToWindow(value.contentRevision, 150),
      }
      return value
    }
    await Bun.write(session.path, `${message("Cache message")}\n${sessionUsageLine(10)}\n`)
    const initial = await publish()
    await tick()
    const messages = latest.sessionMessages
    const highlights = latest.newMessageKeys
    const rows = rowRenders.mock.calls.length
    await appendFile(session.path, `${sessionUsageLine(20)}\n`)
    const telemetry = await publish()
    expect(telemetry.contentRevision).toBe(initial.contentRevision)
    expect(telemetry.messages).toBe(initial.messages)
    await tick()
    expect(latest.sessionTokenStats?.outputTokens).toBe(20)
    expect(latest.sessionMessages).toBe(messages)
    expect(latest.newMessageKeys).toBe(highlights)
    expect(rowRenders.mock.calls.length).toBe(rows)
    const unchangedRenders = renders
    await publish()
    await tick()
    expect(renders).toBe(unchangedRenders)

    await appendFile(session.path, `${message("Actual new text")}\n`)
    expect((await publish()).contentRevision).not.toBe(initial.contentRevision)
    await tick()
    expect(container.textContent).toContain("Actual new text")
    expect(rowRenders.mock.calls.length).toBeGreaterThan(rows)
    await appendFile(
      session.path,
      `${JSON.stringify({
        type: "response_item",
        timestamp: "2026-09-07T10:01:00Z",
        payload: {
          type: "function_call",
          name: "Read",
          arguments: JSON.stringify({ file_path: "Actual.ts" }),
        },
      })}\n`
    )
    await publish()
    await tick()
    expect(container.textContent).toContain("Actual.ts")

    await Bun.write(session.path, `${message("Cache message")}\n`)
    await publish()
    await tick()
    expect(latest.sessionTokenStats).toBeNull()
    for (const project of ["/project", "/other"]) {
      session.path = join(home, `${project.slice(1)}.jsonl`)
      await Bun.write(session.path, `${message(project)}\n${sessionUsageLine(30)}\n`)
      await publish()
      await act(async () => {
        latest.handleSelectSession(project, project.slice(1))
        await settle()
      })
      expect(latest.sessionTokenStats?.outputTokens).toBe(30)
      expect(latest.sessionMessages[0]?.text).toBe(project)
    }
  })

  it.each([
    "settings",
    "issues",
    "logs",
  ] as const)("does not request session data on the %s panel, including manual selection", async (view) => {
    await act(async () => {
      latest.setActiveView(view)
      await settle()
    })
    requests.length = 0
    await act(async () => {
      latest.handleSelectSession("/project", "second")
      await settle()
    })
    await tick()
    expect(
      requests.filter(({ url }) =>
        ["/sessions/messages", "/sessions/tasks", "/projects/tasks"].includes(url)
      )
    ).toEqual([])
  })

  it.each([
    ["transcript", ["/sessions/messages"]],
    ["tasks", ["/sessions/tasks", "/projects/tasks"]],
    ["dashboard", ["/sessions/messages", "/sessions/tasks", "/projects/tasks"]],
  ] as const)("requests only the %s data families", async (view, expected) => {
    await act(async () => {
      latest.setActiveView(view)
      await settle()
    })
    requests.length = 0
    await tick()
    expect(
      requests
        .map(({ url }) => url)
        .filter((url) => ["/sessions/messages", "/sessions/tasks", "/projects/tasks"].includes(url))
        .sort()
    ).toEqual([...expected].sort())
  })

  it("suspends hidden polling and resumes each endpoint once immediately", async () => {
    await setVisibility("hidden")
    requests.length = 0
    await tick()
    expect(requests).toHaveLength(0)
    await setVisibility("visible")
    expect(requests.filter(({ url }) => url === "/metrics")).toHaveLength(1)
    expect(requests.filter(({ url }) => url === "/sessions/messages")).toHaveLength(1)
    expect(requests.filter(({ url }) => url === "/projects/tasks")).toHaveLength(1)
    expect(requests.filter(({ url }) => url === "/projects/issues")).toHaveLength(1)
    const count = requests.length
    await setVisibility("visible")
    expect(requests).toHaveLength(count)
  })

  it("starts hidden without requests or intervals and refreshes on visibility", async () => {
    await act(async () => root.unmount())
    await setVisibility("hidden")
    requests.length = 0
    root = createRoot(container)
    await act(async () => {
      root.render(<Harness />)
      await settle()
    })
    expect(requests).toHaveLength(0)
    expect(intervals.size).toBe(0)
    await setVisibility("visible")
    expect(requests.filter(({ url }) => url === "/sessions/messages")).toHaveLength(1)
  })

  it("refreshes project tasks without a selected session", async () => {
    await act(async () => {
      latest.setActiveView("tasks")
      await settle()
      latest.handleSelectProject("/empty")
      await settle()
    })
    requests.length = 0
    await tick()
    expect(latest.optimisticSessionId).toBeNull()
    expect(requests.filter(({ url }) => url === "/projects/tasks")).toHaveLength(1)
    expect(
      requests.filter(({ url }) => url.startsWith("/sessions/") && url !== "/sessions/projects")
    ).toHaveLength(0)
  })

  it("keeps manual log refresh working while hiding and unmounting cancel its work", async () => {
    await act(async () => {
      latest.setActiveView("logs")
      await settle()
    })
    requests.length = 0
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".logs-refresh")?.click()
      await settle()
    })
    expect(requests.filter(({ url }) => url.startsWith("/api/hook-logs"))).toHaveLength(1)
    const signals = requests.map(({ signal }) => signal)
    await setVisibility("hidden")
    expect(signals.every((signal) => signal?.aborted)).toBe(true)
    requests.length = 0
    await tick()
    expect(requests).toHaveLength(0)
    await setVisibility("visible")
    expect(requests.filter(({ url }) => url.startsWith("/api/hook-logs"))).toHaveLength(1)
    const resumed = requests.map(({ signal }) => signal)
    await act(async () => root.unmount())
    expect(resumed.every((signal) => signal?.aborted)).toBe(true)
  })

  it("coalesces pending polls and aborts requests when their panel becomes irrelevant", async () => {
    deferSession = "first"
    requests.length = 0
    await tick()
    await tick()
    const messages = requests.filter(({ url }) => url === "/sessions/messages")
    expect(messages).toHaveLength(1)
    await act(async () => {
      latest.setActiveView("tasks")
      await settle()
    })
    expect(messages[0]?.signal?.aborted).toBe(true)
    await act(async () => {
      for (const resolve of deferred) resolve()
      await settle()
    })
  })

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
    const oldRequests = requests.filter(({ url }) => url === "/sessions/messages")
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
    expect(oldRequests.every(({ signal }) => signal?.aborted)).toBe(true)
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
