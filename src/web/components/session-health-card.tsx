import { formatLastActivity } from "../lib/dashboard-helpers.ts"
import type { ActiveHookDispatch } from "../lib/dashboard-hooks.ts"
import type { ToolStat } from "./session-browser.tsx"

interface SessionHealth {
  dispatches?: number
  lastMessageAt?: number
  mtime: number
}

function isInternalToolName(name: string): boolean {
  return name.trim().toLowerCase() === "structuredoutput"
}

export function SessionHealthCard({
  activeSession,
  activeHookDispatches,
  loadedMessageCount,
  sessionToolStats,
}: {
  activeSession: SessionHealth | null
  activeHookDispatches: ActiveHookDispatch[]
  loadedMessageCount: number
  sessionToolStats: ToolStat[]
}) {
  const visibleToolStats = sessionToolStats.filter((stat) => !isInternalToolName(stat.name))
  const activeDispatch = activeHookDispatches[0] ?? null
  const activeHooks = activeDispatch?.hooks ?? []
  const totalToolCalls = visibleToolStats.reduce((sum, stat) => sum + stat.count, 0)
  const uniqueToolCount = visibleToolStats.length
  const topTool = visibleToolStats[0] ?? null
  const activeRuntimeSeconds = activeDispatch
    ? Math.max(0, Math.round((Date.now() - activeDispatch.startedAt) / 1000))
    : 0
  return (
    <section className="card panel-health">
      <h2 className="section-title">Session health</h2>
      <p className="section-subtitle">Selected session quick status</p>
      <div className="metric-kpis">
        <span className="metric-kpi">
          <strong>{activeSession?.dispatches ?? 0}</strong> dispatches
        </span>
        <span className="metric-kpi">
          <strong>{loadedMessageCount}</strong> loaded msgs
        </span>
        <span className="metric-kpi">
          <strong>{totalToolCalls}</strong> tool calls
        </span>
        <span className="metric-kpi">
          <strong>{uniqueToolCount}</strong> tool types
        </span>
      </div>
      {topTool ? (
        <p className="metric-note">
          Top tool: <strong>{topTool.name}</strong> ({topTool.count})
        </p>
      ) : null}
      <p className="panel-health-meta">
        Last activity:{" "}
        {formatLastActivity(activeSession?.lastMessageAt ?? activeSession?.mtime ?? null)}
      </p>
      {activeDispatch ? (
        <div className="panel-health-hook-activity">
          <p className="panel-health-hook-title">Active hooks ({activeHooks.length})</p>
          <p className="panel-health-hook-meta">
            {activeDispatch.canonicalEvent} · {activeRuntimeSeconds}s
            {activeDispatch.sessionId ? ` · ${activeDispatch.sessionId.slice(0, 8)}…` : ""}
          </p>
          <ul className="panel-health-hook-list">
            {activeHooks.slice(0, 4).map((hook) => (
              <li key={hook} className="panel-health-hook-item">
                {hook}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
