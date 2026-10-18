#!/usr/bin/env bun
// SessionStart hook: Auto-reinstall swiz if the manifest has drifted since last install.

import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { detectCurrentAgentFromHookPayload, getAgentSettingsPath } from "../src/agent-paths.ts"
import type { AgentDef } from "../src/agents.ts"
import { getHomeDir } from "../src/home.ts"
import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { buildContextHookOutput, runSwizHookAsMain } from "../src/SwizHook.ts"
import { sessionStartHookInputSchema } from "../src/schemas.ts"
import { isSessionstartSelfHealPaused } from "../src/sessionstart-self-heal-state.ts"
import { extractDispatchEvents } from "../src/utils/config-commands.ts"
import { spawnWithTimeout } from "../src/utils/process-utils.ts"

async function computeManifestHash(swizRoot: string): Promise<string | null> {
  const manifestPath = join(swizRoot, "src", "manifest.ts")
  try {
    const content = await Bun.file(manifestPath).text()
    return createHash("sha256").update(content).digest("hex")
  } catch {
    return null
  }
}

async function readStoredHash(path: string): Promise<string | null> {
  try {
    return (await Bun.file(path).text()).trim()
  } catch {
    return null
  }
}

async function writeHash(path: string, hash: string): Promise<void> {
  const dir = dirname(path)
  if (!(await Bun.file(dir).exists())) await mkdir(dir, { recursive: true })
  await Bun.write(path, hash)
}

const INSTALL_TIMEOUT_MS = 10_000
async function runInstall(swizRoot: string, agent: AgentDef): Promise<boolean> {
  // --no-doctor: the full doctor can exceed INSTALL_TIMEOUT_MS.
  const args = [
    "env",
    "SWIZ_DIRECT=1",
    process.execPath,
    join(swizRoot, "index.ts"),
    "install",
    `--${agent.id}`,
    "--hooks-only",
    "--no-doctor",
  ]
  const result = await spawnWithTimeout(args, {
    cwd: swizRoot,
    timeoutMs: INSTALL_TIMEOUT_MS,
  })
  return !result.timedOut && result.exitCode === 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

async function getMissingManifestEvents(
  installed: Set<string>,
  agent: AgentDef
): Promise<string[]> {
  const { manifest } = await import("../src/manifest.ts")
  return manifest
    .filter(
      (group) =>
        !group.scheduled &&
        group.hooks.length > 0 &&
        !agent.unsupportedEvents?.includes(group.event) &&
        !installed.has(group.event)
    )
    .map((group) => group.event)
}

/**
 * Check whether settings.json has all expected swiz dispatch entries.
 * Returns the list of missing canonical event names, or empty if all present.
 */
async function findMissingDispatchEntries(agent: AgentDef, homeDir: string): Promise<string[]> {
  const settingsPath = getAgentSettingsPath(agent.id, homeDir)
  try {
    const settings: unknown = await Bun.file(settingsPath).json()
    const installed = extractDispatchEvents(isRecord(settings) ? settings : {})
    return await getMissingManifestEvents(installed, agent)
  } catch {
    // Can't read settings — assume missing
    return ["unknown"]
  }
}

function isPluginDispatch(callerEnv: unknown): boolean {
  // Plugin hooks belong to the host's plugin lifecycle. Creating global entries
  // here would dispatch twice and leave hooks active after plugin removal.
  if (isRecord(callerEnv)) return callerEnv.SWIZ_PLUGIN === "1"
  return process.env.SWIZ_PLUGIN === "1"
}

export interface SelfHealOptions {
  homeDir?: string
  swizRoot?: string
  install?: typeof runInstall
}

export async function evaluateSessionstartSelfHeal(
  input: unknown,
  options: SelfHealOptions = {}
): Promise<SwizHookOutput> {
  const payload = sessionStartHookInputSchema.parse(input)
  if (isPluginDispatch(payload._env)) return {}

  const agent = detectCurrentAgentFromHookPayload(payload)
  if (!agent?.hooksConfigurable) return {}
  const homeDir = options.homeDir ?? getHomeDir()
  if (await isSessionstartSelfHealPaused(agent.id, homeDir)) return {}

  return await healAgent(agent, homeDir, options)
}

async function healAgent(
  agent: AgentDef,
  homeDir: string,
  options: SelfHealOptions
): Promise<SwizHookOutput> {
  const swizRoot = options.swizRoot ?? dirname(dirname(import.meta.path))
  const hashPath = join(homeDir, ".local", "share", "swiz", `manifest-hash-${agent.id}`)
  const currentHash = await computeManifestHash(swizRoot)
  if (!currentHash) return {}

  const storedHash = await readStoredHash(hashPath)
  const manifestChanged = storedHash !== currentHash

  // Check if dispatch entries are missing from settings.json even when manifest hasn't changed.
  // Claude Code can overwrite settings.json, removing swiz entries without changing the manifest.
  const missingEntries = manifestChanged ? [] : await findMissingDispatchEntries(agent, homeDir)
  const needsInstall = manifestChanged || missingEntries.length > 0

  if (!needsInstall) return {}

  const installed = await (options.install ?? runInstall)(swizRoot, agent)
  if (!installed) return {}

  await writeHash(hashPath, currentHash)

  const reason = manifestChanged
    ? "manifest changed"
    : `${missingEntries.length} missing dispatch entries (${missingEntries.join(", ")})`
  const message =
    storedHash === null
      ? `swiz install: initial ${agent.name} hook config written.`
      : `swiz self-healed: ${reason}, ${agent.name} hook config updated.`

  return buildContextHookOutput("SessionStart", message)
}

const sessionstartSelfHeal: SwizHook<Record<string, any>> = {
  name: "sessionstart-self-heal",
  event: "sessionStart",
  matcher: "startup",
  timeout: 15,
  run(input) {
    return evaluateSessionstartSelfHeal(input)
  },
}

export default sessionstartSelfHeal

if (import.meta.main) {
  await runSwizHookAsMain(sessionstartSelfHeal)
}
