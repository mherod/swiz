import { dirname, join } from "node:path"
import { LRUCache } from "lru-cache"
import {
  getProjectSettingsPath,
  getSwizSettingsPath,
  invalidateSettingsCache,
} from "../settings.ts"
import type { Command } from "../types.ts"
import { CiWatchRegistry, notifyCiCompletion } from "./daemon/ci-watch-registry.ts"
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
import { UpstreamSyncRegistry } from "./daemon/upstream-sync.ts"
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
const PROJECT_IDLE_EVICTION_MS = 60 * 60 * 1000 // 1 hour

async function handleDaemonSubcommand(args: string[], port: number): Promise<boolean> {
  if (args.includes("status")) {
    await fetchDaemonStatus(port)
    return true
  }
  if (args.includes("--install")) {
    await installDaemonLaunchAgent(port)
    return true
  }
  if (args.includes("--uninstall")) {
    await uninstallDaemonLaunchAgent()
    return true
  }

  if (args.includes("--restart")) {
    const restarted = await restartDaemon(port, process.pid)
    if (restarted.mode === "launchagent") {
      const runningMsg = restarted.hadRunning ? "reloaded" : "loaded"
      console.log(`swiz daemon ${runningMsg} via launchctl.`)
      return true
    }
    if (!restarted.hadRunning) console.log(`No daemon detected on port ${port}; starting fresh.`)
    else
      console.log(
        `Restarting daemon on port ${port} (stopped ${restarted.stoppedCount} process${restarted.stoppedCount === 1 ? "" : "es"}).`
      )
  }
  return false
}

function createDaemonState() {
  const globalMetrics = createMetrics()
  const projectMetrics = new Map<string, DaemonMetrics>()
  const projectLastSeen = new Map<string, number>()
  const sessionActivity = new Map<string, { lastSeen: number; dispatches: number }>()
  const sessionToolCalls = new Map<string, CapturedToolCall[]>()
  const activeHookDispatches = new Map<string, ActiveHookDispatch>()

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

  return {
    globalMetrics,
    projectMetrics,
    projectLastSeen,
    sessionActivity,
    sessionToolCalls,
    activeHookDispatches,
    getProjectMetrics,
    touchProject,
  }
}

function createDaemonCaches() {
  const watchers = new FileWatcherRegistry()
  const ghCache = new GhQueryCache()
  const eligibilityCache = new HookEligibilityCache()
  const transcriptIndex = new TranscriptIndexCache()
  const cooldownRegistry = new CooldownRegistry()
  const ciWatchRegistry = new CiWatchRegistry({ notify: notifyCiCompletion })
  const upstreamSyncRegistry = new UpstreamSyncRegistry()
  const workerRuntime = new DaemonWorkerRuntime()
  const gitStateCache = new GitStateCache()
  const projectSettingsCache = new ProjectSettingsCache()
  const manifestCache = new ManifestCache(projectSettingsCache)
  const snapshots = new LRUCache<string, CachedSnapshot>({ max: 200 })

  return {
    watchers,
    ghCache,
    eligibilityCache,
    transcriptIndex,
    cooldownRegistry,
    ciWatchRegistry,
    upstreamSyncRegistry,
    workerRuntime,
    gitStateCache,
    projectSettingsCache,
    manifestCache,
    snapshots,
  }
}

function buildSnapshotResolver(snapshots: LRUCache<string, CachedSnapshot>) {
  const cacheKey = (cwd: string, sessionId: string | null | undefined) =>
    `${cwd}\x00${sessionId ?? ""}`

  // In-flight coalescing: concurrent requests for the same cwd share one computation.
  // Keyed by cwd only — the expensive work (gh API calls) is cwd-scoped.
  const inFlight = new Map<string, Promise<WarmStatusLineSnapshot>>()

  return async (
    cwd: string,
    sessionId: string | null | undefined
  ): Promise<WarmStatusLineSnapshot> => {
    const key = cacheKey(cwd, sessionId)
    const nextFingerprint = await buildSnapshotFingerprint(cwd)
    const existing = snapshots.get(key)
    if (existing && !hasSnapshotInvalidated(existing.fingerprint, nextFingerprint)) {
      return existing.snapshot
    }

    // Coalesce concurrent callers behind a single in-flight computation per cwd.
    const inflight = inFlight.get(cwd)
    if (inflight) return inflight

    const computation = computeWarmStatusLineSnapshot(cwd, sessionId).then((snapshot) => {
      snapshots.set(key, { snapshot, fingerprint: nextFingerprint })
      inFlight.delete(cwd)
      return snapshot
    })
    inFlight.set(cwd, computation)
    return computation
  }
}

