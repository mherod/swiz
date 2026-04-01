import { appendFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { LRUCache } from "lru-cache"
import { executeDispatch } from "../dispatch/execute.ts"
import { hookIdentifier, isInlineHookDef } from "../hook-types.ts"
import {
  getProjectSettingsPath,
  getSwizSettingsPath,
  invalidateSettingsCache,
  readSwizSettings,
} from "../settings.ts"
import { swizPseudoHookLogPath } from "../temp-paths.ts"
import { findAllProviderSessions, isHookFeedback } from "../transcript-utils.ts"
import type { Command } from "../types.ts"
import { CiWatchRegistry, notifyCiCompletion } from "./daemon/ci-watch-registry.ts"
import { DAEMON_PORT, fetchDaemonStatus } from "./daemon/daemon-admin.ts"
import { PrReviewMonitor } from "./daemon/pr-review-monitor.ts"
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
  type SessionToolUsageState,
  transcriptWatchPathsForProject,
} from "./daemon/utils.ts"
import { startDaemonWebServer } from "./daemon/web-server.ts"
import { DaemonWorkerRuntime } from "./daemon/worker-runtime.ts"
import { installDaemonLaunchAgent, uninstallDaemonLaunchAgent } from "./install.ts"
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
  const sessionToolUsage = new Map<string, SessionToolUsageState>()
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
  transcriptMonitor: TranscriptMonitor
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
      transcriptIndex.invalidateProject(cwd)
      sessionDataCache.invalidateProject(cwd)
    }
    const projectSettings = getProjectSettingsPath(cwd)
    if (projectSettings) watchers.register(projectSettings, `project-settings:${cwd}`, projectFlush)
    watchers.register(join(cwd, ".git/"), `git:${cwd}`, projectFlush)
    const transcriptWatchFlush = () => {
      projectFlush()
      void transcriptMonitor.checkProject(cwd)
    }
    for (const transcriptWatch of transcriptWatchPathsForProject(cwd)) {
      watchers.register(transcriptWatch.path, transcriptWatch.label, transcriptWatchFlush)
    }
    // Auto-register project for periodic upstream sync and sync immediately
    void caches.upstreamSyncRegistry
      .register(cwd)
      .then(() => caches.upstreamSyncRegistry.syncNow(cwd))
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

function evictIdleProjects(
  now: number,
  state: ReturnType<typeof createDaemonState>,
  caches: ReturnType<typeof createDaemonCaches>,
  registeredProjects: Set<string>
) {
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
    caches.prReviewMonitor.clearProject(cwd)
    for (const key of caches.snapshots.keys()) {
      if (key.startsWith(cwd)) caches.snapshots.delete(key)
    }
  }
}

function createPruner(
  state: ReturnType<typeof createDaemonState>,
  caches: ReturnType<typeof createDaemonCaches>,
  registeredProjects: Set<string>,
  transcriptMonitor: TranscriptMonitor
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
    for (const [sessionId, usage] of state.sessionToolUsage) {
      if (usage.lastSeen < cutoffMs) state.sessionToolUsage.delete(sessionId)
    }

    evictIdleProjects(now, state, caches, registeredProjects)
    transcriptMonitor.pruneOldSessions(new Set(state.sessionActivity.keys()))
    caches.prReviewMonitor.pruneOldSessions(new Set(state.sessionActivity.keys()))
  }
}

async function startDaemonProcess(_args: string[], port: number): Promise<void> {
  const state = createDaemonState()
  const caches = createDaemonCaches()
  const transcriptMonitor = new TranscriptMonitor(caches)
  const { registeredProjects, registerProjectWatchers } = setupWatchers(caches, transcriptMonitor)

  state.touchProject(process.cwd())
  const pruneTranscriptMemory = createPruner(state, caches, registeredProjects, transcriptMonitor)
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
  void caches.upstreamSyncRegistry.register(process.cwd())
  registerProjectWatchers(process.cwd())

  // Start periodic transcript monitoring for all registered projects
  void logPseudoHook(`Transcript monitor starting for initial project: ${process.cwd()}`)
  let isMonitoring = false
  setInterval(() => {
    if (isMonitoring) return
    isMonitoring = true
    void (async () => {
      try {
        for (const cwd of registeredProjects) {
          await transcriptMonitor.checkProject(cwd)
        }
      } catch (err) {
        console.error(`[daemon] Transcript monitor error: ${err}`)
        void logPseudoHook(`Error in monitor loop: ${err}`)
      } finally {
        isMonitoring = false
      }
    })()
  }, 10000)

  console.log(`Daemon listening on ${server.url}`)
}

async function logPseudoHook(message: string) {
  try {
    const timestamp = new Date().toISOString()
    await appendFile(swizPseudoHookLogPath(), `[${timestamp}] ${message}\n`)
  } catch (err) {
    console.error(`Failed to log pseudo-hook: ${err}`)
  }
}

/** CLI command: starts the daemon web server, or manages its LaunchAgent lifecycle. */
/**
 * Monitors session transcripts for new tool calls and triggers auto-steer.
 */
class TranscriptMonitor {
  private lastToolCallFingerprints = new Map<string, string>()
  private lastMessageFingerprints = new Map<string, string>()

  constructor(private caches: ReturnType<typeof createDaemonCaches>) {}

