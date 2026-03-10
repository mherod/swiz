import { type FSWatcher, watch } from "node:fs"
import { dirname, join } from "node:path"
import { stderrLog } from "../debug.ts"
import { executeDispatch } from "../dispatch/execute.ts"
import { getGitBranchStatus, ghJson } from "../git-helpers.ts"
import { getProjectSettingsPath, getStatePath, getSwizSettingsPath } from "../settings.ts"
import type { Command } from "../types.ts"
import {
  computeWarmStatusLineSnapshot,
  getGhCachePath,
  type WarmStatusLineSnapshot,
} from "./status-line.ts"

const DAEMON_PORT = 7_943
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

export interface EventMetrics {
  count: number
  totalMs: number
}

export interface DaemonMetrics {
  startedAt: number
  dispatches: Map<string, EventMetrics>
}

export function createMetrics(): DaemonMetrics {
  return { startedAt: Date.now(), dispatches: new Map() }
}

export function recordDispatch(metrics: DaemonMetrics, event: string, durationMs: number): void {
  const existing = metrics.dispatches.get(event)
  if (existing) {
    existing.count += 1
    existing.totalMs += durationMs
  } else {
    metrics.dispatches.set(event, { count: 1, totalMs: durationMs })
  }
}

export function serializeMetrics(metrics: DaemonMetrics) {
  const uptimeMs = Date.now() - metrics.startedAt
  const byEvent: Record<string, { count: number; avgMs: number }> = {}
  let totalDispatches = 0
  for (const [event, m] of metrics.dispatches) {
    byEvent[event] = { count: m.count, avgMs: Math.round(m.totalMs / m.count) }
    totalDispatches += m.count
  }
  return {
    uptimeMs,
    uptimeHuman: formatUptime(uptimeMs),
    totalDispatches,
    byEvent,
  }
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m ${sec}s`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

export interface WatchEntry {
  path: string
  label: string
  callbacks: Set<() => void>
  watcher: FSWatcher | null
  lastInvalidation: number | null
  invalidationCount: number
}

export class FileWatcherRegistry {
  private entries = new Map<string, WatchEntry>()

  register(path: string, label: string, callback: () => void): void {
    let entry = this.entries.get(path)
    if (!entry) {
      entry = {
        path,
        label,
        callbacks: new Set(),
        watcher: null,
        lastInvalidation: null,
        invalidationCount: 0,
      }
      this.entries.set(path, entry)
    }
    entry.callbacks.add(callback)
  }

  start(): void {
    for (const entry of this.entries.values()) {
      if (entry.watcher) continue
      try {
        entry.watcher = watch(entry.path, { recursive: entry.path.endsWith("/") }, () => {
          entry.lastInvalidation = Date.now()
          entry.invalidationCount += 1
          for (const cb of entry.callbacks) {
            try {
              cb()
            } catch {
              /* ignore callback errors */
            }
          }
        })
      } catch {
        /* path may not exist yet — that's fine */
      }
    }
  }

  close(): void {
    for (const entry of this.entries.values()) {
      entry.watcher?.close()
      entry.watcher = null
    }
  }

  status(): Array<{
    path: string
    label: string
    watching: boolean
    lastInvalidation: number | null
    invalidationCount: number
  }> {
    return [...this.entries.values()].map((e) => ({
      path: e.path,
      label: e.label,
      watching: e.watcher !== null,
      lastInvalidation: e.lastInvalidation,
      invalidationCount: e.invalidationCount,
    }))
  }
}

const GH_QUERY_TTL_MS = 20_000

interface GhCacheEntry {
  value: unknown
  expiresAt: number
}

type GhFetcher = (args: string[], cwd: string) => Promise<unknown>

export class GhQueryCache {
  private entries = new Map<string, GhCacheEntry>()
  private fetcher: GhFetcher

  constructor(fetcher?: GhFetcher) {
    this.fetcher = fetcher ?? ((args, cwd) => ghJson(args, cwd))
  }

  private key(args: string[], cwd: string): string {
    return `${cwd}\x00${args.join("\x00")}`
  }

  async get(args: string[], cwd: string): Promise<{ hit: boolean; value: unknown }> {
    const k = this.key(args, cwd)
    const entry = this.entries.get(k)
    if (entry && entry.expiresAt > Date.now()) {
      return { hit: true, value: entry.value }
    }
    const value = await this.fetcher(args, cwd)
    this.entries.set(k, { value, expiresAt: Date.now() + GH_QUERY_TTL_MS })
    return { hit: false, value }
  }

  invalidateProject(cwd: string): void {
    for (const k of this.entries.keys()) {
      if (k.startsWith(cwd)) this.entries.delete(k)
    }
  }

  invalidateAll(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
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

async function fetchDaemonStatus(port: number): Promise<void> {
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

export const daemonCommand: Command = {
  name: "daemon",
  description: "Run a background web server",
  usage: "swiz daemon [--port <port>] [--install] [--uninstall] [status]",
  options: [
    { flags: "--port <port>", description: "Port to listen on (default: 7943)" },
    { flags: "--install", description: "Install as a LaunchAgent" },
    { flags: "--uninstall", description: "Uninstall the LaunchAgent" },
    { flags: "status", description: "Show daemon metrics and status" },
  ],
  async run(args) {
    const portIndex = args.indexOf("--port")
    const port = portIndex !== -1 ? Number(args[portIndex + 1]) : DAEMON_PORT

    if (args.includes("status")) {
      await fetchDaemonStatus(port)
      return
    }

    if (args.includes("--install")) {
      await install(port)
      return
    }

    if (args.includes("--uninstall")) {
      await uninstall()
      return
    }

    const globalMetrics = createMetrics()
    const projectMetrics = new Map<string, DaemonMetrics>()
    const getProjectMetrics = (cwd: string): DaemonMetrics => {
      let m = projectMetrics.get(cwd)
      if (!m) {
        m = createMetrics()
        projectMetrics.set(cwd, m)
      }
      return m
    }

    const watchers = new FileWatcherRegistry()
    const ghCache = new GhQueryCache()
    const projectRoot = dirname(Bun.main)
    const hooksDir = join(projectRoot, "hooks/")
    const manifestPath = join(projectRoot, "src", "manifest.ts")
    const globalSettingsPath = getSwizSettingsPath()

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

    // Register watchers for cache invalidation
    const flushSnapshots = () => {
      snapshots.clear()
      ghCache.invalidateAll()
    }

    watchers.register(manifestPath, "manifest", flushSnapshots)
    watchers.register(hooksDir, "hooks", flushSnapshots)
    if (globalSettingsPath) {
      watchers.register(globalSettingsPath, "global-settings", flushSnapshots)
    }

    const registeredProjects = new Set<string>()
    const registerProjectWatchers = (cwd: string) => {
      if (registeredProjects.has(cwd)) return
      registeredProjects.add(cwd)
      const projectFlush = () => {
        // Flush snapshots and gh cache for this project
        for (const key of snapshots.keys()) {
          if (key.startsWith(cwd)) snapshots.delete(key)
        }
        ghCache.invalidateProject(cwd)
      }
      const projectSettings = getProjectSettingsPath(cwd)
      if (projectSettings)
        watchers.register(projectSettings, `project-settings:${cwd}`, projectFlush)
      const gitDir = join(cwd, ".git/")
      watchers.register(gitDir, `git:${cwd}`, projectFlush)
      // Re-start to pick up new watchers
      watchers.start()
    }

    watchers.start()
    process.on("exit", () => watchers.close())

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
          const start = performance.now()
          const result = await executeDispatch({
            canonicalEvent,
            hookEventName,
            payloadStr,
            daemonContext: true,
          })
          const durationMs = performance.now() - start
          recordDispatch(globalMetrics, canonicalEvent, durationMs)
          try {
            const parsed = JSON.parse(payloadStr) as { cwd?: string }
            if (parsed.cwd) {
              recordDispatch(getProjectMetrics(parsed.cwd), canonicalEvent, durationMs)
              registerProjectWatchers(parsed.cwd)
            }
          } catch {
            /* ignore parse errors */
          }
          return Response.json(result.response)
        }

        if (url.pathname === "/metrics" && req.method === "GET") {
          const projectParam = url.searchParams.get("project")
          if (projectParam) {
            const pm = projectMetrics.get(projectParam)
            if (!pm) return Response.json({ error: "No metrics for project" }, { status: 404 })
            return Response.json({ ...serializeMetrics(pm), project: projectParam })
          }
          const projects: Record<string, ReturnType<typeof serializeMetrics>> = {}
          for (const [cwd, m] of projectMetrics) {
            projects[cwd] = serializeMetrics(m)
          }
          return Response.json({ ...serializeMetrics(globalMetrics), projects })
        }

        if (url.pathname === "/gh-query" && req.method === "POST") {
          const body = (await req.json().catch(() => null)) as {
            args?: string[]
            cwd?: string
          } | null
          const args = body?.args
          const cwd = body?.cwd
          if (!Array.isArray(args) || typeof cwd !== "string" || cwd.length === 0) {
            return Response.json(
              { error: "Missing required fields: args (string[]), cwd (string)" },
              { status: 400 }
            )
          }
          registerProjectWatchers(cwd)
          const { hit, value } = await ghCache.get(args, cwd)
          return Response.json({ hit, value })
        }

        if (url.pathname === "/cache/status" && req.method === "GET") {
          return Response.json({
            watchers: watchers.status(),
            snapshotCacheSize: snapshots.size,
            ghCacheSize: ghCache.size,
          })
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
