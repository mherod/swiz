import { dirname, join } from "node:path"
import { LRUCache } from "lru-cache"
import { getGitBranchStatus } from "../git-helpers.ts"
import { getProjectSettingsPath, getStatePath, getSwizSettingsPath } from "../settings.ts"
import { readTasks } from "../tasks/task-repository.ts"
import { getSessions } from "../tasks/task-resolver.ts"
import {
  findAllProviderSessions,
  isHookFeedback,
  parseTranscriptEntries,
  type Session,
} from "../transcript-utils.ts"
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
import {
  buildProjectTasksView,
  buildSessionTasksView,
  type CapturedToolCall,
  extractMessageText,
  extractToolCalls,
  mergeToolStats,
  type ProjectTaskPreview,
  restartDaemon,
  type SessionMessage,
  type SessionTaskPreview,
  type SessionTaskSummary,
  supplementMessagesWithCapturedToolCalls,
  transcriptWatchPathsForProject,
} from "./daemon/utils.ts"
import { startDaemonWebServer } from "./daemon/web-server.ts"
import { DaemonWorkerRuntime } from "./daemon/worker-runtime.ts"
import {
  computeWarmStatusLineSnapshot,
  getGhCachePath,
  type WarmStatusLineSnapshot,
} from "./status-line.ts"

const GITHUB_REFRESH_WINDOW_MS = 20_000
const TRANSCRIPT_MEMORY_RETENTION_MS = 12 * 60 * 60 * 1000
const TRANSCRIPT_MEMORY_PRUNE_INTERVAL_MS = 5 * 60 * 1000

interface SnapshotFingerprint {
  git: string
  projectSettingsMtimeMs: number
  projectStateMtimeMs: number
  globalSettingsMtimeMs: number
  ghCacheMtimeMs: number
  githubBucket: number
}

export interface CachedSnapshot {
  snapshot: WarmStatusLineSnapshot
  fingerprint: SnapshotFingerprint
}

interface SessionPreview {
  id: string
  provider?: Session["provider"]
  format?: Session["format"]
  mtime: number
  startedAt?: number
  lastMessageAt?: number
  dispatches?: number
}

export interface ActiveHookDispatch {
  requestId: string
  canonicalEvent: string
  hookEventName: string
  cwd: string
  sessionId: string | null
  hooks: string[]
  startedAt: number
  toolName?: string
  toolInputSummary?: string
}
export { CiWatchRegistry, type CiWatchRun, type CiWatchStatus } from "./daemon/ci-watch-registry.ts"
export {
  type CachedGitState,
  type CachedManifest,
  type CachedProjectSettings,
  CooldownRegistry,
  createMetrics,
  type DaemonMetrics,
  type EligibilitySnapshot,
  type EventMetrics,
  FileWatcherRegistry,
  GH_QUERY_TTL_MS,
  GhQueryCache,
  GitStateCache,
  HookEligibilityCache,
  ManifestCache,
  ProjectSettingsCache,
  recordDispatch,
  serializeMetrics,
  type TranscriptIndex,
  TranscriptIndexCache,
  type WatchEntry,
} from "./daemon/runtime-cache.ts"

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

interface SessionScanResult {
  hasMessages: boolean
  startedAt: number
  lastMessageAt: number
}

interface CachedSessionData {
  mtimeMs: number
  size: number
  startedAt: number
  lastMessageAt: number
  messages: SessionMessage[]
  toolStats: Array<{ name: string; count: number }>
  fallbackTimestamps: Map<string, string>
  lastAssignedFallbackMs: number
}

function messageFallbackKey(message: SessionMessage, occurrence: number): string {
  const toolSig = (message.toolCalls ?? []).map((tc) => `${tc.name}:${tc.detail}`).join("|")
  return `${message.role}\x00${message.text}\x00${toolSig}\x00${occurrence}`
}

class SessionDataCache {
  private entries = new LRUCache<string, CachedSessionData>({ max: 200 })

