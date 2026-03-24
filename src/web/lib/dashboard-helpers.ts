import type { ProjectSessions, SessionMessage } from "../components/session-browser.tsx"

export interface EventMetric {
  name: string
  count: number
  avgMs: number
}

export function toSortedEvents(
  byEvent: Record<string, { count?: number; avgMs?: number }> | undefined
): EventMetric[] {
  return Object.entries(byEvent ?? {})
    .map(([name, data]) => ({
      name,
      count: data.count ?? 0,
      avgMs: data.avgMs ?? 0,
    }))
    .sort((a, b) => b.count - a.count)
}

export function getQueryParam(key: string): string | null {
  return new URLSearchParams(window.location.search).get(key)
}

export function setQueryParams(params: Record<string, string | null>): void {
  const url = new URL(window.location.href)
  for (const [key, value] of Object.entries(params)) {
    if (value === null) url.searchParams.delete(key)
    else url.searchParams.set(key, value)
  }
  window.history.replaceState(null, "", url.toString())
}

export function msgKey(msg: SessionMessage, i: number): string {
  return `${msg.role}-${msg.timestamp ?? "null"}-${i}`
}

export function hasProjectMessages(project: ProjectSessions): boolean {
  return project.sessions.some(
    (session) => Boolean(session.lastMessageAt) || (session.dispatches ?? 0) > 0
  )
}

export function formatLastActivity(ts: number | null): string {
  if (!ts) return "No activity"
  return new Date(ts).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}
