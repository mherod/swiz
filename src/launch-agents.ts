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
  await proc.exited
  return proc.exitCode === 0
}

export async function loadLaunchAgent(plistPath: string): Promise<number> {
  const proc = Bun.spawn(["launchctl", "load", plistPath], {
    stdout: "pipe",
    stderr: "pipe",
  })
  await proc.exited
  return proc.exitCode ?? 1
}

export async function unloadLaunchAgent(plistPath: string): Promise<number> {
  const proc = Bun.spawn(["launchctl", "unload", plistPath], {
    stdout: "pipe",
    stderr: "pipe",
  })
  await proc.exited
  return proc.exitCode ?? 1
}

export function loadLaunchAgentSync(plistPath: string): number {
  const proc = Bun.spawnSync(["launchctl", "load", plistPath])
  return proc.exitCode
}

export function unloadLaunchAgentSync(plistPath: string): number {
  const proc = Bun.spawnSync(["launchctl", "unload", plistPath])
  return proc.exitCode
}
