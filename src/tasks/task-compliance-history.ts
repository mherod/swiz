import { getDaemonPort } from "../commands/daemon/daemon-admin.ts"

export type ComplianceState = "healthy" | "unhealthy"

export interface ComplianceEntry {
  state: ComplianceState
  at: number
}

interface ComplianceCounts {
  incomplete: number
  pending: number
  inProgress: number
}

export function computeComplianceState(counts: ComplianceCounts): ComplianceState {
  if (counts.inProgress >= 1 && counts.pending >= 1 && counts.incomplete >= 2) return "healthy"
  return "unhealthy"
}

export function formatComplianceDuration(entry: ComplianceEntry): string {
  const ms = Date.now() - entry.at
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m`
  return `${Math.floor(mins / 60)}h`
}

/** Fire-and-forget POST to daemon to record compliance state. Silent on failure. */
export async function recordComplianceState(
  sessionId: string,
  counts: ComplianceCounts
): Promise<boolean> {
  const state = computeComplianceState(counts)
  const port = getDaemonPort()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/compliance/record`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, state, at: Date.now() }),
      signal: AbortSignal.timeout(500),
    })
    if (!res.ok) return false
    const data = (await res.json()) as { transitioned?: boolean }
    return data.transitioned === true
  } catch {
    return false
  }
}

/** Read current compliance entry from daemon. Returns null when daemon is down. */
export async function getCurrentComplianceEntry(
  sessionId: string
): Promise<ComplianceEntry | null> {
  const port = getDaemonPort()
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/compliance/current?sessionId=${encodeURIComponent(sessionId)}`,
      { signal: AbortSignal.timeout(500) }
    )
    if (!res.ok) return null
    const data = (await res.json()) as { current?: ComplianceEntry | null }
    return data?.current ?? null
  } catch {
    return null
  }
}
