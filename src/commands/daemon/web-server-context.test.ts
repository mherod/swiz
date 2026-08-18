import { describe, expect, test } from "bun:test"
import {
  buildCacheRoutesContext,
  buildCiRoutesContext,
  buildComplianceRoutesContext,
  buildIssueRoutesContext,
  buildMetricsRoutesContext,
  buildSessionRoutesContext,
  buildSettingsRoutesContext,
  type DaemonWebServerContext,
} from "./web-server-context.ts"

function createSentinelContext(): DaemonWebServerContext {
  const sentinels = new Map<PropertyKey, unknown>()
  return new Proxy<Record<PropertyKey, unknown>>(
    {},
    {
      get: (_target, key) => {
        if (!sentinels.has(key)) sentinels.set(key, Object.freeze({ key }))
        return sentinels.get(key)
      },
    }
  ) as unknown as DaemonWebServerContext
}

function expectDirectContextSubset(
  source: DaemonWebServerContext,
  result: object,
  keys: readonly (keyof DaemonWebServerContext)[]
): void {
  expect(Object.keys(result).sort()).toEqual([...keys].sort())
  const output = result as Record<string, unknown>
  for (const key of keys) {
    expect(output[key]).toBe(source[key])
  }
}

describe("web server route context builders", () => {
  test("buildCacheRoutesContext returns only cache route capabilities", () => {
    const source = createSentinelContext()
    const keys = [
      "ghCache",
      "eligibilityCache",
      "transcriptIndex",
      "cooldownRegistry",
      "gitStateCache",
      "lastUserMessageCache",
      "ciWatchRegistry",
      "projectSettingsCache",
      "manifestCache",
      "touchProject",
      "registerProjectWatchers",
      "snapshots",
      "watchers",
    ] as const satisfies readonly (keyof DaemonWebServerContext)[]

    expectDirectContextSubset(source, buildCacheRoutesContext(source), keys)
  })

  test("buildSessionRoutesContext exposes the complete session route contract", () => {
    const source = createSentinelContext()
    const result = buildSessionRoutesContext(source)

    expect(Object.keys(result).sort()).toEqual(
      [
        "touchProject",
        "registerProjectWatchers",
        "getKnownProjects",
        "getProjectLastSeen",
        "getProjectStatusLine",
        "listProjectSessions",
        "getSessionData",
        "getSessionTasks",
        "getProjectTasks",
        "getAgentProcessSnapshot",
      ].sort()
    )
    expect(result.touchProject).toBe(source.touchProject)
    expect(result.registerProjectWatchers).toBe(source.registerProjectWatchers)
    expect(result.getKnownProjects).toBeFunction()
    expect(result.getProjectLastSeen).toBeFunction()
    expect(result.getProjectStatusLine).toBeFunction()
    expect(result.listProjectSessions).toBeFunction()
    expect(result.getSessionData).toBeFunction()
    expect(result.getSessionTasks).toBeFunction()
    expect(result.getProjectTasks).toBeFunction()
    expect(result.getAgentProcessSnapshot).toBeFunction()
  })

  test("buildCiRoutesContext returns only CI route capabilities", () => {
    const source = createSentinelContext()
    const keys = [
      "ciWatchRegistry",
      "touchProject",
      "registerProjectWatchers",
    ] as const satisfies readonly (keyof DaemonWebServerContext)[]

    expectDirectContextSubset(source, buildCiRoutesContext(source), keys)
  })

  test("buildIssueRoutesContext returns only issue route capabilities", () => {
    const source = createSentinelContext()
    const keys = [
      "touchProject",
      "registerProjectWatchers",
      "upstreamSyncRegistry",
    ] as const satisfies readonly (keyof DaemonWebServerContext)[]

    expectDirectContextSubset(source, buildIssueRoutesContext(source), keys)
  })

  test("buildSettingsRoutesContext returns only settings route capabilities", () => {
    const source = createSentinelContext()
    const keys = [
      "touchProject",
      "registerProjectWatchers",
      "projectSettingsCache",
      "manifestCache",
    ] as const satisfies readonly (keyof DaemonWebServerContext)[]

    expectDirectContextSubset(source, buildSettingsRoutesContext(source), keys)
  })

  test("buildComplianceRoutesContext returns only compliance route capabilities", () => {
    const source = createSentinelContext()
    const keys = [
      "taskStateCache",
      "resolveSnapshot",
      "sessionComplianceState",
      "upstreamSyncRegistry",
    ] as const satisfies readonly (keyof DaemonWebServerContext)[]

    expectDirectContextSubset(source, buildComplianceRoutesContext(source), keys)
  })

  test("buildMetricsRoutesContext returns only metrics route capabilities", () => {
    const source = createSentinelContext()
    const keys = [
      "ghCache",
      "transcriptIndex",
      "eligibilityCache",
      "cooldownRegistry",
      "gitStateCache",
      "projectSettingsCache",
      "manifestCache",
      "snapshots",
      "projectMetrics",
      "globalMetrics",
      "watchers",
    ] as const satisfies readonly (keyof DaemonWebServerContext)[]

    expectDirectContextSubset(source, buildMetricsRoutesContext(source), keys)
  })
})
