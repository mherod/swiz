import { LRUCache } from "lru-cache"
import { CONFIGURABLE_AGENTS } from "../agents.ts"
import { stderrLog } from "../debug.ts"
import { DISPATCH_ROUTES } from "../dispatch/index.ts"
import { startHookLogMaintenance } from "../hook-log.ts"
import { pruneTempLogs } from "../log-rotation.ts"
import { validateDispatchRoutes } from "../manifest.ts"
import { resolveProjectRoot } from "../project-identity.ts"
import { setGlobalTaskStateCache } from "../tasks/task-recovery.ts"
import { TaskStateCache } from "../tasks/task-state-cache.ts"
import { findAllProviderSessions, type Session } from "../transcript-utils.ts"
import type { Command } from "../types.ts"
import { clearFileCache, getFileCacheMemoryStats } from "../utils/file-cache.ts"
import { recordTranscriptMonitorCheck } from "./daemon/cache/metrics.ts"
import type { TranscriptMonitor } from "./daemon/cache/transcript-monitor.ts"
import {
  transcriptWorkerOptions,
  WorkerTranscriptMonitor,
} from "./daemon/cache/worker-transcript-monitor.ts"
import { CiWatchRegistry, notifyCiCompletion } from "./daemon/ci-watch-registry.ts"
import { DAEMON_PORT, fetchDaemonStatus } from "./daemon/daemon-admin.ts"
import { logPseudoHook } from "./daemon/daemon-logging.ts"
import type { SessionDivergenceState } from "./daemon/divergence.ts"
import { LifecycleTaskRegistry } from "./daemon/lifecycle-task-registry.ts"
import { memoryPressureConfig, readOsRss, startMemoryMonitoring } from "./daemon/memory-pressure.ts"
import { applyDaemonMemoryPressure } from "./daemon/memory-relief.ts"
import { evictIdleProjects, setupWatchers, snapshotCacheKey } from "./daemon/project-lifecycle.ts"

import {
  CappedMap,
  CooldownRegistry,
  createMetrics,
  type DaemonMetrics,
  FileWatcherRegistry,
  GhQueryCache,
  GitStateCache,
  HookEligibilityCache,
  LastUserMessageCache,
  ManifestCache,
  ProjectSettingsCache,
  RepositoryCapabilityCache,
  TranscriptIndexCache,
} from "./daemon/runtime-cache.ts"
import { sessionDataCache } from "./daemon/session-data.ts"
import { sessionToolCallPersistenceQueue } from "./daemon/session-tool-call-persistence.ts"
import {
  buildSnapshotFingerprint,
  type CachedSnapshot,
  hasSnapshotInvalidated,
  type SnapshotFingerprint,
} from "./daemon/snapshot.ts"
import { startTranscriptMonitoring } from "./daemon/transcript-monitor-loop.ts"
import type { ActiveHookDispatch } from "./daemon/types.ts"
import { UpstreamSyncRegistry } from "./daemon/upstream-sync.ts"
import {
  buildSessionToolUsageStateFromCapturedCalls,
  type CapturedToolCall,
  HYDRATION_CONCURRENCY,
  MAX_HYDRATED_SESSIONS,
  mergeCapturedToolCalls,
  mergeSessionToolUsageStates,
  readPersistedSessionToolCalls,
  restartDaemon,
  type SessionToolUsageState,
} from "./daemon/utils.ts"
import { startDaemonWebServer } from "./daemon/web-server.ts"
import { DaemonWorkerRuntime } from "./daemon/worker-runtime.ts"
import { installDaemonLaunchAgent, uninstallDaemonLaunchAgent } from "./install.ts"
import { ensureShimInstallation } from "./shim.ts"
import { computeWarmStatusLineSnapshot, type WarmStatusLineSnapshot } from "./status-line.ts"

export {
  deleteProjectSnapshots,
  evictIdleProjects,
  MAX_WATCHED_PROJECTS,
  PROJECT_IDLE_EVICTION_MS,
  type ProjectWatcherManager,
  setupWatchers,
  snapshotCacheKey,
} from "./daemon/project-lifecycle.ts"

export const TRANSCRIPT_MEMORY_RETENTION_MS = 30 * 60 * 1000 // 30 mins
export const TRANSCRIPT_MEMORY_PRUNE_INTERVAL_MS = 60 * 1000 // 1 min
const DAEMON_FLAGS = new Set(["--restart", "--install", "--uninstall", "status"])

