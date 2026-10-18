import { mkdir, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { AgentSettingsId } from "./agent-paths.ts"
import { getHomeDir } from "./home.ts"
import { backup } from "./utils/file-utils.ts"

/** When present, `sessionstart-self-heal` skips running `swiz install` (after full uninstall). */
export function sessionstartSelfHealPausedPath(homeDir = getHomeDir()): string {
  return join(homeDir, ".local", "share", "swiz", "sessionstart-self-heal-paused")
}

function agentStatePath(agentId: AgentSettingsId, homeDir: string): string {
  return join(homeDir, ".local", "share", "swiz", `self-heal-${agentId}.json`)
}

/** Explicit per-agent choices override the legacy global pause without reviving other agents. */
export async function isSessionstartSelfHealPaused(
  agentId?: AgentSettingsId,
  homeDir = getHomeDir()
): Promise<boolean> {
  if (agentId) {
    const file = Bun.file(agentStatePath(agentId, homeDir))
    if (await file.exists()) {
      try {
        const state = await file.json()
        return state?.enabled !== true
      } catch {
        return true
      }
    }
  }
  return Bun.file(sessionstartSelfHealPausedPath(homeDir)).exists()
}

export async function setAgentSelfHealEnabled(
  agentId: AgentSettingsId,
  enabled: boolean,
  homeDir = getHomeDir()
): Promise<void> {
  const path = agentStatePath(agentId, homeDir)
  await mkdir(dirname(path), { recursive: true })
  await backup(path)
  await Bun.write(path, `${JSON.stringify({ enabled })}\n`)
}

/** Call after a full swiz removal so manifest drift does not re-install hooks. */
export async function pauseSessionstartSelfHeal(): Promise<void> {
  const path = sessionstartSelfHealPausedPath()
  const dir = dirname(path)
  if (!(await Bun.file(dir).exists())) await mkdir(dir, { recursive: true })
  await Bun.write(path, "")
}

/** Call after `swiz install` writes agent hooks again. */
export async function resumeSessionstartSelfHeal(): Promise<void> {
  try {
    await unlink(sessionstartSelfHealPausedPath())
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
  }
}
