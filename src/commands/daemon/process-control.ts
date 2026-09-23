/**
 * Daemon process lifecycle helpers — PID listing, graceful restart, LaunchAgent management.
 * Extracted from utils.ts for single-responsibility (process control vs session data).
 */

import {
  bootstrapLaunchAgent,
  type GuiLaunchAgentStatus,
  getLaunchAgentPlistPath,
  inspectGuiLaunchAgent,
  kickstartLaunchAgent,
  type LaunchAgentRuntime,
  SWIZ_DAEMON_LABEL,
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

interface RestartDaemonOptions {
  runtime?: LaunchAgentRuntime
  plistPath?: string
  timeoutMs?: number
  pollMs?: number
  fetchHealth?: (url: string, init: RequestInit) => Promise<Response>
}

function assertReplacementAvailable(status: GuiLaunchAgentStatus): void {
  if (!status.loaded || (status.pid === null && status.lastExitCode)) {
    throw new Error(
      `${status.target} replacement exited before becoming healthy (last exit ${status.lastExitCode ?? "unknown"}). Check the LaunchAgent logs.`
    )
  }
}

/** Return a diagnostic until the HTTP server identifies itself as the replacement. */
async function probeReplacementHealth(
  port: number,
  pid: number,
  deadline: number,
  fetchHealth: NonNullable<RestartDaemonOptions["fetchHealth"]>
): Promise<string | null> {
  try {
    const response = await fetchHealth(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(
        Math.max(1, Math.min(1000, Math.ceil(deadline - performance.now())))
      ),
      cache: "no-store",
      redirect: "error",
    })
    const healthyPid = response.headers.get("x-swiz-daemon-pid")
    await response.body?.cancel()
    // An old listener can remain healthy while launchd is replacing the service.
    if (response.ok && healthyPid === String(pid)) return null
    return `health returned HTTP ${response.status}, PID ${healthyPid ?? "missing"}; expected PID ${pid}`
  } catch (error) {
    return `health request failed: ${error instanceof Error ? error.message : String(error)}`
  }
}

async function waitForReplacement(
  port: number,
  pid: number,
  target: string,
  options: RestartDaemonOptions
): Promise<void> {
  const deadline = performance.now() + (options.timeoutMs ?? 10_000)
  const fetchHealth = options.fetchHealth ?? fetch
  let detail = "replacement has not become healthy"
  while (performance.now() < deadline) {
    const status = await inspectGuiLaunchAgent(SWIZ_DAEMON_LABEL, options.runtime)
    assertReplacementAvailable(status)
    if (status.pid === pid) {
      const healthError = await probeReplacementHealth(port, pid, deadline, fetchHealth)
      if (healthError === null) return
      detail = healthError
    } else {
      detail = `launchd reports PID ${status.pid ?? "none"}; expected replacement PID ${pid}`
    }
    await Bun.sleep(Math.max(0, Math.min(options.pollMs ?? 100, deadline - performance.now())))
  }
  throw new Error(
    `Timed out waiting for ${target} replacement on port ${port}: ${detail}. Check launchctl print ${target} and the LaunchAgent logs.`
  )
}

export async function restartDaemon(
  port: number,
  selfPid: number = process.pid,
  options: RestartDaemonOptions = {}
): Promise<RestartDaemonResult> {
  const plistPath = options.plistPath ?? getLaunchAgentPlistPath(SWIZ_DAEMON_LABEL)
  if (await Bun.file(plistPath).exists()) {
    const previous = await inspectGuiLaunchAgent(SWIZ_DAEMON_LABEL, options.runtime)
    if (!previous.loaded) await bootstrapLaunchAgent(plistPath, options.runtime)
    const pid = await kickstartLaunchAgent(SWIZ_DAEMON_LABEL, options.runtime)
    if (pid === previous.pid) {
      throw new Error(`${previous.target} did not replace PID ${pid}; restart was not completed`)
    }
    await waitForReplacement(port, pid, previous.target, options)
    return {
      mode: "launchagent",
      hadRunning: previous.pid !== null,
      stoppedCount: previous.pid !== null ? 1 : 0,
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
