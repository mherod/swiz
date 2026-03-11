import type { EventMetric } from "../lib/dashboard-helpers.ts"
import type { ActiveHookDispatch } from "../lib/dashboard-hooks.ts"
import { CacheList } from "./cache-list.tsx"
import { EventTable } from "./event-table.tsx"
import { ProjectSettingsCard } from "./project-settings-card.tsx"
import type { ToolStat } from "./session-browser.tsx"
import { SessionHealthCard } from "./session-health-card.tsx"

interface SessionHealth {
  dispatches?: number
  lastMessageAt?: number
  mtime: number
}

export function MetricsRail({
  events,
  scope,
  cacheStatus,
  selectedProjectCwd,
  activeSession,
  activeHookDispatches,
  loadedMessageCount,
  sessionToolStats,
}: {
  events: EventMetric[]
  scope: "global" | "project"
  cacheStatus: Record<string, number> | null
  selectedProjectCwd: string | null
  activeSession: SessionHealth | null
  activeHookDispatches: ActiveHookDispatch[]
  loadedMessageCount: number
  sessionToolStats: ToolStat[]
}) {
  return (
    <aside className="bento-metrics-stack" aria-label="Metrics panels">
      <EventTable events={events} scope={scope} />
      <CacheList cache={cacheStatus ?? {}} />
      <ProjectSettingsCard cwd={selectedProjectCwd} />
      <SessionHealthCard
        activeSession={activeSession}
        activeHookDispatches={activeHookDispatches}
        loadedMessageCount={loadedMessageCount}
        sessionToolStats={sessionToolStats}
      />
    </aside>
  )
}