function setupWatchers(caches: ReturnType<typeof createDaemonCaches>) {
  const {
    watchers,
    ghCache,
    eligibilityCache,
    gitStateCache,
    projectSettingsCache,
    manifestCache,
    transcriptIndex,
    snapshots,
  } = caches
  const projectRoot = dirname(Bun.main)

  const flushSnapshots = () => {
    snapshots.clear()
    ghCache.invalidateAll()
    eligibilityCache.invalidateAll()
    gitStateCache.invalidateAll()
    projectSettingsCache.invalidateAll()
    manifestCache.invalidateAll()
    // Also invalidate the in-process settings TTL cache so changes take
    // effect immediately without waiting for the 5s TTL (issue #330).
    const settingsPath = getSwizSettingsPath()
    if (settingsPath) invalidateSettingsCache(settingsPath)
  }

  watchers.register(join(projectRoot, "src", "manifest.ts"), "manifest", flushSnapshots)
  watchers.register(join(projectRoot, "hooks/"), "hooks", flushSnapshots)
  const globalSettingsPath = getSwizSettingsPath()
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
    if (projectSettings) watchers.register(projectSettings, `project-settings:${cwd}`, projectFlush)
    watchers.register(join(cwd, ".git/"), `git:${cwd}`, projectFlush)
    for (const transcriptWatch of transcriptWatchPathsForProject(cwd)) {
      watchers.register(transcriptWatch.path, transcriptWatch.label, projectFlush)
    }
    // Auto-register project for periodic upstream sync
    void caches.upstreamSyncRegistry.register(cwd)
    watchers.start()
  }

  watchers.start()
  process.on("exit", () => {
    watchers.close()
    caches.ciWatchRegistry.close()
    caches.upstreamSyncRegistry.close()
    caches.workerRuntime.close()
  })

  return { registeredProjects, registerProjectWatchers }
}

function createPruner(
  state: ReturnType<typeof createDaemonState>,
  caches: ReturnType<typeof createDaemonCaches>,
  registeredProjects: Set<string>
) {
  let lastPruneAt = 0
  return () => {
    const now = Date.now()
    if (now - lastPruneAt < TRANSCRIPT_MEMORY_PRUNE_INTERVAL_MS) return
    lastPruneAt = now
    const cutoffMs = now - TRANSCRIPT_MEMORY_RETENTION_MS
    sessionDataCache.pruneOlderThan(cutoffMs)
    caches.transcriptIndex.pruneOlderThan(cutoffMs)
    for (const [sessionId, activity] of state.sessionActivity) {
      if (activity.lastSeen < cutoffMs) state.sessionActivity.delete(sessionId)
    }
    for (const [sessionId, toolCalls] of state.sessionToolCalls) {
      const recent = toolCalls.filter((call) => new Date(call.timestamp).getTime() >= cutoffMs)
      if (recent.length === 0) {
        state.sessionToolCalls.delete(sessionId)
        continue
      }
      if (recent.length !== toolCalls.length) state.sessionToolCalls.set(sessionId, recent)
    }

    // Evict projects idle for longer than PROJECT_IDLE_EVICTION_MS
    const projectCutoff = now - PROJECT_IDLE_EVICTION_MS
    for (const [cwd, lastSeen] of state.projectLastSeen) {
      if (lastSeen >= projectCutoff) continue
      state.projectLastSeen.delete(cwd)
      state.projectMetrics.delete(cwd)
      registeredProjects.delete(cwd)
      caches.ghCache.invalidateProject(cwd)
      caches.eligibilityCache.invalidateProject(cwd)
      caches.gitStateCache.invalidateProject(cwd)
      caches.projectSettingsCache.invalidateProject(cwd)
      caches.manifestCache.invalidateProject(cwd)
      caches.cooldownRegistry.invalidateProject(cwd)
      caches.upstreamSyncRegistry.unregister(cwd)
      caches.watchers.unregisterByLabelSuffix(`:${cwd}`)
      for (const key of caches.snapshots.keys()) {
        if (key.startsWith(cwd)) caches.snapshots.delete(key)
      }
    }
  }
}

async function startDaemonProcess(_args: string[], port: number): Promise<void> {
  const state = createDaemonState()
  const caches = createDaemonCaches()
  const { registeredProjects, registerProjectWatchers } = setupWatchers(caches)

  state.touchProject(process.cwd())
  const pruneTranscriptMemory = createPruner(state, caches, registeredProjects)
  const resolveSnapshot = buildSnapshotResolver(caches.snapshots)

  const server = startDaemonWebServer({
    port,
    pruneTranscriptMemory,
    transcriptIndex: caches.transcriptIndex,
    manifestCache: caches.manifestCache,
    globalMetrics: state.globalMetrics,
    getProjectMetrics: state.getProjectMetrics,
    touchProject: state.touchProject,
    registerProjectWatchers,
    sessionActivity: state.sessionActivity,
    sessionToolCalls: state.sessionToolCalls,
    activeHookDispatches: state.activeHookDispatches,
    projectMetrics: state.projectMetrics,
    ghCache: caches.ghCache,
    eligibilityCache: caches.eligibilityCache,
    cooldownRegistry: caches.cooldownRegistry,
    gitStateCache: caches.gitStateCache,
    ciWatchRegistry: caches.ciWatchRegistry,
    upstreamSyncRegistry: caches.upstreamSyncRegistry,
    projectSettingsCache: caches.projectSettingsCache,
    registeredProjects,
    projectLastSeen: state.projectLastSeen,
    resolveSnapshot,
    watchers: caches.watchers,
    snapshots: caches.snapshots,
    workerRuntime: caches.workerRuntime,
  })

  // Register initial project for periodic upstream sync
  void caches.upstreamSyncRegistry.register(process.cwd())

  console.log(`Daemon listening on ${server.url}`)
}

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

    if (await handleDaemonSubcommand(args, port)) return

    await startDaemonProcess(args, port)
  },
}
