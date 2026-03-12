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

export function DashboardStats({
  events = [],
  cache = {},
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

  // Cache logic
  const cacheEntries = [
    { label: "Snapshots", value: cache.snapshotCacheSize ?? 0 },
    { label: "GitHub", value: cache.ghCacheSize ?? 0 },
    { label: "Eligibility", value: cache.eligibilityCacheSize ?? 0 },
    { label: "Transcripts", value: cache.transcriptIndexSize ?? 0 },
    { label: "Cooldown", value: cache.cooldownRegistrySize ?? 0 },
    { label: "Git state", value: cache.gitStateCacheSize ?? 0 },
    { label: "Settings", value: cache.projectSettingsCacheSize ?? 0 },
    { label: "Manifest", value: cache.manifestCacheSize ?? 0 },
  ]
  const totalCacheEntries = cacheEntries.reduce((sum, item) => sum + item.value, 0)
  const warmCaches = cacheEntries.filter((item) => item.value > 0).length

  // Session logic
  const visibleToolStats = sessionToolStats.filter((stat) => !isInternalToolName(stat.name))
  const activeDispatch = activeHookDispatches[0] ?? null
  const totalToolCalls = visibleToolStats.reduce((sum, stat) => sum + stat.count, 0)
  const activeRuntimeSeconds = activeDispatch
    ? Math.max(0, Math.round((Date.now() - activeDispatch.startedAt) / 1000))
    : 0

  return (
    <section className="card panel-dashboard-stats">
      <div className="stats-header">
        <h2 className="section-title">Dashboard Overview</h2>
        <p className="section-subtitle">Real-time session, performance and system metrics</p>
      </div>

      <div className="stats-grid">
        <div className="stats-group">
          <h3 className="stats-group-title">Current Session</h3>
          <div className="metric-kpis">
            <span className="metric-kpi">
              <strong>{activeSession?.dispatches ?? 0}</strong> dispatches
            </span>
            <span className="metric-kpi">
              <strong>{loadedMessageCount}</strong> messages
            </span>
            <span className="metric-kpi">
              <strong>{totalToolCalls}</strong> tool calls
            </span>
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
        </div>

        <div className="stats-divider" />

        <div className="stats-group">
          <h3 className="stats-group-title">Project Performance</h3>
          <div className="metric-kpis">
            <span className="metric-kpi">
              <strong>{totalDispatches}</strong> total
            </span>
            <span className="metric-kpi">
              <strong>{avgLatency}ms</strong> avg
            </span>
            <span className="metric-kpi">
              <strong>{hottestEvent}</strong> hottest
            </span>
          </div>
          <p className="metric-note">Performance metrics for the current project scope.</p>
        </div>

        <div className="stats-divider" />

        <div className="stats-group">
          <h3 className="stats-group-title">Daemon Caches</h3>
          <div className="metric-kpis">
            <span className="metric-kpi">
              <strong>{totalCacheEntries}</strong> entries
            </span>
            <span className="metric-kpi">
              <strong>{warmCaches}</strong> warm
            </span>
          </div>
          <p className="metric-note">System-wide cache warmth and health.</p>
        </div>
      </div>
    </section>
  )
}
