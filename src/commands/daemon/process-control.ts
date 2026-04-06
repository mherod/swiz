/**
 * Daemon process lifecycle helpers — PID listing, graceful restart, LaunchAgent management.
 * Extracted from utils.ts for single-responsibility (process control vs session data).
 */

import {
  getLaunchAgentPlistPath,
  isLaunchAgentLoaded,
  launchAgentExists,
  loadLaunchAgent,
  SWIZ_DAEMON_LABEL,
  unloadLaunchAgent,
} from "../../launch-agents.ts"

export async function listDaemonPids(port: number): Promise<number[]> {
  const proc = Bun.spawn(["lsof", "-ti", `tcp:${port}`], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  if (proc.exitCode !== 0) return []
  return [
    ...new Set(
      out
        .split("\n")
        .map((line) => Number(line.trim()))
        .filter((pid) => pid > 0)
    ),
  ]
}

function tryKill(pid: number, signal?: string): void {
  try {
    process.kill(pid, signal)
  } catch {
    // process may have already exited
  }
}

export async function restartDaemonOnPort(
  port: number,
  selfPid: number = process.pid
): Promise<void> {
  const existing = (await listDaemonPids(port)).filter((pid) => pid !== selfPid)
  if (existing.length === 0) return

  for (const pid of existing) {
    tryKill(pid)
  }

  // Give processes a short grace period to exit before forcing.
  for (let attempt = 0; attempt < 6; attempt++) {
    await Bun.sleep(200)
    const remaining = (await listDaemonPids(port)).filter((pid) => pid !== selfPid)
    if (remaining.length === 0) return
    if (attempt === 5) {
      for (const pid of remaining) {
        tryKill(pid, "SIGKILL")
      }
    }
  }

  const finalRemaining = (await listDaemonPids(port)).filter((pid) => pid !== selfPid)
  if (finalRemaining.length > 0) {
    throw new Error(
      `Failed to restart daemon: port ${port} still in use by ${finalRemaining.join(", ")}`
    )
  }
}

export interface RestartDaemonResult {
  mode: "launchagent" | "port"
  hadRunning: boolean
  stoppedCount: number
}

export async function restartDaemon(
  port: number,
  selfPid: number = process.pid
): Promise<RestartDaemonResult> {
  if (await launchAgentExists(SWIZ_DAEMON_LABEL)) {
    const plistPath = getLaunchAgentPlistPath(SWIZ_DAEMON_LABEL)
    const loaded = await isLaunchAgentLoaded(SWIZ_DAEMON_LABEL)
    if (loaded) {
      const unloadExit = await unloadLaunchAgent(plistPath)
      if (unloadExit !== 0) {
        throw new Error(`Failed to unload ${SWIZ_DAEMON_LABEL}`)
      }
    }
    const loadExit = await loadLaunchAgent(plistPath)
    if (loadExit !== 0) {
      throw new Error(`Failed to load ${SWIZ_DAEMON_LABEL}`)
    }
    return {
      mode: "launchagent",
      hadRunning: loaded,
      stoppedCount: loaded ? 1 : 0,
    }
  }

  const existing = (await listDaemonPids(port)).filter((pid) => pid !== selfPid)
  await restartDaemonOnPort(port, selfPid)
  return {
    mode: "port",
    hadRunning: existing.length > 0,
    stoppedCount: existing.length,
  }
}