  /**
   * Returns true if any hook for the given event is within its cooldown window (dispatch should be skipped).
   * Marks the cooldown for the first non-cooled hook when returning false.
   */
  private isEventOnCooldown(
    manifestGroups: Awaited<
      ReturnType<ReturnType<typeof createDaemonCaches>["manifestCache"]["get"]>
    >,
    event: string,
    cwd: string
  ): boolean {
    const groups = manifestGroups.filter((g) => g.event === event)
    for (const group of groups) {
      for (const hook of group.hooks) {
        const cooldown = isInlineHookDef(hook)
          ? (hook.hook.cooldownSeconds ?? 30)
          : (hook.cooldownSeconds ?? 30)
        const id = hookIdentifier(hook)
        if (this.caches.cooldownRegistry.checkAndMark(id, cooldown, cwd)) {
          void logPseudoHook(`${event} cooldown active for ${id} in ${cwd}, skipping`)
          console.error(`[daemon] ${event} cooldown active for ${id}, skipping dispatch`)
          return true
        }
      }
    }
    return false
  }

  pruneOldSessions(activeSessions: Set<string>) {
    for (const sessionId of this.lastToolCallFingerprints.keys()) {
      if (!activeSessions.has(sessionId)) {
        this.lastToolCallFingerprints.delete(sessionId)
        this.lastMessageFingerprints.delete(sessionId)
      }
    }
  }

  async checkProject(cwd: string): Promise<void> {
    const cached = await this.caches.projectSettingsCache.get(cwd)
    const settings = cached.settings
    const globalSettings = await readSwizSettings()
    const autoSteerEnabled =
      settings?.autoSteerTranscriptWatching ?? globalSettings.autoSteerTranscriptWatching
    const speakEnabled = settings?.speak ?? globalSettings.speak
    if (!autoSteerEnabled && !speakEnabled) return

    const sessions = await findAllProviderSessions(cwd)
    // Only check the most recent session for performance
    const latestSession = sessions[0]
    if (!latestSession) return

    const data = await sessionDataCache.get(latestSession)
    if (!data) return

    void logPseudoHook(
      `checkProject: autoSteer=${autoSteerEnabled} speak=${speakEnabled} session=${latestSession.id} lastToolCallFingerprint=${data.lastToolCallFingerprint}`
    )

    // Fetch manifest once for cooldown extraction
    const manifestGroups = await this.caches.manifestCache.get(cwd)

    if (autoSteerEnabled && data.lastToolCallFingerprint) {
      const prevFingerprint = this.lastToolCallFingerprints.get(latestSession.id)
      if (prevFingerprint !== data.lastToolCallFingerprint) {
        const msg = `tool call fingerprint change in ${latestSession.id}: ${prevFingerprint} -> ${data.lastToolCallFingerprint}`
        console.error(`[daemon] ${msg}`)
        void logPseudoHook(msg)
        this.lastToolCallFingerprints.set(latestSession.id, data.lastToolCallFingerprint)

        // Detect the recent tool call to avoid loops
        let toolCallMessage: (typeof data.messages)[0] | undefined
        for (let i = data.messages.length - 1; i >= Math.max(0, data.messages.length - 10); i--) {
          const msg = data.messages[i]
          if (msg && msg.role === "assistant" && (msg.toolCalls?.length ?? 0) > 0) {
            toolCallMessage = msg
            break
          }
        }

        if (toolCallMessage) {
          if (this.isEventOnCooldown(manifestGroups, "postToolUse", cwd)) return

          // Trigger postToolUse hook
          const triggerMsg = `new tool call detected in ${latestSession.id}, triggering auto-steer: ${toolCallMessage.toolCalls![0]!.name}`
          console.error(`[daemon] ${triggerMsg}`)
          void logPseudoHook(triggerMsg)
          const payload = {
            session_id: latestSession.id,
            transcript_path: latestSession.path,
            cwd,
            tool_name: toolCallMessage.toolCalls![0]!.name,
            tool_input: toolCallMessage.toolCalls![0]!.detail,
          }

          void executeDispatch({
            canonicalEvent: "postToolUse",
            hookEventName: "postToolUse",
            payloadStr: JSON.stringify(payload),
            daemonContext: true,
            manifestProvider: async (cwd) => this.caches.manifestCache.get(cwd),
          })
        }
      }
    }

    if (speakEnabled && data.lastMessageFingerprint) {
      const prevMessageFingerprint = this.lastMessageFingerprints.get(latestSession.id)
      if (prevMessageFingerprint !== data.lastMessageFingerprint) {
        const msg = `message fingerprint change in ${latestSession.id}: ${prevMessageFingerprint} -> ${data.lastMessageFingerprint}`
        console.error(`[daemon] ${msg}`)
        void logPseudoHook(msg)
        this.lastMessageFingerprints.set(latestSession.id, data.lastMessageFingerprint)

        // Find the actual message for text
        let textMessage: (typeof data.messages)[0] | undefined
        for (let i = data.messages.length - 1; i >= Math.max(0, data.messages.length - 10); i--) {
          const msg = data.messages[i]
          if (msg && msg.role === "assistant" && msg.text && !isHookFeedback(msg.text)) {
            textMessage = msg
            break
          }
        }

        if (textMessage) {
          if (this.isEventOnCooldown(manifestGroups, "notification", cwd)) return

          // Trigger notification hook for TTS
          const triggerMsg = `new assistant message detected in ${latestSession.id}, triggering speak`
          console.error(`[daemon] ${triggerMsg}`)
          void logPseudoHook(triggerMsg)
          const payload = {
            session_id: latestSession.id,
            transcript_path: latestSession.path,
            cwd,
            type: "assistant_message",
            message: textMessage.text,
          }

          void executeDispatch({
            canonicalEvent: "notification",
            hookEventName: "notification",
            payloadStr: JSON.stringify(payload),
            daemonContext: true,
            manifestProvider: async (cwd) => this.caches.manifestCache.get(cwd),
          })
        }
      }
    }
  }
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