/** Subcommands work as bare words or flags: `swiz daemon restart` ≡ `--restart`. */
const DAEMON_ALIASES: Record<string, string> = {
  restart: "--restart",
  install: "--install",
  uninstall: "--uninstall",
  "--status": "status",
}

export function normalizeDaemonArgs(args: readonly string[]): string[] {
  return args.map((arg) => DAEMON_ALIASES[arg] ?? arg)
}

/**
 * Reject unrecognised arguments. Unknown words previously fell through to starting a
 * foreground daemon, so a typo silently became a second server.
 */
export function validateDaemonArgs(args: readonly string[]): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--port") {
      const value = args[++i]
      if (!value || !Number.isInteger(Number(value))) {
        throw new Error("swiz daemon: --port requires a numeric port")
      }
      continue
    }
    if (DAEMON_FLAGS.has(arg)) continue
    const hint = DAEMON_FLAGS.has(`--${arg}`) ? ` Did you mean --${arg}?` : ""
    throw new Error(`swiz daemon: unknown argument "${arg}".${hint}`)
  }
}

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

export interface DaemonState {
  globalMetrics: DaemonMetrics
  projectMetrics: CappedMap<string, DaemonMetrics>
  projectLastSeen: CappedMap<string, number>
  sessionActivity: CappedMap<string, { lastSeen: number; dispatches: number }>
  sessionToolCalls: CappedMap<string, CapturedToolCall[]>
  sessionToolUsage: CappedMap<string, SessionToolUsageState>
  sessionDivergence: CappedMap<string, SessionDivergenceState>
  activeHookDispatches: CappedMap<string, ActiveHookDispatch>
  recentHookAllowMessages: CappedMap<string, string>
  sessionComplianceState: CappedMap<
    string,
    {
      current: {
        state: string
        at: number
        taskDurations?: Array<{ id: string; status: string; durationMs: number }>
      } | null
      transitions: {
        state: string
        at: number
        taskDurations?: Array<{ id: string; status: string; durationMs: number }>
      }[]
    }
  >
  getProjectMetrics: (cwd: string) => DaemonMetrics
  touchProject: (cwd: string) => void
}

export function createDaemonState(): DaemonState {
  const globalMetrics = createMetrics()
  const projectMetrics = new CappedMap<string, DaemonMetrics>(100)
  const projectLastSeen = new CappedMap<string, number>(50)
  const sessionActivity = new CappedMap<string, { lastSeen: number; dispatches: number }>(10)
  const sessionToolCalls = new CappedMap<string, CapturedToolCall[]>(10)
  const sessionToolUsage = new CappedMap<string, SessionToolUsageState>(30)
  const sessionDivergence = new CappedMap<string, SessionDivergenceState>(30)
  const activeHookDispatches = new CappedMap<string, ActiveHookDispatch>(10)
  const recentHookAllowMessages = new CappedMap<string, string>(128)
  const sessionComplianceState = new CappedMap<
    string,
    {
      current: {
        state: string
        at: number
        taskDurations?: Array<{ id: string; status: string; durationMs: number }>
      } | null
      transitions: {
        state: string
        at: number
        taskDurations?: Array<{ id: string; status: string; durationMs: number }>
      }[]
    }
  >(200)

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
    sessionDivergence,
    activeHookDispatches,
    recentHookAllowMessages,
    sessionComplianceState,
    getProjectMetrics,
    touchProject,
  }
}

export interface DaemonCaches {
  watchers: FileWatcherRegistry
  ghCache: GhQueryCache
  eligibilityCache: HookEligibilityCache
  transcriptIndex: TranscriptIndexCache
  cooldownRegistry: CooldownRegistry
  ciWatchRegistry: CiWatchRegistry
  upstreamSyncRegistry: UpstreamSyncRegistry
  workerRuntime: DaemonWorkerRuntime
  gitStateCache: GitStateCache
  lastUserMessageCache: LastUserMessageCache
  projectSettingsCache: ProjectSettingsCache
  repositoryCapabilityCache: RepositoryCapabilityCache
  manifestCache: ManifestCache
  snapshots: LRUCache<string, CachedSnapshot>
  taskStateCache: TaskStateCache
  lifecycleTaskRegistry: LifecycleTaskRegistry
}

