import { join } from "node:path"
import { getHomeDir } from "./home.ts"

export const SWIZ_DAEMON_LABEL = "com.swiz.daemon"
export const SWIZ_CLEANUP_LABEL = "com.swiz.doctor-clean"

export interface LaunchAgentCommandResult {
  exitCode: number
  stdout: string
}

export interface LaunchAgentRuntime {
  run(command: string[]): Promise<LaunchAgentCommandResult>
  kill(pid: number, signal: NodeJS.Signals): void
  getUid(): number
}

const launchAgentRuntime: LaunchAgentRuntime = {
  async run(command) {
    const proc = Bun.spawn(command, {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    return { exitCode: proc.exitCode ?? 1, stdout }
  },
  kill(pid, signal) {
    process.kill(pid, signal)
  },
  getUid() {
    return process.getuid?.() ?? 501
  },
}

export function getLaunchAgentPlistPath(label: string): string {
  return join(getHomeDir(), "Library/LaunchAgents", `${label}.plist`)
}

export async function launchAgentExists(label: string): Promise<boolean> {
  const file = Bun.file(getLaunchAgentPlistPath(label))
  return file.exists()
}

/** Parse XML or binary plists without depending on formatting or dictionary key order. */
export async function readLaunchAgentPlist(
  plistPath: string,
  runtime: LaunchAgentRuntime = launchAgentRuntime
): Promise<object | null> {
  const result = await runtime.run(["plutil", "-convert", "json", "-o", "-", plistPath])
  if (result.exitCode !== 0) return null
  try {
    const value = JSON.parse(result.stdout)
    return value && typeof value === "object" && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

export async function isLaunchAgentLoaded(
  label: string,
  runtime: LaunchAgentRuntime = launchAgentRuntime
): Promise<boolean> {
  const result = await runtime.run(["launchctl", "list", label])
  return result.exitCode === 0
}

/** GUI agents can be invisible to `launchctl list` from a different bootstrap domain. */
export async function isGuiLaunchAgentLoaded(
  label: string,
  runtime: LaunchAgentRuntime = launchAgentRuntime
): Promise<boolean> {
  const result = await runtime.run(["launchctl", "print", `gui/${runtime.getUid()}/${label}`])
  return result.exitCode === 0
}

export async function bootstrapLaunchAgent(
  plistPath: string,
  runtime: LaunchAgentRuntime = launchAgentRuntime
): Promise<number> {
  return (await runtime.run(["launchctl", "bootstrap", `gui/${runtime.getUid()}`, plistPath]))
    .exitCode
}

export async function loadLaunchAgent(
  plistPath: string,
  runtime: LaunchAgentRuntime = launchAgentRuntime
): Promise<number> {
  return (await runtime.run(["launchctl", "load", plistPath])).exitCode
}

export async function unloadLaunchAgent(
  plistPath: string,
  runtime: LaunchAgentRuntime = launchAgentRuntime
): Promise<number> {
  return (await runtime.run(["launchctl", "unload", plistPath])).exitCode
}

/**
 * Modern replacement for unload; more robust on macOS Big Sur+.
 * Fails gracefully if already stopped.
 */
export async function bootoutLaunchAgent(
  label: string,
  runtime: LaunchAgentRuntime = launchAgentRuntime
): Promise<number> {
  const domain = `gui/${runtime.getUid()}`
  return (await runtime.run(["launchctl", "bootout", `${domain}/${label}`])).exitCode
}

/**
 * Forcefully kill any process matching the label's name if it's still running.
 * Useful as a last resort during uninstallation.
 */
export async function killLaunchAgentProcesses(
  label: string,
  runtime: LaunchAgentRuntime = launchAgentRuntime
): Promise<void> {
  // We use pgrep to find processes. The daemon usually has the label in its command line.
  // For swiz daemon, it's often 'bun ... daemon'.
  const { stdout } = await runtime.run(["pgrep", "-f", label])

  const pids = stdout
    .split("\n")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  for (const pid of pids) {
    runtime.kill(Number.parseInt(pid, 10), "SIGKILL")
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
