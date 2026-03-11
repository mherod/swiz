import { formatLastActivity } from "../lib/dashboard-helpers.ts"
import type { ToolStat } from "./session-browser.tsx"

interface SessionHealth {
  dispatches?: number
  lastMessageAt?: number
  mtime: number
}

export function SessionHealthCard({
  activeSession,
  loadedMessageCount,
  sessionToolStats,
}: {
  activeSession: SessionHealth | null
  loadedMessageCount: number
  sessionToolStats: ToolStat[]
}) {
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
    </section>
  )
}
