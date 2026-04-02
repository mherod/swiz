import { dirname, join } from "node:path"
import { LRUCache } from "lru-cache"
import { stderrLog } from "../debug.ts"
import { pruneTempLogs } from "../log-rotation.ts"
import {
  getProjectSettingsPath,
  getSwizSettingsPath,
  invalidateSettingsCache,
} from "../settings.ts"
import type { Command } from "../types.ts"
import { formatBytes } from "../utils/format.ts"
import type { TranscriptMonitor } from "./daemon/cache/transcript-monitor.ts"
import { WorkerTranscriptMonitor } from "./daemon/cache/worker-transcript-monitor.ts"
import { CiWatchRegistry, notifyCiCompletion } from "./daemon/ci-watch-registry.ts"
import { DAEMON_PORT, fetchDaemonStatus } from "./daemon/daemon-admin.ts"
import { logPseudoHook } from "./daemon/daemon-logging.ts"
import { PrReviewMonitor } from "./daemon/pr-review-monitor.ts"
import {
  CappedMap,
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
  type SessionToolUsageState,
  transcriptWatchPathsForProject,
} from "./daemon/utils.ts"
import { startDaemonWebServer } from "./daemon/web-server.ts"
import { DaemonWorkerRuntime } from "./daemon/worker-runtime.ts"
import { installDaemonLaunchAgent, uninstallDaemonLaunchAgent } from "./install.ts"
import { computeWarmStatusLineSnapshot, type WarmStatusLineSnapshot } from "./status-line.ts"

const TRANSCRIPT_MEMORY_RETENTION_MS = 30 * 60 * 1000 // 30 mins
const TRANSCRIPT_MEMORY_PRUNE_INTERVAL_MS = 60 * 1000 // 1 min
const PROJECT_IDLE_EVICTION_MS = 3 * 60 * 1000 // 3 mins
const MAX_WATCHED_PROJECTS = 2

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
  const projectMetrics = new CappedMap<string, DaemonMetrics>(100)
  const projectLastSeen = new CappedMap<string, number>(50)
  const sessionActivity = new CappedMap<string, { lastSeen: number; dispatches: number }>(20)
  const sessionToolCalls = new CappedMap<string, CapturedToolCall[]>(10)
  const sessionToolUsage = new CappedMap<string, SessionToolUsageState>(100)
  const activeHookDispatches = new CappedMap<string, ActiveHookDispatch>(10)

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
    sessionToolUsage,
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
  const prReviewMonitor = new PrReviewMonitor()

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
    prReviewMonitor,
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
    // Coalesce concurrent callers before doing any expensive work.
    const inflight = inFlight.get(cwd)
    if (inflight) return inflight

    const key = cacheKey(cwd, sessionId)
    const nextFingerprint = await buildSnapshotFingerprint(cwd)
    const existing = snapshots.get(key)
    if (existing && !hasSnapshotInvalidated(existing.fingerprint, nextFingerprint)) {
      return existing.snapshot
    }

    const computation = computeWarmStatusLineSnapshot(cwd, sessionId)
      .then((snapshot) => {
        snapshots.set(key, { snapshot, fingerprint: nextFingerprint })
        return snapshot
      })
      .finally(() => {
        inFlight.delete(cwd)
      })
    inFlight.set(cwd, computation)
    return computation
  }
}

