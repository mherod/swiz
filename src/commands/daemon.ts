import { dirname, join } from "node:path"
import { LRUCache } from "lru-cache"
import { getProjectSettingsPath, getSwizSettingsPath } from "../settings.ts"
import type { Command } from "../types.ts"
import { CiWatchRegistry } from "./daemon/ci-watch-registry.ts"
import {
  DAEMON_PORT,
  fetchDaemonStatus,
  installDaemonLaunchAgent,
  uninstallDaemonLaunchAgent,
} from "./daemon/daemon-admin.ts"
import {
  CooldownRegistry,
  createMetrics,
  type DaemonMetrics,
  FileWatcherRegistry,
  GhQueryCache,
  GitStateCache,
  HookEligibilityCache,
  ManifestCache,
  ProjectSettingsCache,
  TranscriptIndexCache,
} from "./daemon/runtime-cache.ts"
import { sessionDataCache } from "./daemon/session-data.ts"
import {
  buildSnapshotFingerprint,
  type CachedSnapshot,
  hasSnapshotInvalidated,
} from "./daemon/snapshot.ts"
import type { ActiveHookDispatch } from "./daemon/types.ts"
import {
  type CapturedToolCall,
  restartDaemon,
  transcriptWatchPathsForProject,
} from "./daemon/utils.ts"
import { startDaemonWebServer } from "./daemon/web-server.ts"
import { DaemonWorkerRuntime } from "./daemon/worker-runtime.ts"
import { computeWarmStatusLineSnapshot, type WarmStatusLineSnapshot } from "./status-line.ts"

const TRANSCRIPT_MEMORY_RETENTION_MS = 12 * 60 * 60 * 1000
const TRANSCRIPT_MEMORY_PRUNE_INTERVAL_MS = 5 * 60 * 1000

/** CLI command: starts the daemon web server, or manages its LaunchAgent lifecycle. */
export const daemonCommand: Command = {
  name: "daemon",
  description: "Run a background web server",
  usage: "swiz daemon [--port <port>] [--restart] [--install] [--uninstall] [status]",
  options: [
    { flags: "--port <port>", description: "Port to listen on (default: 7943)" },
    { flags: "--restart", description: "Stop any daemon on the port, then start fresh" },
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
      await installDaemonLaunchAgent(port)
      return
    }

    if (args.includes("--uninstall")) {
      await uninstallDaemonLaunchAgent()
      return
    }

    if (args.includes("--restart")) {
      const restarted = await restartDaemon(port, process.pid)
      if (restarted.mode === "launchagent") {
        const runningMsg = restarted.hadRunning ? "reloaded" : "loaded"
        console.log(`swiz daemon ${runningMsg} via launchctl.`)
        return
      }
      if (!restarted.hadRunning) console.log(`No daemon detected on port ${port}; starting fresh.`)
      else
        console.log(
          `Restarting daemon on port ${port} (stopped ${restarted.stoppedCount} process${restarted.stoppedCount === 1 ? "" : "es"}).`
        )
    }

    const globalMetrics = createMetrics()
    const projectMetrics = new Map<string, DaemonMetrics>()
    const projectLastSeen = new Map<string, number>()
    const sessionActivity = new Map<string, { lastSeen: number; dispatches: number }>()
    const sessionToolCalls = new Map<string, CapturedToolCall[]>()
    const activeHookDispatches = new Map<string, ActiveHookDispatch>()
    let lastTranscriptMemoryPruneAt = 0
    const getProjectMetrics = (cwd: string): DaemonMetrics => {
      let m = projectMetrics.get(cwd)
      if (!m) {
        m = createMetrics()
        projectMetrics.set(cwd, m)
      }
      return m
    }
    const touchProject = (cwd: string) => {
      projectLastSeen.set(cwd, Date.now())
    }
    const pruneTranscriptMemory = () => {
      const now = Date.now()
      if (now - lastTranscriptMemoryPruneAt < TRANSCRIPT_MEMORY_PRUNE_INTERVAL_MS) return
      lastTranscriptMemoryPruneAt = now
      const cutoffMs = now - TRANSCRIPT_MEMORY_RETENTION_MS
      sessionDataCache.pruneOlderThan(cutoffMs)
      transcriptIndex.pruneOlderThan(cutoffMs)
      for (const [sessionId, activity] of sessionActivity) {
        if (activity.lastSeen < cutoffMs) sessionActivity.delete(sessionId)
      }
      for (const [sessionId, toolCalls] of sessionToolCalls) {
        const recent = toolCalls.filter((call) => new Date(call.timestamp).getTime() >= cutoffMs)
        if (recent.length === 0) {
          sessionToolCalls.delete(sessionId)
          continue
        }
        if (recent.length !== toolCalls.length) {
          sessionToolCalls.set(sessionId, recent)
        }
      }
    }
    touchProject(process.cwd())

    const watchers = new FileWatcherRegistry()
    const ghCache = new GhQueryCache()
    const eligibilityCache = new HookEligibilityCache()
    const transcriptIndex = new TranscriptIndexCache()
    const cooldownRegistry = new CooldownRegistry()
    const ciWatchRegistry = new CiWatchRegistry()
    const workerRuntime = new DaemonWorkerRuntime()
    const gitStateCache = new GitStateCache()
    const projectSettingsCache = new ProjectSettingsCache()
    const manifestCache = new ManifestCache(projectSettingsCache)
    const projectRoot = dirname(Bun.main)
    const hooksDir = join(projectRoot, "hooks/")
    const manifestPath = join(projectRoot, "src", "manifest.ts")
    const globalSettingsPath = getSwizSettingsPath()

    const snapshots = new LRUCache<string, CachedSnapshot>({ max: 200 })
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
      eligibilityCache.invalidateAll()
      gitStateCache.invalidateAll()
      projectSettingsCache.invalidateAll()
      manifestCache.invalidateAll()
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
        for (const key of snapshots.keys()) {
          if (key.startsWith(cwd)) snapshots.delete(key)
        }
        ghCache.invalidateProject(cwd)
        eligibilityCache.invalidateProject(cwd)
        gitStateCache.invalidateProject(cwd)
        projectSettingsCache.invalidateProject(cwd)
        manifestCache.invalidateProject(cwd)
        transcriptIndex.invalidateAll()
        sessionDataCache.invalidateAll()
      }
      const projectSettings = getProjectSettingsPath(cwd)
      if (projectSettings)
        watchers.register(projectSettings, `project-settings:${cwd}`, projectFlush)
      const gitDir = join(cwd, ".git/")
      watchers.register(gitDir, `git:${cwd}`, projectFlush)
      for (const transcriptWatch of transcriptWatchPathsForProject(cwd)) {
        watchers.register(transcriptWatch.path, transcriptWatch.label, projectFlush)
      }
      watchers.start()
    }

    watchers.start()
    process.on("exit", () => {
      watchers.close()
      ciWatchRegistry.close()
      workerRuntime.close()
    })

    const server = startDaemonWebServer({
      port,
      pruneTranscriptMemory,
      transcriptIndex,
      manifestCache,
      globalMetrics,
      getProjectMetrics,
      touchProject,
      registerProjectWatchers,
      sessionActivity,
      sessionToolCalls,
      activeHookDispatches,
      projectMetrics,
      ghCache,
      eligibilityCache,
      cooldownRegistry,
      gitStateCache,
      ciWatchRegistry,
      projectSettingsCache,
      registeredProjects,
      projectLastSeen,
      resolveSnapshot,
      watchers,
      snapshots,
      workerRuntime,
    })

    console.log(`Daemon listening on ${server.url}`)
  },
}