  private buildFromEntries(
    entries: ReturnType<typeof parseTranscriptEntries>,
    fileMtimeMs: number,
    prev?: CachedSessionData
  ): CachedSessionData {
    const messages: SessionMessage[] = []
    const toolCounts = new Map<string, number>()
    const fallbackTimestamps = new Map<string, string>()
    const seenSignatures = new Map<string, number>()
    const pendingFallback: Array<{ messageIndex: number; key: string }> = []

    let startedAt = 0
    let lastMessageAt = 0
    let lastAssignedFallbackMs = prev?.lastAssignedFallbackMs ?? 0

    for (const entry of entries) {
      if (entry.type !== "user" && entry.type !== "assistant") continue
      const content = entry.message?.content
      if (entry.type === "user" && isHookFeedback(content)) continue

      const extracted = extractMessageText(content)
      const toolCalls = extractToolCalls(content)
      for (const tc of toolCalls) {
        toolCounts.set(tc.name, (toolCounts.get(tc.name) ?? 0) + 1)
      }
      if (!extracted && toolCalls.length === 0) continue

      const message: SessionMessage = {
        role: entry.type,
        timestamp: entry.timestamp ?? null,
        text: extracted,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      }
      messages.push(message)

      const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0
      if (ts > 0) {
        if (startedAt === 0 || ts < startedAt) startedAt = ts
        if (ts > lastMessageAt) lastMessageAt = ts
        continue
      }

      const baseSig = `${message.role}\x00${message.text}\x00${JSON.stringify(message.toolCalls ?? [])}`
      const seen = (seenSignatures.get(baseSig) ?? 0) + 1
      seenSignatures.set(baseSig, seen)
      pendingFallback.push({
        messageIndex: messages.length - 1,
        key: messageFallbackKey(message, seen),
      })
    }

    // Assign stable synthetic timestamps for transcripts that don't include per-message times.
    // Existing keys preserve prior assigned times; new keys get monotonic timestamps.
    let seed = Math.max(lastAssignedFallbackMs, fileMtimeMs - pendingFallback.length * 1000)
    for (let i = 0; i < pendingFallback.length; i++) {
      const target = pendingFallback[i]!
      const priorIso = prev?.fallbackTimestamps.get(target.key) ?? null
      let assignedMs = priorIso ? new Date(priorIso).getTime() : 0
      if (!assignedMs || Number.isNaN(assignedMs)) {
        const minForOrder = fileMtimeMs - (pendingFallback.length - i) * 1000
        assignedMs = Math.max(seed + 1000, minForOrder)
      }
      seed = Math.max(seed, assignedMs)
      const iso = new Date(assignedMs).toISOString()
      fallbackTimestamps.set(target.key, iso)
      messages[target.messageIndex]!.timestamp = iso
      if (startedAt === 0 || assignedMs < startedAt) startedAt = assignedMs
      if (assignedMs > lastMessageAt) lastMessageAt = assignedMs
    }
    lastAssignedFallbackMs = seed

    const toolStats = [...toolCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)

    return {
      mtimeMs: fileMtimeMs,
      size: 0,
      startedAt,
      lastMessageAt,
      messages,
      toolStats,
      fallbackTimestamps,
      lastAssignedFallbackMs,
    }
  }

  async get(session: Pick<Session, "path" | "format">): Promise<CachedSessionData | null> {
    try {
      const file = Bun.file(session.path)
      if (!(await file.exists())) return null
      const info = await file.stat()
      const mtimeMs = info.mtimeMs ?? 0
      const size = info.size

      const cached = this.entries.get(session.path)
      if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
        return cached
      }

      const text = await file.text()
      const parsed = parseTranscriptEntries(text, session.format)
      const next = this.buildFromEntries(parsed, mtimeMs, cached)
      next.mtimeMs = mtimeMs
      next.size = size
      this.entries.set(session.path, next)
      return next
    } catch {
      return null
    }
  }

  pruneOlderThan(cutoffMs: number): void {
    for (const [sessionPath, entry] of this.entries) {
      const activityMs = Math.max(entry.lastMessageAt, entry.mtimeMs)
      if (activityMs < cutoffMs) this.entries.delete(sessionPath)
    }
  }

  invalidateAll(): void {
    this.entries.clear()
  }
}

const sessionDataCache = new SessionDataCache()

export { DaemonWorkerRuntime } from "./daemon/worker-runtime.ts"

async function scanSession(session: Pick<Session, "path" | "format">): Promise<SessionScanResult> {
  const empty = { hasMessages: false, startedAt: 0, lastMessageAt: 0 }
  const cached = await sessionDataCache.get(session)
  if (!cached) return empty
  if (cached.messages.length === 0) return empty
  return {
    hasMessages: true,
    startedAt: cached.startedAt,
    lastMessageAt: cached.lastMessageAt,
  }
}

