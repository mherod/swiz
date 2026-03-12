import { useMemo } from "react"
import { formatLastActivity } from "../lib/dashboard-helpers.ts"
import type { ActiveHookDispatch } from "../lib/dashboard-hooks.ts"
import type { ToolStat } from "./session-browser.tsx"

interface EventMetric {
  name: string
  count: number
  avgMs: number
}

interface CacheSummary {
  snapshotCacheSize?: number
  ghCacheSize?: number
  eligibilityCacheSize?: number
  transcriptIndexSize?: number
  cooldownRegistrySize?: number
  gitStateCacheSize?: number
  projectSettingsCacheSize?: number
  manifestCacheSize?: number
}

interface SessionHealth {
  dispatches?: number
  lastMessageAt?: number
  mtime: number
}

function isInternalToolName(name: string): boolean {
  return name.trim().toLowerCase() === "structuredoutput"
}

interface ProjectPerformanceStatsProps {
  totalDispatches: number
  avgLatency: number
  hottestEvent: string
}

function ProjectPerformanceStats({
  totalDispatches,
  avgLatency,
  hottestEvent,
}: ProjectPerformanceStatsProps) {
  return (
    <>
      <div className="metric-kpis">
        {totalDispatches > 0 && (
          <span className="metric-kpi">
            <strong>{totalDispatches}</strong> total
          </span>
        )}
        {avgLatency > 0 && (
          <span className="metric-kpi">
            <strong>{avgLatency}ms</strong> avg
          </span>
        )}
        {hottestEvent !== "n/a" && (
          <span className="metric-kpi">
            <strong>{hottestEvent}</strong> hottest
          </span>
        )}
      </div>
      <p className="metric-note">Performance metrics for the current project scope.</p>
    </>
  )
}

interface CurrentSessionStatsProps {
  activeSession: SessionHealth | null
  loadedMessageCount: number
  totalToolCalls: number
  activeDispatch: ActiveHookDispatch | null
  activeRuntimeSeconds: number
}

function CurrentSessionStats({
  activeSession,
  loadedMessageCount,
  totalToolCalls,
  activeDispatch,
  activeRuntimeSeconds,
}: CurrentSessionStatsProps) {
  return (
    <>
      <div className="metric-kpis">
        {(activeSession?.dispatches ?? 0) > 0 && (
          <span className="metric-kpi">
            <strong>{activeSession?.dispatches}</strong> dispatches
          </span>
        )}
        {loadedMessageCount > 0 && (
          <span className="metric-kpi">
            <strong>{loadedMessageCount}</strong> messages
          </span>
        )}
        {totalToolCalls > 0 && (
          <span className="metric-kpi">
            <strong>{totalToolCalls}</strong> tool calls
          </span>
        )}
      </div>
      {activeDispatch && (
        <div className="stats-active-badge">
          <span className="session-active-pulse" />
          <span className="stats-active-text">
            {activeDispatch.toolName ? (
              <>
                Running <strong>{activeDispatch.toolName}</strong>
              </>
            ) : (
              <>
                Processing <strong>{activeDispatch.canonicalEvent}</strong>
              </>
            )}
            <span className="stats-active-time"> · {activeRuntimeSeconds}s</span>
          </span>
        </div>
      )}
      <p className="metric-note">
        Last activity:{" "}
        {formatLastActivity(activeSession?.lastMessageAt ?? activeSession?.mtime ?? null)}
      </p>
    </>
  )
}

export function DashboardStats({
  events = [],
  cache: _cache = {},
  activeSession,
  activeHookDispatches,
  loadedMessageCount,
  sessionToolStats,
}: {
  events?: EventMetric[]
  cache?: CacheSummary
  activeSession: SessionHealth | null
  activeHookDispatches: ActiveHookDispatch[]
  loadedMessageCount: number
  sessionToolStats: ToolStat[]
}) {
  // Performance logic
  const totalDispatches = useMemo(
    () => events.reduce((sum, event) => sum + event.count, 0),
    [events]
  )
  const avgLatency = useMemo(
    () =>
      events.length
        ? Math.round(events.reduce((sum, event) => sum + event.avgMs, 0) / events.length)
        : 0,
    [events]
  )
  const hottestEvent = events[0]?.name ?? "n/a"

  // Session logic
  const visibleToolStats = sessionToolStats.filter((stat) => !isInternalToolName(stat.name))
  const activeDispatch = activeHookDispatches[0] ?? null
  const totalToolCalls = visibleToolStats.reduce((sum, stat) => sum + stat.count, 0)
  const activeRuntimeSeconds = activeDispatch
    ? Math.max(0, Math.round((Date.now() - activeDispatch.startedAt) / 1000))
    : 0

  return (
    <div className="panel-dashboard-stats">
      <div className="stats-grid">
        <div className="stats-group">
          <h3 className="stats-group-title">Current Session</h3>
          <CurrentSessionStats
            activeSession={activeSession}
            loadedMessageCount={loadedMessageCount}
            totalToolCalls={totalToolCalls}
            activeDispatch={activeDispatch}
            activeRuntimeSeconds={activeRuntimeSeconds}
          />
        </div>

        <div className="stats-divider" />

        <div className="stats-group">
          <h3 className="stats-group-title">Project Performance</h3>
          <ProjectPerformanceStats
            totalDispatches={totalDispatches}
            avgLatency={avgLatency}
            hottestEvent={hottestEvent}
          />
        </div>
      </div>
    </div>
  )
}