function setupWatchers(
  caches: ReturnType<typeof createDaemonCaches>,
  transcriptMonitor: TranscriptMonitor,
  projectLastSeen: ReturnType<typeof createDaemonState>["projectLastSeen"]
) {
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
  watchers.register(join(projectRoot, "hooks/"), "hooks", flushSnapshots, { depth: 1 })

  const globalSettingsPath = getSwizSettingsPath()
  if (globalSettingsPath) {
    watchers.register(globalSettingsPath, "global-settings", flushSnapshots)
  }

  const registeredProjects = new Set<string>()

  const evictProject = (cwd: string) => {
    registeredProjects.delete(cwd)
    ghCache.invalidateProject(cwd)
    eligibilityCache.invalidateProject(cwd)
    gitStateCache.invalidateProject(cwd)
    projectSettingsCache.invalidateProject(cwd)
    manifestCache.invalidateProject(cwd)
    transcriptIndex.invalidateProject(cwd)
    sessionDataCache.invalidateProject(cwd)
    watchers.unregisterByLabelSuffix(`:${cwd}`)
    caches.upstreamSyncRegistry.unregister(cwd)
    caches.prReviewMonitor.clearProject(cwd)
    caches.cooldownRegistry.invalidateProject(cwd)
    for (const key of snapshots.keys()) {
      if (key.startsWith(cwd)) snapshots.delete(key)
    }
  }

  const invalidateProject = (cwd: string) => {
    ghCache.invalidateProject(cwd)
    eligibilityCache.invalidateProject(cwd)
    gitStateCache.invalidateProject(cwd)
    projectSettingsCache.invalidateProject(cwd)
    manifestCache.invalidateProject(cwd)
    transcriptIndex.invalidateProject(cwd)
    sessionDataCache.invalidateProject(cwd)
    for (const key of snapshots.keys()) {
      if (key.startsWith(cwd)) snapshots.delete(key)
    }
  }

  const registerProjectWatchers = (cwd: string) => {
    if (registeredProjects.has(cwd)) return

    // Limit the number of concurrently watched projects
    if (registeredProjects.size >= MAX_WATCHED_PROJECTS) {
      let oldestCwd: string | null = null
      let oldestTime = Infinity
      for (const projectCwd of registeredProjects) {
        if (projectCwd === cwd) continue
        const lastSeen = projectLastSeen.get(projectCwd) ?? 0
        if (lastSeen < oldestTime) {
          oldestTime = lastSeen
          oldestCwd = projectCwd
        }
      }
      if (oldestCwd) {
        stderrLog("project eviction", `[daemon] Evicting project ${oldestCwd} to stay within limit`)
        evictProject(oldestCwd)
      }
    }

    registeredProjects.add(cwd)
    const projectFlush = () => invalidateProject(cwd)
    const projectSettings = getProjectSettingsPath(cwd)
    if (projectSettings) watchers.register(projectSettings, `project-settings:${cwd}`, projectFlush)
    watchers.register(join(cwd, ".git/"), `git:${cwd}`, projectFlush, { depth: 2 })
    const transcriptWatchFlush = () => {
      projectFlush()
      void transcriptMonitor.checkProject(cwd)
    }
    for (const transcriptWatch of transcriptWatchPathsForProject(cwd)) {
      watchers.register(transcriptWatch.path, transcriptWatch.label, transcriptWatchFlush, {
        depth: 1,
      })
    }
    // Auto-register project for periodic upstream sync and sync immediately
    void caches.upstreamSyncRegistry
      .register(cwd)
      .then(() => caches.upstreamSyncRegistry.syncNow(cwd))
      .catch(() => {})
    watchers.start().catch(() => {})
  }

  startMemoryMonitoring()

  watchers.start().then(undefined, () => {})

  return { registeredProjects, registerProjectWatchers, evictProject, invalidateProject }
}

function restartLaunchdDaemon() {
  // Bun.spawn(["kill", "-9", process.pid.toString()], {
  //   stdout: "pipe",
  //   stderr: "pipe",
  // })
  Bun.spawn(["launchctl", "kickstart", "-k", "gui/501/com.swiz.daemon"], {
    stdout: "pipe",
    stderr: "pipe",
  })
}

function startMemoryMonitoring() {
  setInterval(() => {
    const memoryUsage = process.memoryUsage()
    const bytes = memoryUsage.rss
    const external = memoryUsage.external
    const heapUsed = memoryUsage.heapUsed
    const heapTotal = memoryUsage.heapTotal
    const parts = [
      `rss=${formatBytes(bytes)}`,
      `heapTotal=${formatBytes(heapTotal)}`,
      `heapUsed=${formatBytes(heapUsed)}`,
      `external=${formatBytes(external)}`,
    ]
    process.stdout.write(`Mem: ${parts.join(", ")}\n`)
    if (Object.values(memoryUsage).some((b) => b > 6 * 1024 * 1024 * 1024)) {
      stderrLog(
        "memory warning",
        `[daemon] Restarting due to excessive memory usage (${parts.join()}})`
      )
      restartLaunchdDaemon()
    }
  }, 1000)
}

function evictIdleProjects(
  now: number,
  state: ReturnType<typeof createDaemonState>,
  registeredProjects: Set<string>,
  evictProject: (cwd: string) => void
) {
  const projectCutoff = now - PROJECT_IDLE_EVICTION_MS
  for (const [cwd, lastSeen] of state.projectLastSeen) {
    if (lastSeen >= projectCutoff) continue
    state.projectLastSeen.delete(cwd)
    state.projectMetrics.delete(cwd)

    // Manual eviction of idle projects
    if (registeredProjects.has(cwd)) {
      evictProject(cwd)
    }
  }
}

