import { dirname, join } from "node:path"
import { stderrLog } from "../../debug.ts"
import {
  getLaunchAgentPlistPath,
  loadLaunchAgent,
  SWIZ_DAEMON_LABEL,
  unloadLaunchAgent,
} from "../../launch-agents.ts"

export const DAEMON_PORT = 7_943

function buildPlist(port: number): string {
  const bunPath = Bun.which("bun") ?? "/opt/homebrew/bin/bun"
  const projectRoot = dirname(Bun.main)
  const indexPath = join(projectRoot, "index.ts")
  const daemonTs = join(projectRoot, "src", "commands", "daemon.ts")

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SWIZ_DAEMON_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>(sleep 1200 &amp;&amp; kill $$) &amp; exec ${bunPath} --watch ${indexPath} daemon --port ${port}</string>
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
    <false/>
  </dict>

  <key>AbandonProcessGroup</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/tmp/swiz-daemon.log</string>

  <key>StandardErrorPath</key>
  <string>/tmp/swiz-daemon.log</string>

  <key>WatchPaths</key>
  <array>
    <string>${daemonTs}</string>
    <string>${indexPath}</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>`
}

export async function installDaemonLaunchAgent(port: number) {
  const plist = buildPlist(port)
  const plistPath = getLaunchAgentPlistPath(SWIZ_DAEMON_LABEL)
  await Bun.write(plistPath, plist)
  console.log(`Wrote ${plistPath}`)

  const loadExitCode = await loadLaunchAgent(plistPath)
  if (loadExitCode !== 0) throw new Error("launchctl load failed")
  console.log(`Loaded ${SWIZ_DAEMON_LABEL}`)
}

export async function uninstallDaemonLaunchAgent() {
  const plistPath = getLaunchAgentPlistPath(SWIZ_DAEMON_LABEL)
  await unloadLaunchAgent(plistPath)
  const file = Bun.file(plistPath)
  if (await file.exists()) {
    const rm = Bun.spawn(["trash", plistPath], {
      stdout: "inherit",
      stderr: "inherit",
    })
    await rm.exited
    console.log(`Removed ${plistPath}`)
  }
  console.log(`Unloaded ${SWIZ_DAEMON_LABEL}`)
}

export async function fetchDaemonStatus(port: number): Promise<void> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/metrics`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!resp.ok) {
      stderrLog("daemon-status", `Daemon returned ${resp.status}`)
      process.exitCode = 1
      return
    }
    const data = (await resp.json()) as {
      uptimeHuman: string
      totalDispatches: number
      byEvent: Record<string, { count: number; avgMs: number }>
      projects?: Record<
        string,
        {
          uptimeHuman: string
          totalDispatches: number
          byEvent: Record<string, { count: number; avgMs: number }>
        }
      >
    }
    console.log(`Daemon uptime: ${data.uptimeHuman}`)
    console.log(`Total dispatches: ${data.totalDispatches}`)
    const events = Object.entries(data.byEvent)
    if (events.length > 0) {
      console.log("\nDispatches by event:")
      for (const [event, m] of events.sort((a, b) => b[1].count - a[1].count)) {
        console.log(`  ${event}: ${m.count} (avg ${m.avgMs}ms)`)
      }
    }
    if (data.projects) {
      const projectEntries = Object.entries(data.projects)
      if (projectEntries.length > 0) {
        console.log(`\nProjects: ${projectEntries.length}`)
        for (const [cwd, pm] of projectEntries) {
          console.log(`  ${cwd}: ${pm.totalDispatches} dispatches`)
        }
      }
    }
  } catch {
    stderrLog("daemon-status", `Daemon not reachable on port ${port}`)
    process.exitCode = 1
  }
}