export function createDaemonCaches(): DaemonCaches {
  const watchers = new FileWatcherRegistry()
  const ghCache = new GhQueryCache()
  const eligibilityCache = new HookEligibilityCache()
  const transcriptIndex = new TranscriptIndexCache()
  const cooldownRegistry = new CooldownRegistry()
  const ciWatchRegistry = new CiWatchRegistry({ notify: notifyCiCompletion })
  const upstreamSyncRegistry = new UpstreamSyncRegistry()
  const workerRuntime = new DaemonWorkerRuntime()
  const gitStateCache = new GitStateCache()
  const lastUserMessageCache = new LastUserMessageCache()
  const projectSettingsCache = new ProjectSettingsCache()
  const repositoryCapabilityCache = new RepositoryCapabilityCache()
  const manifestCache = new ManifestCache(projectSettingsCache)
  const snapshots = new LRUCache<string, CachedSnapshot>({ max: 200 })
  const taskStateCache = new TaskStateCache()
  const lifecycleTaskRegistry = new LifecycleTaskRegistry()

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
    lastUserMessageCache,
    projectSettingsCache,
    repositoryCapabilityCache,
    manifestCache,
    snapshots,
    taskStateCache,
    lifecycleTaskRegistry,
  }
}

export interface SnapshotResolverOptions {
  buildFingerprint?: (cwd: string) => Promise<SnapshotFingerprint>
  computeSnapshot?: (cwd: string, sessionId?: string | null) => Promise<WarmStatusLineSnapshot>
}

export function buildSnapshotResolver(
  snapshots: LRUCache<string, CachedSnapshot>,
  opts?: SnapshotResolverOptions
) {
  const buildFingerprint = opts?.buildFingerprint ?? buildSnapshotFingerprint
  const computeSnapshot = opts?.computeSnapshot ?? computeWarmStatusLineSnapshot
  // In-flight coalescing: concurrent requests for the same cwd+session share one computation.
  const inFlight = new Map<string, Promise<WarmStatusLineSnapshot>>()

  return (cwd: string, sessionId: string | null | undefined): Promise<WarmStatusLineSnapshot> => {
    const key = snapshotCacheKey(cwd, sessionId)

    // Coalesce concurrent callers before doing any expensive work.
    const inflight = inFlight.get(key)
    if (inflight) return inflight

    const computation = (async (): Promise<WarmStatusLineSnapshot> => {
      const nextFingerprint = await buildFingerprint(cwd)
      const existing = snapshots.get(key)
      if (existing && !hasSnapshotInvalidated(existing.fingerprint, nextFingerprint)) {
        return existing.snapshot
      }

      const snapshot = await computeSnapshot(cwd, sessionId)
      snapshots.set(key, { snapshot, fingerprint: nextFingerprint })
      return snapshot
    })().finally(() => {
      inFlight.delete(key)
    })

    inFlight.set(key, computation)
    return computation
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
      if (activity.lastSeen < cutoffMs) {
        state.sessionActivity.delete(sessionId)
        caches.lifecycleTaskRegistry.clearSession(sessionId)
      }
    }
    sessionDataCache.pruneSessionsPerProject(3)
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
    caches.lastUserMessageCache.pruneOlderThan(cutoffMs)

    evictIdleProjects(now, state, registeredProjects, evictProject)
    transcriptMonitor.pruneOldSessions(new Set(state.sessionActivity.keys()))

    // Integrated log pruning
    if (now - lastLogPruneAt >= LOG_PRUNE_INTERVAL_MS) {
      lastLogPruneAt = now
      void pruneTempLogs()
    }
  }
}

interface HydratableSessionState {
  sessionActivity: Map<string, { lastSeen: number; dispatches: number }>
  sessionToolCalls: Map<string, CapturedToolCall[]>
  sessionToolUsage: Map<string, SessionToolUsageState>
}

function recoverLastSeenMs(calls: CapturedToolCall[], fallbackMs: number): number {
  let lastSeen = fallbackMs
  for (const call of calls) {
    const parsed = Date.parse(call.timestamp)
    if (Number.isFinite(parsed)) lastSeen = Math.max(lastSeen, parsed)
  }
  return lastSeen
}

interface HydratedSessionResult {
  session: Session
  mergedCalls: CapturedToolCall[]
  lastSeen: number
}

