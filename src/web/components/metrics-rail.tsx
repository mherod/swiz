import type { EventMetric } from "../lib/dashboard-helpers.ts"
import type { ActiveHookDispatch } from "../lib/dashboard-hooks.ts"
import { DashboardStats } from "./dashboard-stats.tsx"
import { ProjectSettingsCard } from "./project-settings-card.tsx"
import type { ToolStat } from "./session-browser.tsx"

interface SessionHealth {
  dispatches?: number
  lastMessageAt?: number
  mtime: number
}

export function MetricsRail({
  events,
  cacheStatus,
  selectedProjectCwd,
  activeSession,
  activeHookDispatches,
  loadedMessageCount,
  sessionToolStats,
}: {
  events: EventMetric[]
  cacheStatus: Record<string, number> | null
  selectedProjectCwd: string | null
  activeSession: SessionHealth | null
  activeHookDispatches: ActiveHookDispatch[]
  loadedMessageCount: number
  sessionToolStats: ToolStat[]
}) {
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
      <ProjectSettingsCard cwd={selectedProjectCwd} />
    </aside>
  )
}
