import { dirname, join } from "node:path"
import { getHomeDir } from "../../home.ts"
import { SWIZ_CLEANUP_LABEL } from "../../launch-agents.ts"
import { buildDaemonPath } from "./daemon-helpers.ts"
import {
  inspectLaunchAgentFile,
  installLaunchAgentFile,
  type LaunchAgentFileAction,
  type LaunchAgentFileOptions,
  type LaunchAgentFileStatus,
  renderLaunchAgentPlist,
  uninstallLaunchAgentFile,
} from "./launch-agent-config.ts"

export interface CleanupAgentOptions extends LaunchAgentFileOptions {
  projectRoot?: string
  bunPath?: string
}

export type CleanupAgentStatus = LaunchAgentFileStatus

export type CleanupAgentAction = LaunchAgentFileAction

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
  // Package runners prepend node_modules/.bin to PATH; keep the actual runtime stable.
  const bunPath = options.bunPath ?? process.execPath
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

export function buildCleanupLaunchAgentPlist(options: CleanupAgentOptions = {}): string {
  return renderLaunchAgentPlist(buildCleanupLaunchAgentConfig(options))
}

export function inspectCleanupLaunchAgent(
  options: CleanupAgentOptions = {}
): Promise<CleanupAgentStatus> {
  return inspectLaunchAgentFile(buildCleanupLaunchAgentConfig(options), options)
}

export function installCleanupLaunchAgent(
  dryRun: boolean,
  options: CleanupAgentOptions = {}
): Promise<CleanupAgentAction> {
  return installLaunchAgentFile(buildCleanupLaunchAgentConfig(options), dryRun, options)
}

export function uninstallCleanupLaunchAgent(
  dryRun: boolean,
  options: CleanupAgentOptions = {}
): Promise<CleanupAgentAction> {
  return uninstallLaunchAgentFile(buildCleanupLaunchAgentConfig(options), dryRun, options)
}
