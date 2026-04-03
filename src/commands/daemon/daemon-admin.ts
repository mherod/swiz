import { stderrLog } from "../../debug.ts"
import { isLaunchAgentLoaded, launchAgentExists, SWIZ_DAEMON_LABEL } from "../../launch-agents.ts"

export const DAEMON_PORT = 7_943

/** Resolve the daemon port from `SWIZ_DAEMON_PORT` env var, falling back to {@link DAEMON_PORT}. */
export function getDaemonPort(): number {
  const raw = process.env.SWIZ_DAEMON_PORT
  if (!raw) return DAEMON_PORT
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DAEMON_PORT
}

export async function fetchDaemonStatus(port: number): Promise<void> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/metrics`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!resp.ok) {
      stderrLog("daemon-status", `Daemon returned ${resp.status}`)
      process.exitCode = 1
      return
    }
    const data = (await resp.json()) as {
      uptimeHuman: string
      totalDispatches: number
      byEvent: Record<string, { count: number; avgMs: number }>
      projects?: Record<
        string,
        {
          uptimeHuman: string
          totalDispatches: number
          byEvent: Record<string, { count: number; avgMs: number }>
        }
      >
    }
    console.log(`Daemon uptime: ${data.uptimeHuman}`)
    console.log(`Total dispatches: ${data.totalDispatches}`)
    const events = Object.entries(data.byEvent)
    if (events.length > 0) {
      console.log("\nDispatches by event:")
      for (const [event, m] of events.sort((a, b) => b[1].count - a[1].count)) {
        console.log(`  ${event}: ${m.count} (avg ${m.avgMs}ms)`)
      }
    }
    if (data.projects) {
      const projectEntries = Object.entries(data.projects)
      if (projectEntries.length > 0) {
        console.log(`\nProjects: ${projectEntries.length}`)
        for (const [cwd, pm] of projectEntries) {
          console.log(`  ${cwd}: ${pm.totalDispatches} dispatches`)
        }
      }
    }
  } catch {
    stderrLog("daemon-status", `Daemon not reachable on port ${port}`)
    process.exitCode = 1
  }
}

export type DaemonStatus =
  | { installed: false; loaded: false; healthy: false }
  | { installed: true; loaded: false; healthy: false }
  | { installed: true; loaded: true; healthy: false }
  | { installed: true; loaded: true; healthy: true }

/**
 * Detect daemon readiness by checking three layers in order:
 * 1. Plist file exists on disk
 * 2. LaunchAgent is loaded in launchctl
 * 3. HTTP health endpoint responds
 *
 * Each check short-circuits — if the plist doesn't exist, we skip
 * the subprocess call to launchctl and the network fetch entirely.
 */
export async function getDaemonStatus(
  port: number = getDaemonPort(),
  healthTimeoutMs: number = 500
): Promise<DaemonStatus> {
  if (!(await launchAgentExists(SWIZ_DAEMON_LABEL))) {
    return { installed: false, loaded: false, healthy: false }
  }

  if (!(await isLaunchAgentLoaded(SWIZ_DAEMON_LABEL))) {
    return { installed: true, loaded: false, healthy: false }
  }

  try {
    const resp = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(healthTimeoutMs),
    })
    if (resp.ok) {
      return { installed: true, loaded: true, healthy: true }
    }
  } catch {
    // Health check failed — daemon loaded but not responding
  }

  return { installed: true, loaded: true, healthy: false }
}

/**
 * Fast-path check: is the daemon installed, loaded, and responding?
 * Use this to decide whether to attempt daemon dispatch or skip to local fallback.
 */
export async function isDaemonReady(
  port: number = getDaemonPort(),
  healthTimeoutMs: number = 500
): Promise<boolean> {
  const status = await getDaemonStatus(port, healthTimeoutMs)
  return status.healthy
}
