import type { ReactElement } from "react"
import type { EventMetric } from "../lib/dashboard-helpers.ts"
import type { ActiveHookDispatch } from "../lib/dashboard-hooks.ts"
import { DashboardStats } from "./dashboard-stats.tsx"
import type { ToolStat } from "./session-browser.tsx"
import type { SessionHealth } from "./session-browser-types.ts"

export function MetricsRail({
  events,
  cacheStatus,
  activeSession,
  activeHookDispatches,
  loadedMessageCount,
  sessionToolStats,
}: {
  events: EventMetric[]
  cacheStatus: Record<string, number> | null
  activeSession: SessionHealth | null
  activeHookDispatches: ActiveHookDispatch[]
  loadedMessageCount: number
  sessionToolStats: ToolStat[]
}): ReactElement {
  return (
    <aside className="bento-metrics-stack" aria-label="Metrics panels">
      <DashboardStats
        events={events}
        cache={cacheStatus ?? {}}
        activeSession={activeSession}
        activeHookDispatches={activeHookDispatches}
        loadedMessageCount={loadedMessageCount}
        sessionToolStats={sessionToolStats}
      />
    </aside>
  )
}