function createPruner(
  state: ReturnType<typeof createDaemonState>,
  caches: ReturnType<typeof createDaemonCaches>,
  registeredProjects: Set<string>,
  transcriptMonitor: TranscriptMonitor,
  evictProject: (cwd: string) => void
) {
  let lastPruneAt = 0
  let lastLogPruneAt = 0
  const LOG_PRUNE_INTERVAL_MS = 5 * 60 * 1000 // Prune logs every 5 minutes

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
      const recent = toolCalls.filter((call) => Date.parse(call.timestamp) >= cutoffMs)
      if (recent.length === 0) {
        state.sessionToolCalls.delete(sessionId)
        continue
      }
      if (recent.length !== toolCalls.length) state.sessionToolCalls.set(sessionId, recent)
    }
    for (const [sessionId, usage] of state.sessionToolUsage) {
      if (usage.lastSeen < cutoffMs) state.sessionToolUsage.delete(sessionId)
    }

    evictIdleProjects(now, state, registeredProjects, evictProject)
    transcriptMonitor.pruneOldSessions(new Set(state.sessionActivity.keys()))
    caches.prReviewMonitor.pruneOldSessions(new Set(state.sessionActivity.keys()))

    // Integrated log pruning
    if (now - lastLogPruneAt >= LOG_PRUNE_INTERVAL_MS) {
      lastLogPruneAt = now
      void pruneTempLogs()
    }
  }
}

async function startDaemonProcess(_args: string[], port: number): Promise<void> {
  const state = createDaemonState()
  const caches = createDaemonCaches()
  const transcriptMonitor = new WorkerTranscriptMonitor(caches) as unknown as TranscriptMonitor
  const { registeredProjects, registerProjectWatchers, evictProject } = setupWatchers(
    caches,
    transcriptMonitor,
    state.projectLastSeen
  )

  let isClosing = false
  const cleanup = (reason: string) => {
    if (isClosing) return
    isClosing = true
    process.stderr.write(`\nClosing daemon components (${reason})... `)
    caches.watchers.close()
    process.stderr.write("Watchers... ")
    transcriptMonitor.terminate()
    process.stderr.write("Transcript monitor... ")
    caches.ciWatchRegistry.close()
    process.stderr.write("CI registry... ")
    caches.upstreamSyncRegistry.close()
    process.stderr.write("Upstream sync... ")
    caches.workerRuntime.close()
    process.stderr.write("Worker runtime... ")
    process.stderr.write("Done.\n")
    if (reason !== "exit") process.exit(0)
  }

  process.on("SIGINT", () => cleanup("SIGINT"))
  process.on("SIGTERM", () => cleanup("SIGTERM"))
  process.on("exit", () => cleanup("exit"))

  const cwd = process.cwd()

  state.touchProject(cwd)
  const pruneTranscriptMemory = createPruner(
    state,
    caches,
    registeredProjects,
    transcriptMonitor,
    evictProject
  )
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
    sessionToolUsage: state.sessionToolUsage,
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
    prReviewMonitor: caches.prReviewMonitor,
  })

  // Register initial project for periodic upstream sync
  void caches.upstreamSyncRegistry.register(cwd)
  registerProjectWatchers(cwd)

  startTranscriptMonitoring(registeredProjects, transcriptMonitor)

  console.log(`Daemon listening on ${server.url}`)
}

function startTranscriptMonitoring(
  registeredProjects: Set<string>,
  transcriptMonitor: TranscriptMonitor
) {
  // Start periodic transcript monitoring for all registered projects
  void logPseudoHook("Transcript monitor starting")
  let isMonitoring = false
  const monitoringInterval = setInterval(() => {
    if (isMonitoring) return
    isMonitoring = true
    void (async () => {
      try {
        await Promise.allSettled(
          [...registeredProjects].map((cwd) => transcriptMonitor.checkProject(cwd))
        )
      } catch (err) {
        stderrLog("monitoring loop exception", `[daemon] Transcript monitor error: ${err}`)
        void logPseudoHook(`Error in monitor loop: ${err}`)
      } finally {
        isMonitoring = false
      }
    })()
  }, 10000)

  // Ensure monitoring loop stops on graceful shutdown
  process.on("exit", () => {
    clearInterval(monitoringInterval)
  })
}

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