export async function listProjectSessions(
  cwd: string,
  limit = 20,
  liveActivity?: Map<string, { lastSeen: number; dispatches: number }>,
  pinnedSessionId?: string
): Promise<{ sessionCount: number; sessions: SessionPreview[] }> {
  const all = await findAllProviderSessions(cwd)
  const candidates = all.slice(0, limit * 2)
  const pinned =
    typeof pinnedSessionId === "string" && pinnedSessionId.length > 0
      ? all.find((s) => s.id === pinnedSessionId || s.id.startsWith(pinnedSessionId))
      : null
  const scanTargets =
    pinned && !candidates.some((session) => session.id === pinned.id)
      ? [...candidates, pinned]
      : candidates
  const scans = await Promise.all(scanTargets.map((s) => scanSession(s)))
  const withMessages: Array<{ session: Session; scan: SessionScanResult }> = []
  for (let i = 0; i < scanTargets.length; i++) {
    if (scans[i]!.hasMessages) withMessages.push({ session: scanTargets[i]!, scan: scans[i]! })
  }
  const ACTIVE_DISPATCH_WINDOW_MS = 6 * 60 * 1000
  const getActivity = (id: string) => liveActivity?.get(id)
  const getRecentDispatches = (id: string): number => {
    const activity = getActivity(id)
    if (!activity) return 0
    return Date.now() - activity.lastSeen <= ACTIVE_DISPATCH_WINDOW_MS ? activity.dispatches : 0
  }
  const effectiveLastMessage = (s: Session, scan: SessionScanResult): number => {
    const live = getActivity(s.id)?.lastSeen ?? 0
    return Math.max(scan.lastMessageAt, live)
  }
  // Sort: sessions with dispatch activity first, then by last message time
  withMessages.sort((a, b) => {
    const aDisp = getRecentDispatches(a.session.id)
    const bDisp = getRecentDispatches(b.session.id)
    if (bDisp > 0 && aDisp === 0) return 1
    if (aDisp > 0 && bDisp === 0) return -1
    return effectiveLastMessage(b.session, b.scan) - effectiveLastMessage(a.session, a.scan)
  })
  let visible = withMessages.slice(0, limit)
  if (pinnedSessionId) {
    const pinnedEntry = withMessages.find(
      ({ session }) => session.id === pinnedSessionId || session.id.startsWith(pinnedSessionId)
    )
    if (pinnedEntry && !visible.some(({ session }) => session.id === pinnedEntry.session.id)) {
      visible = [pinnedEntry, ...visible].slice(0, limit)
    }
  }
  return {
    sessionCount: withMessages.length,
    sessions: visible.map(({ session, scan }) => ({
      id: session.id,
      provider: session.provider,
      format: session.format,
      mtime: session.mtime,
      startedAt: scan.startedAt || undefined,
      lastMessageAt: effectiveLastMessage(session, scan) || undefined,
      dispatches: getRecentDispatches(session.id) || undefined,
    })),
  }
}

interface SessionData {
  messages: SessionMessage[]
  toolStats: Array<{ name: string; count: number }>
}

export async function getSessionData(
  cwd: string,
  sessionId: string,
  limit = 30,
  sessionToolCalls?: Map<string, CapturedToolCall[]>
): Promise<SessionData> {
  const sessions = await findAllProviderSessions(cwd)
  const session = sessions.find(
    (candidate) => candidate.id === sessionId || candidate.id.startsWith(sessionId)
  )
  if (!session) return { messages: [], toolStats: [] }
  const cached = await sessionDataCache.get(session)
  if (!cached) return { messages: [], toolStats: [] }

  const messages = cached.messages.slice(-limit)
  const hasToolCalls = messages.some((message) => (message.toolCalls?.length ?? 0) > 0)
  const captured = (sessionToolCalls?.get(session.id) ?? []).map((entry) => ({
    name: entry.name,
    detail: entry.detail,
  }))
  if (captured.length === 0 || hasToolCalls || session.format !== "cursor-agent-jsonl") {
    return {
      messages,
      toolStats: cached.toolStats,
    }
  }

  const supplemented = supplementMessagesWithCapturedToolCalls(
    messages,
    sessionToolCalls?.get(session.id) ?? []
  )
  return {
    messages: supplemented.slice(-limit),
    toolStats: mergeToolStats(cached.toolStats, captured),
  }
}

export async function getSessionTasks(
  sessionId: string,
  limit = 20
): Promise<{ tasks: SessionTaskPreview[]; summary: SessionTaskSummary }> {
  const tasks = await readTasks(sessionId)
  return buildSessionTasksView(tasks, limit)
}

export async function getProjectTasks(
  cwd: string,
  limit = 100
): Promise<{ tasks: ProjectTaskPreview[]; summary: SessionTaskSummary }> {
  const sessions = await getSessions(cwd)
  const allTasks: ProjectTaskPreview[] = []
  for (const sessionId of sessions) {
    const sessionTasks = await readTasks(sessionId)
    for (const task of sessionTasks) {
      allTasks.push({
        sessionId,
        id: task.id,
        subject: task.subject,
        status: task.status,
        statusChangedAt: task.statusChangedAt ?? null,
        completionTimestamp: task.completionTimestamp ?? null,
        completionEvidence: task.completionEvidence ?? null,
      })
    }
  }

  return buildProjectTasksView(allTasks, limit)
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
    /** Tracks the latest dispatch timestamp per session ID (from hook events). */
    const sessionActivity = new Map<string, { lastSeen: number; dispatches: number }>()
    /** Per-session tool calls captured from hook dispatch payloads. */
    const sessionToolCalls = new Map<string, CapturedToolCall[]>()
    /** In-flight hook dispatches currently being processed by daemon /dispatch. */
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
        // Flush snapshots, gh cache, eligibility, git state, and manifest for this project
        for (const key of snapshots.keys()) {
          if (key.startsWith(cwd)) snapshots.delete(key)
        }
        ghCache.invalidateProject(cwd)
        eligibilityCache.invalidateProject(cwd)
        gitStateCache.invalidateProject(cwd)
        projectSettingsCache.invalidateProject(cwd)
        manifestCache.invalidateProject(cwd)
        // Transcript/session caches are path-based and can include multiple providers.
        // Clear on project-related watcher events to avoid stale ordering/message views.
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
      // Re-start to pick up new watchers
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