async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const idx = nextIndex++
      results[idx] = await fn(items[idx]!)
    }
  })
  await Promise.all(workers)
  return results
}

async function readSessionData(
  cwd: string,
  session: Session,
  readToolCalls: (cwd: string, sessionId: string) => Promise<CapturedToolCall[]>,
  cutoffMs: number
): Promise<HydratedSessionResult | null> {
  try {
    const persisted = await readToolCalls(cwd, session.id)
    if (!persisted || persisted.length === 0) return null
    const lastSeen = recoverLastSeenMs(persisted, session.mtime)
    if (lastSeen < cutoffMs) return null
    return { session, mergedCalls: persisted, lastSeen }
  } catch {
    return null
  }
}

function applyHydratedSession(item: HydratedSessionResult, state: HydratableSessionState): boolean {
  const { session, mergedCalls, lastSeen } = item
  const combinedCalls = mergeCapturedToolCalls(
    mergedCalls,
    state.sessionToolCalls.get(session.id) ?? []
  )
  if (combinedCalls.length === 0) return false

  const effectiveLastSeen = Math.max(lastSeen, recoverLastSeenMs(combinedCalls, session.mtime))
  state.sessionToolCalls.set(session.id, combinedCalls)
  state.sessionToolUsage.set(
    session.id,
    mergeSessionToolUsageStates(
      state.sessionToolUsage.get(session.id),
      buildSessionToolUsageStateFromCapturedCalls(combinedCalls, effectiveLastSeen)
    )
  )
  const previousActivity = state.sessionActivity.get(session.id)
  state.sessionActivity.set(session.id, {
    lastSeen: Math.max(previousActivity?.lastSeen ?? 0, effectiveLastSeen),
    dispatches: previousActivity?.dispatches ?? 0,
  })
  return true
}

export interface HydratePersistedSessionToolStateOptions {
  listSessions?: (cwd: string, home?: string, limit?: number) => Promise<Session[]>
  readToolCalls?: (cwd: string, sessionId: string) => Promise<CapturedToolCall[]>
  nowMs?: number
}

function resolveHydrationOptions(opts: HydratePersistedSessionToolStateOptions | undefined): {
  listSessions: (cwd: string, home?: string, limit?: number) => Promise<Session[]>
  readToolCalls: (cwd: string, sessionId: string) => Promise<CapturedToolCall[]>
  cutoffMs: number
} {
  const listSessions = opts?.listSessions ?? findAllProviderSessions
  const readToolCalls =
    opts?.readToolCalls ??
    ((projectCwd: string, sessionId: string) =>
      readPersistedSessionToolCalls(projectCwd, sessionId))
  const nowMs = opts?.nowMs ?? Date.now()
  return {
    listSessions,
    readToolCalls,
    cutoffMs: nowMs - TRANSCRIPT_MEMORY_RETENTION_MS,
  }
}

export async function hydratePersistedSessionToolState(
  cwd: string,
  state: HydratableSessionState,
  opts?: HydratePersistedSessionToolStateOptions
): Promise<number> {
  const { listSessions, readToolCalls, cutoffMs } = resolveHydrationOptions(opts)
  const discovered = await listSessions(cwd, undefined, MAX_HYDRATED_SESSIONS)
  const candidateSessions = discovered.slice(0, MAX_HYDRATED_SESSIONS)

  const readResults = await mapConcurrent(candidateSessions, HYDRATION_CONCURRENCY, (session) =>
    readSessionData(cwd, session, readToolCalls, cutoffMs)
  )

  const validResults: HydratedSessionResult[] = []
  for (const res of readResults) {
    if (res) validResults.push(res)
  }
  // Candidate sessions were discovered newest-first. Reverse to apply in
  // oldest-to-newest order so CappedMap evicts the oldest items when full.
  validResults.reverse()

  let hydratedCount = 0
  for (const item of validResults) {
    if (applyHydratedSession(item, state)) hydratedCount++
  }

  return hydratedCount
}

