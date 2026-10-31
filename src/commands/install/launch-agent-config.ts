import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { getHomeDir } from "../../home.ts"
import {
  bootoutLaunchAgent,
  bootstrapLaunchAgent,
  isGuiLaunchAgentLoaded,
  type LaunchAgentRuntime,
  readLaunchAgentPlist,
} from "../../launch-agents.ts"
import { defaultTrashPath } from "../../session-data-delete.ts"
import { writeWithBackup } from "./file-helpers.ts"

// ─── Declarative user LaunchAgents ───────────────────────────────────────────
//
// Shared by the swiz LaunchAgents that are fully described by a config object:
// render it as a plist, compare it with what is installed, and (re)load it in
// the user's GUI domain only when something changed.

export type PlistValue = string | number | boolean | string[] | Record<string, string>

/** A LaunchAgent config whose log files live in directories created on install. */
export type LaunchAgentConfig = Record<string, PlistValue> & {
  Label: string
  StandardOutPath: string
  StandardErrorPath: string
}

export interface LaunchAgentFileOptions {
  homeDir?: string
  platform?: NodeJS.Platform
  runtime?: LaunchAgentRuntime
  trashPath?: (path: string) => Promise<boolean>
}

export interface LaunchAgentFileStatus {
  supported: boolean
  plistPath: string
  exists: boolean
  current: boolean
  loaded: boolean
}

export type LaunchAgentFileAction =
  | "unsupported"
  | "unchanged"
  | "install"
  | "reload"
  | "load"
  | "remove"

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function plistValue(value: PlistValue): string {
  if (typeof value === "string") return `<string>${escapeXml(value)}</string>`
  if (typeof value === "number") return `<integer>${value}</integer>`
  if (typeof value === "boolean") return value ? "<true/>" : "<false/>"
  if (Array.isArray(value)) return `<array>${value.map(plistValue).join("\n")}</array>`
  return `<dict>${plistEntries(value)}</dict>`
}

function plistEntries(config: Record<string, PlistValue>): string {
  return Object.entries(config)
    .map(([key, value]) => `<key>${escapeXml(key)}</key>\n${plistValue(value)}`)
    .join("\n")
}

export function renderLaunchAgentPlist(config: Record<string, PlistValue>): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
${plistEntries(config)}
</dict></plist>\n`
}

export async function inspectLaunchAgentFile(
  config: LaunchAgentConfig,
  options: LaunchAgentFileOptions = {}
): Promise<LaunchAgentFileStatus> {
  const plistPath = join(
    options.homeDir ?? getHomeDir(),
    "Library/LaunchAgents",
    `${config.Label}.plist`
  )
  const status = {
    supported: (options.platform ?? process.platform) === "darwin",
    plistPath,
    exists: false,
    current: false,
    loaded: false,
  }
  if (!status.supported) return status
  status.exists = await Bun.file(plistPath).exists()
  if (status.exists) {
    const installed = await readLaunchAgentPlist(plistPath, options.runtime)
    status.current = isDeepStrictEqual(installed, config)
  }
  status.loaded = await isGuiLaunchAgentLoaded(config.Label, options.runtime)
  return status
}

async function stopLaunchAgent(label: string, options: LaunchAgentFileOptions): Promise<void> {
  const exitCode = await bootoutLaunchAgent(label, options.runtime)
  if (exitCode !== 0 || (await isGuiLaunchAgentLoaded(label, options.runtime))) {
    throw new Error(`Could not unload ${label}; leaving its plist unchanged`)
  }
}

function installAction(status: LaunchAgentFileStatus): LaunchAgentFileAction {
  if (!status.supported) return "unsupported"
  if (status.current) return status.loaded ? "unchanged" : "load"
  return status.loaded ? "reload" : "install"
}

/** Write (with backup) and load the agent; a matching loaded agent is left untouched. */
export async function installLaunchAgentFile(
  config: LaunchAgentConfig,
  dryRun: boolean,
  options: LaunchAgentFileOptions = {}
): Promise<LaunchAgentFileAction> {
  const status = await inspectLaunchAgentFile(config, options)
  const action = installAction(status)
  if (dryRun || action === "unsupported" || action === "unchanged") return action
  if (status.loaded) await stopLaunchAgent(config.Label, options)
  await mkdir(dirname(status.plistPath), { recursive: true })
  await mkdir(dirname(config.StandardOutPath), { recursive: true })
  await mkdir(dirname(config.StandardErrorPath), { recursive: true })
  if (!status.current) {
    await writeWithBackup(status.plistPath, renderLaunchAgentPlist(config))
  }
  await bootstrapLaunchAgent(status.plistPath, options.runtime)
  if (!(await isGuiLaunchAgentLoaded(config.Label, options.runtime))) {
    throw new Error(`Could not load ${status.plistPath} (job not registered after bootstrap)`)
  }
  return action
}

/** Unload the agent and move its plist to the Trash. */
export async function uninstallLaunchAgentFile(
  config: LaunchAgentConfig,
  dryRun: boolean,
  options: LaunchAgentFileOptions = {}
): Promise<LaunchAgentFileAction> {
  const status = await inspectLaunchAgentFile(config, options)
  if (!status.supported) return "unsupported"
  if (!status.exists && !status.loaded) return "unchanged"
  if (dryRun) return "remove"
  if (status.loaded) await stopLaunchAgent(config.Label, options)
  if (status.exists && !(await (options.trashPath ?? defaultTrashPath)(status.plistPath))) {
    throw new Error(`Could not move ${status.plistPath} to Trash`)
  }
  return "remove"
}
