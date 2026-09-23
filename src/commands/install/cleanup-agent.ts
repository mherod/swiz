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
  SWIZ_CLEANUP_LABEL,
} from "../../launch-agents.ts"
import { defaultTrashPath } from "../../session-data-delete.ts"
import { buildDaemonPath } from "./daemon-helpers.ts"
import { writeWithBackup } from "./file-helpers.ts"

export interface CleanupAgentOptions {
  homeDir?: string
  projectRoot?: string
  bunPath?: string
  platform?: NodeJS.Platform
  runtime?: LaunchAgentRuntime
  trashPath?: (path: string) => Promise<boolean>
}

export interface CleanupAgentStatus {
  supported: boolean
  plistPath: string
  exists: boolean
  current: boolean
  loaded: boolean
}

export type CleanupAgentAction =
  | "unsupported"
  | "unchanged"
  | "install"
  | "reload"
  | "load"
  | "remove"

export function buildCleanupLaunchAgentConfig(options: CleanupAgentOptions = {}): {
  Label: string
  ProgramArguments: string[]
  WorkingDirectory: string
  EnvironmentVariables: Record<string, string>
  StartInterval: number
  RunAtLoad: boolean
  ProcessType: string
  StandardOutPath: string
  StandardErrorPath: string
} {
  const home = options.homeDir ?? getHomeDir()
  const projectRoot = options.projectRoot ?? dirname(Bun.main)
  const bunPath = options.bunPath ?? Bun.which("bun") ?? process.execPath
  const logs = join(home, "Library/Logs/Swiz")
  return {
    Label: SWIZ_CLEANUP_LABEL,
    ProgramArguments: [bunPath, "run", join(projectRoot, "index.ts"), "doctor", "clean"],
    WorkingDirectory: projectRoot,
    EnvironmentVariables: { HOME: home, PATH: buildDaemonPath(bunPath), SWIZ_DIRECT: "1" },
    StartInterval: 86_400,
    RunAtLoad: true,
    ProcessType: "Background",
    StandardOutPath: join(logs, "doctor-clean.log"),
    StandardErrorPath: join(logs, "doctor-clean.error.log"),
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

type PlistValue = string | number | boolean | string[] | Record<string, string>

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

export function buildCleanupLaunchAgentPlist(options: CleanupAgentOptions = {}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
${plistEntries(buildCleanupLaunchAgentConfig(options))}
</dict></plist>\n`
}

export async function inspectCleanupLaunchAgent(
  options: CleanupAgentOptions = {}
): Promise<CleanupAgentStatus> {
  const plistPath = join(
    options.homeDir ?? getHomeDir(),
    "Library/LaunchAgents",
    `${SWIZ_CLEANUP_LABEL}.plist`
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
    const config = await readLaunchAgentPlist(plistPath, options.runtime)
    status.current = isDeepStrictEqual(config, buildCleanupLaunchAgentConfig(options))
  }
  status.loaded = await isGuiLaunchAgentLoaded(SWIZ_CLEANUP_LABEL, options.runtime)
  return status
}

async function stopCleanupLaunchAgent(options: CleanupAgentOptions): Promise<void> {
  const exitCode = await bootoutLaunchAgent(SWIZ_CLEANUP_LABEL, options.runtime)
  if (exitCode !== 0 || (await isGuiLaunchAgentLoaded(SWIZ_CLEANUP_LABEL, options.runtime))) {
    throw new Error(`Could not unload ${SWIZ_CLEANUP_LABEL}; leaving its plist unchanged`)
  }
}

function installAction(status: CleanupAgentStatus): CleanupAgentAction {
  if (!status.supported) return "unsupported"
  if (status.current) return status.loaded ? "unchanged" : "load"
  return status.loaded ? "reload" : "install"
}

export async function installCleanupLaunchAgent(
  dryRun: boolean,
  options: CleanupAgentOptions = {}
): Promise<CleanupAgentAction> {
  const status = await inspectCleanupLaunchAgent(options)
  const action = installAction(status)
  if (dryRun || action === "unsupported" || action === "unchanged") return action
  if (status.loaded) await stopCleanupLaunchAgent(options)
  await mkdir(dirname(status.plistPath), { recursive: true })
  const config = buildCleanupLaunchAgentConfig(options)
  await mkdir(dirname(config.StandardOutPath), { recursive: true })
  if (!status.current) {
    await writeWithBackup(status.plistPath, buildCleanupLaunchAgentPlist(options))
  }
  await bootstrapLaunchAgent(status.plistPath, options.runtime)
  if (!(await isGuiLaunchAgentLoaded(SWIZ_CLEANUP_LABEL, options.runtime))) {
    throw new Error(`Could not load ${status.plistPath} (job not registered after bootstrap)`)
  }
  return action
}

export async function uninstallCleanupLaunchAgent(
  dryRun: boolean,
  options: CleanupAgentOptions = {}
): Promise<CleanupAgentAction> {
  const status = await inspectCleanupLaunchAgent(options)
  if (!status.supported) return "unsupported"
  if (!status.exists && !status.loaded) return "unchanged"
  if (dryRun) return "remove"
  if (status.loaded) await stopCleanupLaunchAgent(options)
  if (status.exists && !(await (options.trashPath ?? defaultTrashPath)(status.plistPath))) {
    throw new Error(`Could not move ${status.plistPath} to Trash`)
  }
  return "remove"
}