// eslint-disable-next-line max-lines-per-function -- daemon startup intentionally keeps lifecycle wiring together
async function startDaemonProcess(_args: string[], port: number): Promise<void> {
  const memoryConfig = memoryPressureConfig()
  // The thin CLI bootstrap deliberately skips loading the manifest on daemon
  // success. Validate the same routing contract once when the long-lived
  // daemon starts, while local fallback and general CLI startup retain their
  // own validation.
  validateDispatchRoutes(DISPATCH_ROUTES, CONFIGURABLE_AGENTS)
  const state = createDaemonState()
  const caches = createDaemonCaches()
  setGlobalTaskStateCache(caches.taskStateCache)
  const workerTranscriptMonitor = new WorkerTranscriptMonitor(caches, {
    ...transcriptWorkerOptions(),
    onCheckCompleted: (cwd, durationMs, outcome) => {
      const coordinatorMetrics = workerTranscriptMonitor.getCoordinatorMetrics()
      recordTranscriptMonitorCheck(state.globalMetrics, durationMs, outcome, coordinatorMetrics)
      recordTranscriptMonitorCheck(
        state.getProjectMetrics(cwd),
        durationMs,
        outcome,
        coordinatorMetrics
      )
    },
  })
  const transcriptMonitor = workerTranscriptMonitor as unknown as TranscriptMonitor
  Object.defineProperty(state.globalMetrics, "transcriptMonitorRpc", {
    get: () => workerTranscriptMonitor.getRpcMetrics(),
  })
  const projectLifecycle = setupWatchers(caches, transcriptMonitor, state.projectLastSeen)
  const { registeredProjects, registerProjectWatchers, evictProject } = projectLifecycle

  const memoryMonitoring = startMemoryMonitoring(
    state.globalMetrics,
    (degraded) => {
      applyDaemonMemoryPressure(degraded, {
        transcriptIndex: caches.transcriptIndex,
        snapshots: caches.snapshots,
        transcriptMonitor: workerTranscriptMonitor,
      })
      stderrLog(
        "daemon memory pressure",
        degraded
          ? "Sustained RSS pressure: pausing transcript checks and history reads; see /memory."
          : "RSS recovered: resuming transcript checks and history reads."
      )
    },
    memoryConfig,
    {
      osRss: readOsRss,
      now: Date.now,
      memory: () => {
        const fileCache = getFileCacheMemoryStats()
        const sessionCache = sessionDataCache.getMemoryStats()
        state.globalMetrics.memoryRuntime = {
          sampledAt: Date.now(),
          fileCacheEntries: fileCache.entries,
          fileCacheEstimatedBytes: fileCache.estimatedBytes,
          sessionCacheEntries: sessionCache.entries,
          sessionCacheEstimatedBytes: sessionCache.estimatedBytes,
          transcriptIndexEntries: caches.transcriptIndex.size,
          snapshotEntries: caches.snapshots.size,
          activeHookDispatches: state.activeHookDispatches.size,
          pendingPersistenceWrites: sessionToolCallPersistenceQueue.pendingCount(),
          transcriptWorker: workerTranscriptMonitor.getMemorySnapshot(),
          otherWorkerMemory: null,
        }
        return process.memoryUsage()
      },
    }
  )
  const stopHookLogMaintenance = startHookLogMaintenance()

  let isClosing = false
  let stopTranscriptMonitoring = () => {}
  const cleanup = async (reason: string, exitCode = 0) => {
    if (isClosing) return
    isClosing = true
    stopTranscriptMonitoring()
    memoryMonitoring.stop()
    process.stderr.write(`\nClosing daemon components (${reason})... `)
    if (reason !== "exit") {
      await Promise.race([sessionToolCallPersistenceQueue.flush(), Bun.sleep(2_000)])
      process.stderr.write("Session telemetry... ")
    }
    projectLifecycle.close()
    process.stderr.write("Projects... ")
    transcriptMonitor.terminate()
    process.stderr.write("Transcript monitor... ")
    caches.ciWatchRegistry.close()
    process.stderr.write("CI registry... ")
    caches.workerRuntime.close()
    process.stderr.write("Worker runtime... ")
    stopHookLogMaintenance()
    process.stderr.write("Hook logs... ")
    caches.taskStateCache.close()
    caches.lifecycleTaskRegistry.clear()
    setGlobalTaskStateCache(null)
    process.stderr.write("Task cache... ")
    process.stderr.write("Done.\n")
    if (reason !== "exit") process.exit(exitCode)
  }

  process.on("SIGINT", () => void cleanup("SIGINT"))
  process.on("SIGTERM", () => void cleanup("SIGTERM"))
  process.on("exit", () => void cleanup("exit"))

  const cwd = process.cwd()
  const projectRoot = await resolveProjectRoot(cwd)
  const hydratedSessions = await hydratePersistedSessionToolState(projectRoot, state)
  // Release file-cache entries accumulated during session discovery.
  // findAllProviderSessions reads prefixes of every session file across all
  // providers to match by cwd. Without clearing, these prefix strings remain
  // pinned in the module-level cache.
  clearFileCache()
  Bun.gc(true)
  if (hydratedSessions > 0) {
    stderrLog(
      "daemon startup hydration",
      `[daemon] hydrated ${hydratedSessions} persisted session tool-call log${hydratedSessions === 1 ? "" : "s"} for recovery`
    )
  }

  state.touchProject(projectRoot)

  // Self-heal the shell shim installation in the background
  ensureShimInstallation().catch((err) => {
    stderrLog("daemon startup", `[daemon] Failed to heal shim installation: ${err}`)
  })

  const pruneTranscriptMemory = createPruner(
    state,
    caches,
    registeredProjects,
    transcriptMonitor,
    evictProject
  )
  const resolveSnapshot = buildSnapshotResolver(caches.snapshots)

  // Register the canonical initial root before the web context exposes its
  // known-project list, so raw process.cwd() aliases never leak into identity maps.
  registerProjectWatchers(projectRoot)

  // Watchers and workers already started keep the process alive, so a failed bind
  // (e.g. port in use) must tear them down and exit rather than idle forever.
  let server: ReturnType<typeof startDaemonWebServer>
  try {
    server = startDaemonWebServer({
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
      sessionDivergence: state.sessionDivergence,
      activeHookDispatches: state.activeHookDispatches,
      recentHookAllowMessages: state.recentHookAllowMessages,
      sessionComplianceState: state.sessionComplianceState,
      projectMetrics: state.projectMetrics,
      ghCache: caches.ghCache,
      eligibilityCache: caches.eligibilityCache,
      cooldownRegistry: caches.cooldownRegistry,
      gitStateCache: caches.gitStateCache,
      repositoryCapabilityCache: caches.repositoryCapabilityCache,
      lastUserMessageCache: caches.lastUserMessageCache,
      ciWatchRegistry: caches.ciWatchRegistry,
      upstreamSyncRegistry: caches.upstreamSyncRegistry,
      projectSettingsCache: caches.projectSettingsCache,
      registeredProjects,
      projectLastSeen: state.projectLastSeen,
      resolveSnapshot,
      watchers: caches.watchers,
      snapshots: caches.snapshots,
      workerRuntime: caches.workerRuntime,
      taskStateCache: caches.taskStateCache,
      lifecycleTaskRegistry: caches.lifecycleTaskRegistry,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`swiz daemon: ${message}\n`)
    await cleanup("startup failure", 1)
    return
  }

  void logPseudoHook("Transcript monitor starting")
  stopTranscriptMonitoring = startTranscriptMonitoring(
    registeredProjects,
    transcriptMonitor,
    state.globalMetrics,
    (error) => {
      stderrLog("monitoring loop exception", `Transcript monitor error: ${error}`)
      void logPseudoHook(`Error in monitor loop: ${error}`)
    }
  ).stop

  console.log(`Daemon listening on ${server.url}`)
}

export const daemonCommand: Command = {
  name: "daemon",
  description: "Run a background web server",
  usage: "swiz daemon [--port <port>] [restart | install | uninstall | status]",
  options: [
    { flags: "--port <port>", description: "Port to listen on (default: 7943)" },
    {
      flags: "restart, --restart",
      description: "Stop any daemon on the port, then start fresh",
    },
    { flags: "install, --install", description: "Install as a LaunchAgent" },
    { flags: "uninstall, --uninstall", description: "Uninstall the LaunchAgent" },
    { flags: "status, --status", description: "Show daemon metrics and status" },
  ],
  async run(rawArgs) {
    const args = normalizeDaemonArgs(rawArgs)
    validateDaemonArgs(args)
    const portIndex = args.indexOf("--port")
    const port = portIndex !== -1 ? Number(args[portIndex + 1]) : DAEMON_PORT

    if (await handleDaemonSubcommand(args, port)) return

    await startDaemonProcess(args, port)
  },
}
