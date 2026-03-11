import type { EventMetric } from "../lib/dashboard-helpers.ts"
import { CacheList } from "./cache-list.tsx"
import { EventTable } from "./event-table.tsx"
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
  activeSession,
  loadedMessageCount,
  sessionToolStats,
}: {
  events: EventMetric[]
  scope: "global" | "project"
  cacheStatus: Record<string, number> | null
  activeSession: SessionHealth | null
  loadedMessageCount: number
  sessionToolStats: ToolStat[]
}) {
  return (
    <aside className="bento-metrics-stack" aria-label="Metrics panels">
      <EventTable events={events} scope={scope} />
      <CacheList cache={cacheStatus ?? {}} />
      <SessionHealthCard
        activeSession={activeSession}
        loadedMessageCount={loadedMessageCount}
        sessionToolStats={sessionToolStats}
      />
    </aside>
  )
}
