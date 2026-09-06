export interface DashboardClockSnapshot {
  uptime: string
  lastUpdated: string
}

/** Per-dashboard clock; only the header subscribes to these volatile values. */
export function createDashboardClock(): {
  getSnapshot: () => DashboardClockSnapshot
  subscribe: (listener: () => void) => () => void
  setUptime: (uptime: string) => void
  setLastUpdated: (lastUpdated: string) => void
} {
  let snapshot = { uptime: "starting", lastUpdated: "starting" }
  const listeners = new Set<() => void>()
  const update = (next: DashboardClockSnapshot) => {
    if (next.uptime === snapshot.uptime && next.lastUpdated === snapshot.lastUpdated) return
    snapshot = next
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    setUptime: (uptime) => update({ ...snapshot, uptime }),
    setLastUpdated: (lastUpdated) => update({ ...snapshot, lastUpdated }),
  }
}

export type DashboardClock = ReturnType<typeof createDashboardClock>
