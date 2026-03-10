import { dirname, join } from "node:path"
import { executeDispatch } from "../dispatch/execute.ts"
import { getGitBranchStatus } from "../git-helpers.ts"
import { getProjectSettingsPath, getStatePath, getSwizSettingsPath } from "../settings.ts"
import type { Command } from "../types.ts"
import {
  computeWarmStatusLineSnapshot,
  getGhCachePath,
  type WarmStatusLineSnapshot,
} from "./status-line.ts"

const LABEL = "com.swiz.daemon"
const PLIST_PATH = join(process.env.HOME ?? "", "Library/LaunchAgents", `${LABEL}.plist`)
const GITHUB_REFRESH_WINDOW_MS = 20_000

interface SnapshotFingerprint {
  git: string
  projectSettingsMtimeMs: number
  projectStateMtimeMs: number
  globalSettingsMtimeMs: number
  ghCacheMtimeMs: number
  githubBucket: number
}

interface CachedSnapshot {
  snapshot: WarmStatusLineSnapshot
  fingerprint: SnapshotFingerprint
}

export function hasSnapshotInvalidated(
  previous: SnapshotFingerprint | null,
  next: SnapshotFingerprint
): boolean {
  if (!previous) return true
  return (
    previous.git !== next.git ||
    previous.projectSettingsMtimeMs !== next.projectSettingsMtimeMs ||
    previous.projectStateMtimeMs !== next.projectStateMtimeMs ||
    previous.globalSettingsMtimeMs !== next.globalSettingsMtimeMs ||
    previous.ghCacheMtimeMs !== next.ghCacheMtimeMs ||
    previous.githubBucket !== next.githubBucket
  )
}

async function safeMtime(path: string | null): Promise<number> {
  if (!path) return 0
  try {
    const file = Bun.file(path)
    if (!(await file.exists())) return 0
    const info = await file.stat()
    return info.mtimeMs ?? 0
  } catch {
    return 0
  }
}

async function buildSnapshotFingerprint(cwd: string): Promise<SnapshotFingerprint> {
  const gitStatus = await getGitBranchStatus(cwd)
  const globalSettingsPath = getSwizSettingsPath()
  return {
    git: gitStatus ? JSON.stringify(gitStatus) : "not-git",
    projectSettingsMtimeMs: await safeMtime(getProjectSettingsPath(cwd)),
    projectStateMtimeMs: await safeMtime(getStatePath(cwd)),
    globalSettingsMtimeMs: await safeMtime(globalSettingsPath),
    ghCacheMtimeMs: await safeMtime(getGhCachePath(cwd)),
    githubBucket: Math.floor(Date.now() / GITHUB_REFRESH_WINDOW_MS),
  }
}

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
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>--watch</string>
    <string>${indexPath}</string>
    <string>daemon</string>
    <string>--port</string>
    <string>${port}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${projectRoot}</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
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

async function install(port: number) {
  const plist = buildPlist(port)
  await Bun.write(PLIST_PATH, plist)
  console.log(`Wrote ${PLIST_PATH}`)

  const load = Bun.spawn(["launchctl", "load", PLIST_PATH], {
    stdout: "inherit",
    stderr: "inherit",
  })
  await load.exited
  if (load.exitCode !== 0) {
    throw new Error("launchctl load failed")
  }
  console.log(`Loaded ${LABEL}`)
}

async function uninstall() {
  const load = Bun.spawn(["launchctl", "unload", PLIST_PATH], {
    stdout: "inherit",
    stderr: "inherit",
  })
  await load.exited

  const file = Bun.file(PLIST_PATH)
  if (await file.exists()) {
    const rm = Bun.spawn(["trash", PLIST_PATH], {
      stdout: "inherit",
      stderr: "inherit",
    })
    await rm.exited
    console.log(`Removed ${PLIST_PATH}`)
  }
  console.log(`Unloaded ${LABEL}`)
}

export const daemonCommand: Command = {
  name: "daemon",
  description: "Run a background web server",
  usage: "swiz daemon [--port <port>] [--install] [--uninstall]",
  options: [
    { flags: "--port <port>", description: "Port to listen on (default: 7943)" },
    { flags: "--install", description: "Install as a LaunchAgent" },
    { flags: "--uninstall", description: "Uninstall the LaunchAgent" },
  ],
  async run(args) {
    const portIndex = args.indexOf("--port")
    const port = portIndex !== -1 ? Number(args[portIndex + 1]) : 7943

    if (args.includes("--install")) {
      await install(port)
      return
    }

    if (args.includes("--uninstall")) {
      await uninstall()
      return
    }

    const snapshots = new Map<string, CachedSnapshot>()
    const cacheKey = (cwd: string, sessionId: string | null | undefined) =>
      `${cwd}\x00${sessionId ?? ""}`
    const resolveSnapshot = async (
      cwd: string,
      sessionId: string | null | undefined
    ): Promise<WarmStatusLineSnapshot> => {
      const key = cacheKey(cwd, sessionId)
      const nextFingerprint = await buildSnapshotFingerprint(cwd)
      const existing = snapshots.get(key)
      if (existing && !hasSnapshotInvalidated(existing.fingerprint, nextFingerprint)) {
        return existing.snapshot
      }
      const snapshot = await computeWarmStatusLineSnapshot(cwd, sessionId)
      snapshots.set(key, { snapshot, fingerprint: nextFingerprint })
      return snapshot
    }

    const server = Bun.serve({
      port,
      routes: {
        "/health": new Response("ok"),
      },
      async fetch(req) {
        const url = new URL(req.url)

        if (url.pathname === "/dispatch" && req.method === "POST") {
          const canonicalEvent = url.searchParams.get("event")
          const hookEventName = url.searchParams.get("hookEventName") ?? canonicalEvent
          if (!canonicalEvent || !hookEventName) {
            return Response.json({ error: "Missing required query param: event" }, { status: 400 })
          }

          const payloadStr = await req.text()
          const result = await executeDispatch({
            canonicalEvent,
            hookEventName,
            payloadStr,
            daemonContext: true,
          })
          return Response.json(result.response)
        }

        if (url.pathname === "/status-line/snapshot" && req.method === "POST") {
          const body = (await req.json().catch(() => null)) as {
            cwd?: string
            sessionId?: string | null
          } | null
          const cwd = body?.cwd
          if (typeof cwd !== "string" || cwd.length === 0) {
            return Response.json({ error: "Missing required field: cwd" }, { status: 400 })
          }
          const snapshot = await resolveSnapshot(cwd, body?.sessionId ?? null)
          return Response.json({ snapshot })
        }

        return new Response("Not Found", { status: 404 })
      },
    })

    console.log(`Daemon listening on ${server.url}`)
  },
}
