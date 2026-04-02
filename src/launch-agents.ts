import { join } from "node:path"
import { getHomeDir } from "./home.ts"

export const SWIZ_DAEMON_LABEL = "com.swiz.daemon"
export const SWIZ_PR_POLL_LABEL = "com.swiz.prpoll"

export function getLaunchAgentPlistPath(label: string): string {
  return join(getHomeDir(), "Library/LaunchAgents", `${label}.plist`)
}

export async function launchAgentExists(label: string): Promise<boolean> {
  const file = Bun.file(getLaunchAgentPlistPath(label))
  return file.exists()
}

export async function isLaunchAgentLoaded(label: string): Promise<boolean> {
  const proc = Bun.spawn(["launchctl", "list", label], {
    stdout: "pipe",
    stderr: "pipe",
  })
  await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  return proc.exitCode === 0
}

export async function loadLaunchAgent(plistPath: string): Promise<number> {
  const proc = Bun.spawn(["launchctl", "load", plistPath], {
    stdout: "pipe",
    stderr: "pipe",
  })
  await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  return proc.exitCode ?? 1
}

export async function unloadLaunchAgent(plistPath: string): Promise<number> {
  const proc = Bun.spawn(["launchctl", "unload", plistPath], {
    stdout: "pipe",
    stderr: "pipe",
  })
  await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  return proc.exitCode ?? 1
}

/**
 * Modern replacement for unload; more robust on macOS Big Sur+.
 * Fails gracefully if already stopped.
 */
export async function bootoutLaunchAgent(label: string): Promise<number> {
  const domain = `gui/${process.getuid?.() ?? 501}`
  const proc = Bun.spawn(["launchctl", "bootout", `${domain}/${label}`], {
    stdout: "pipe",
    stderr: "pipe",
  })
  await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  return proc.exitCode ?? 1
}

/**
 * Forcefully kill any process matching the label's name if it's still running.
 * Useful as a last resort during uninstallation.
 */
export async function killLaunchAgentProcesses(label: string): Promise<void> {
  // We use pgrep to find processes. The daemon usually has the label in its command line.
  // For swiz daemon, it's often 'bun ... daemon'.
  const pgrep = Bun.spawn(["pgrep", "-f", label], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(pgrep.stdout).text()
  await pgrep.exited

  const pids = stdout
    .split("\n")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  for (const pid of pids) {
    process.kill(Number.parseInt(pid, 10), "SIGKILL")
  }
}

export function loadLaunchAgentSync(plistPath: string): number {
  const proc = Bun.spawnSync(["launchctl", "load", plistPath])
  return proc.exitCode
}

export function unloadLaunchAgentSync(plistPath: string): number {
  const proc = Bun.spawnSync(["launchctl", "unload", plistPath])
  return proc.exitCode
}
