import { dirname, join } from "node:path"
import { DIM, GREEN, RED, RESET } from "../../ansi.ts"
import {
  bootoutLaunchAgent,
  getLaunchAgentPlistPath,
  isLaunchAgentLoaded,
  killLaunchAgentProcesses,
  loadLaunchAgent,
  SWIZ_DAEMON_LABEL,
  unloadLaunchAgent,
} from "../../launch-agents.ts"
import { formatUnifiedDiff } from "../../utils/diff-utils.ts"
import { readFileText } from "../../utils/file-utils.ts"
import { removeFile } from "./file-helpers.ts"

/** Minimum PATH directories the daemon needs. /usr/sbin is required for
 *  lsof and pgrep; /opt/homebrew/bin for bun on Apple Silicon. */
const REQUIRED_DAEMON_PATH_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
]

export function buildDaemonPath(bunPath: string): string {
  const dirs = new Set(REQUIRED_DAEMON_PATH_DIRS)
  const bunDir = dirname(bunPath)
  if (bunDir && bunDir !== ".") dirs.add(bunDir)
  return [...dirs].join(":")
}

export function buildDaemonLaunchAgentPlist(port: number): string {
  const bunPath = Bun.which("bun") ?? "/opt/homebrew/bin/bun"
  const projectRoot = dirname(Bun.main)
  const indexPath = join(projectRoot, "index.ts")
  const daemonTs = join(projectRoot, "src", "commands", "daemon.ts")
  const hooksDir = join(projectRoot, "hooks")
  const envPath = buildDaemonPath(bunPath)

  // language=XML
  return `<?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
    "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0">
    <dict>
      <key>Label</key>
      <string>${SWIZ_DAEMON_LABEL}</string>

      <key>ProgramArguments</key>
      <array>
        <string>/bin/sh</string>
        <string>-c</string>
        <string>exec ${bunPath} run --watch ${indexPath} daemon --port ${port} 2&gt;&amp;1</string>
      </array>

      <key>WorkingDirectory</key>
      <string>${projectRoot}</string>

      <key>RunAtLoad</key>
      <true/>

      <key>KeepAlive</key>
      <dict>
        <key>Crashed</key>
        <true/>
        <key>SuccessfulExit</key>
        <true/>
      </dict>

      <key>AbandonProcessGroup</key>
      <true/>

      <key>ThrottleInterval</key>
      <integer>5</integer>

      <key>StandardOutPath</key>
      <string>/tmp/swiz-daemon.log</string>

      <key>StandardErrorPath</key>
      <string>/tmp/swiz-daemon.log</string>

      <key>WatchPaths</key>
      <array>
        <string>${daemonTs}</string>
        <string>${indexPath}</string>
        <string>${hooksDir}</string>
      </array>

      <key>EnvironmentVariables</key>
      <dict>
        <key>PATH</key>
        <string>${envPath}</string>
      </dict>
    </dict>
  </plist>`
}

/** Install daemon LaunchAgent; used by `swiz install --daemon` and `swiz daemon --install`. */
export async function installDaemonLaunchAgent(port: number): Promise<void> {
  const plist = buildDaemonLaunchAgentPlist(port)
  const plistPath = getLaunchAgentPlistPath(SWIZ_DAEMON_LABEL)
  await Bun.write(plistPath, plist)
  console.log(`Wrote ${plistPath}`)

  const loadExitCode = await loadLaunchAgent(plistPath)
  if (loadExitCode !== 0) throw new Error("launchctl load failed")
  console.log(`Loaded ${SWIZ_DAEMON_LABEL}`)
}

/** Uninstall daemon LaunchAgent; used by `swiz install --uninstall --daemon` and `swiz daemon --uninstall`. */
export async function uninstallDaemonLaunchAgent(): Promise<void> {
  const plistPath = getLaunchAgentPlistPath(SWIZ_DAEMON_LABEL)
  const isLoaded = await isLaunchAgentLoaded(SWIZ_DAEMON_LABEL)

  if (isLoaded) {
    const file = Bun.file(plistPath)
    if (await file.exists()) {
      await unloadLaunchAgent(plistPath)
    }

    // Modern macOS (Big Sur+) prefer bootout for a cleaner stop.
    // We try it even if unload by path was successful as a double-check.
    await bootoutLaunchAgent(SWIZ_DAEMON_LABEL)

    // Give it a moment to stop gracefully.
    await Bun.sleep(100)

    // Last resort: kill any stray processes matching the label.
    await killLaunchAgentProcesses(SWIZ_DAEMON_LABEL)
  }

  await removeFile(plistPath)

  if (isLoaded) {
    console.log(`Unloaded ${SWIZ_DAEMON_LABEL}`)
  }
}

export async function installDaemonForCli(port: number, dryRun: boolean): Promise<void> {
  const plistPath = getLaunchAgentPlistPath(SWIZ_DAEMON_LABEL)
  const proposed = buildDaemonLaunchAgentPlist(port)
  const existingContent = await readFileText(plistPath)
  const alreadyCurrent = existingContent.trim() === proposed.trim()

  if (dryRun) {
    if (alreadyCurrent) {
      console.log(`  ${DIM}daemon LaunchAgent: already installed${RESET}\n`)
    } else {
      console.log(`  ${GREEN}+ daemon LaunchAgent: ${plistPath}${RESET}\n`)
      console.log(formatUnifiedDiff(plistPath, existingContent, proposed))
    }
    return
  }

  if (alreadyCurrent) {
    console.log(`  ${DIM}daemon LaunchAgent: already installed${RESET}\n`)
    return
  }

  await installDaemonLaunchAgent(port)
}

export async function uninstallDaemonForCli(dryRun: boolean): Promise<void> {
  const plistPath = getLaunchAgentPlistPath(SWIZ_DAEMON_LABEL)
  const file = Bun.file(plistPath)
  const exists = await file.exists()
  const isLoaded = await isLaunchAgentLoaded(SWIZ_DAEMON_LABEL)

  if (dryRun) {
    if (!exists && !isLoaded) {
      console.log(`  ${DIM}daemon LaunchAgent: not installed${RESET}\n`)
    } else {
      const actions = []
      if (isLoaded) actions.push("unload")
      if (exists) actions.push("trash")
      console.log(`  ${RED}- daemon LaunchAgent: ${actions.join(" + ")} ${plistPath}${RESET}\n`)
    }
    return
  }

  if (!exists && !isLoaded) {
    console.log(`  ${DIM}daemon LaunchAgent: not installed${RESET}\n`)
    return
  }

  await uninstallDaemonLaunchAgent()
}
