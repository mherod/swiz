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

async function runLsof(command: string[]) {
  const proc = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 2000,
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { exitCode: await proc.exited, stdout, stderr }
}

function parseListenerPids(result: Awaited<ReturnType<typeof runLsof>>): number[] {
  const output = result.stdout.trim()
  const diagnostic = result.stderr.trim()
  if (result.exitCode === 1 && !output && !diagnostic) return []
  if (result.exitCode !== 0 || diagnostic) {
    throw new Error(`lsof exited ${result.exitCode}: ${diagnostic || "no diagnostic output"}`)
  }
  if (!output) return []
  const rows = output.split("\n").map((line) => line.trim())
  const pids = rows.map(Number)
  if (
    rows.some((row) => !/^\d+$/.test(row)) ||
    pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)
  ) {
    throw new Error("lsof returned invalid process IDs")
  }
  return [...new Set(pids)]
}

export async function listDaemonPids(port: number, run = runLsof): Promise<number[]> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid TCP listener port: ${port}`)
  }
  try {
    // -a intersects the port and state; +w restores diagnostics suppressed by -t.
    return parseListenerPids(
      await run(["lsof", "-nP", "-t", "+w", "-a", `-iTCP:${port}`, "-sTCP:LISTEN"])
    )
  } catch (error) {
    throw new Error(
      `Cannot discover TCP listeners on port ${port}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  }
}

function tryKill(pid: number, signal?: string): void {
  try {
    process.kill(pid, signal)
  } catch {
    // process may have already exited
  }
}

interface PortRestartOperations {
  listPids: (port: number) => Promise<number[]>
  kill: (pid: number, signal?: NodeJS.Signals) => void
  wait: (milliseconds: number) => Promise<unknown>
}

/** Stop other listeners, returning their initial count for the CLI's restart summary. */
export async function restartDaemonOnPort(
  port: number,
  selfPid: number = process.pid,
  operations: Partial<PortRestartOperations> = {}
): Promise<number> {
  const listPids = operations.listPids ?? listDaemonPids
  const kill = operations.kill ?? tryKill
  const wait = operations.wait ?? Bun.sleep
  const otherListeners = async () => (await listPids(port)).filter((pid) => pid !== selfPid)
  const existing = await otherListeners()
  if (existing.length === 0) return 0

  for (const pid of existing) {
    kill(pid)
  }
  await waitForPortRelease(port, otherListeners, kill, wait)
  return existing.length
}

async function waitForPortRelease(
  port: number,
  otherListeners: () => Promise<number[]>,
  kill: PortRestartOperations["kill"],
  wait: PortRestartOperations["wait"]
): Promise<void> {
  // Give processes a short grace period to exit before forcing.
  for (let attempt = 0; attempt < 6; attempt++) {
    await wait(200)
    const remaining = await otherListeners()
    if (remaining.length === 0) return
    if (attempt === 5) {
      for (const pid of remaining) {
        kill(pid, "SIGKILL")
      }
    }
  }

  const finalRemaining = await otherListeners()
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
  portOperations?: Partial<PortRestartOperations>
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

  const stoppedCount = await restartDaemonOnPort(port, selfPid, options.portOperations)
  return {
    mode: "port",
    hadRunning: stoppedCount > 0,
    stoppedCount,
  }
}
