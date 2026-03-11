import { formatLastActivity } from "../lib/dashboard-helpers.ts"
import type { ActiveHookDispatch } from "../lib/dashboard-hooks.ts"
import type { ToolStat } from "./session-browser.tsx"

interface SessionHealth {
  dispatches?: number
  lastMessageAt?: number
  mtime: number
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
  const activeDispatch = activeHookDispatches[0] ?? null
  const activeHooks = activeDispatch?.hooks ?? []
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
          <strong>{sessionToolStats.reduce((sum, stat) => sum + stat.count, 0)}</strong> tool calls
        </span>
      </div>
      <p className="panel-health-meta">
        Last activity:{" "}
        {formatLastActivity(activeSession?.lastMessageAt ?? activeSession?.mtime ?? null)}
      </p>
      {activeDispatch ? (
        <div className="panel-health-hook-activity">
          <p className="panel-health-hook-title">Active hooks ({activeHooks.length})</p>
          <p className="panel-health-hook-meta">
            {activeDispatch.canonicalEvent}
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
