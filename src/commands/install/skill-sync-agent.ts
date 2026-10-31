import { dirname, join } from "node:path"
import { getHomeDir } from "../../home.ts"
import { SWIZ_SKILL_SYNC_LABEL } from "../../launch-agents.ts"
import { buildDaemonPath } from "./daemon-helpers.ts"
import {
  installLaunchAgentFile,
  type LaunchAgentConfig,
  type LaunchAgentFileAction,
  type LaunchAgentFileOptions,
  uninstallLaunchAgentFile,
} from "./launch-agent-config.ts"

// `swiz skill --sync-watch` as a login item: launchd starts it at login, restarts it
// if it dies, and stops it with SIGTERM on logout or uninstall — which the watch
// handles by finishing any in-flight skill swap first.

export interface SkillSyncAgentOptions extends LaunchAgentFileOptions {
  projectRoot?: string
  bunPath?: string
}

/** `watchArgs` are the --sync-watch arguments to persist, e.g. ["--agents", "claude,codex"]. */
export function buildSkillSyncLaunchAgentConfig(
  watchArgs: string[],
  options: SkillSyncAgentOptions = {}
): LaunchAgentConfig {
  const home = options.homeDir ?? getHomeDir()
  const projectRoot = options.projectRoot ?? dirname(Bun.main)
  // Package runners prepend node_modules/.bin to PATH; keep the actual runtime stable.
  const bunPath = options.bunPath ?? process.execPath
  const logs = join(home, "Library/Logs/Swiz")
  return {
    Label: SWIZ_SKILL_SYNC_LABEL,
    ProgramArguments: [
      bunPath,
      "run",
      join(projectRoot, "index.ts"),
      "skill",
      "--sync-watch",
      ...watchArgs,
    ],
    WorkingDirectory: projectRoot,
    EnvironmentVariables: { HOME: home, PATH: buildDaemonPath(bunPath), SWIZ_DIRECT: "1" },
    RunAtLoad: true,
    KeepAlive: true,
    // A watch that crashes on start is retried at most every 30s instead of spinning.
    ThrottleInterval: 30,
    ProcessType: "Background",
    StandardOutPath: join(logs, "skill-sync.log"),
    StandardErrorPath: join(logs, "skill-sync.error.log"),
  }
}

export function installSkillSyncLaunchAgent(
  watchArgs: string[],
  dryRun: boolean,
  options: SkillSyncAgentOptions = {}
): Promise<LaunchAgentFileAction> {
  return installLaunchAgentFile(
    buildSkillSyncLaunchAgentConfig(watchArgs, options),
    dryRun,
    options
  )
}

export function uninstallSkillSyncLaunchAgent(
  dryRun: boolean,
  options: SkillSyncAgentOptions = {}
): Promise<LaunchAgentFileAction> {
  return uninstallLaunchAgentFile(buildSkillSyncLaunchAgentConfig([], options), dryRun, options)
}
