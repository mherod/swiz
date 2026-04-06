import { dirname, extname, join } from "node:path"
import tailwindcss from "bun-plugin-tailwind"
import type { LRUCache } from "lru-cache"
import { ZodError } from "zod"
import { debugLog } from "../../debug.ts"
import {
  DispatchPayloadValidationError,
  parseValidatedAgentDispatchWireJson,
} from "../../dispatch/dispatch-zod-surfaces.ts"
import { type DispatchLifecycleUpdate, executeDispatch } from "../../dispatch/execute.ts"
import { getGhRateLimitStats } from "../../gh-rate-limit.ts"
import { getRepoSlug } from "../../git-helpers.ts"
import { readHookLogs } from "../../hook-log.ts"
import { getIssueStoreReader } from "../../issue-store.ts"
import { DISPATCH_TIMEOUTS } from "../../manifest.ts"
import { deleteSessionData, resolveSessionDeletionTargets } from "../../session-data-delete.ts"
import {
  readSwizSettings,
  settingsStore,
  writeProjectSettings,
  writeSwizSettings,
} from "../../settings.ts"
import type { CurrentSessionToolUsage } from "../../transcript-summary.ts"
import {
  buildTaskCountsFromTasks,
  type TaskCounts,
  type WarmStatusLineSnapshot,
} from "../status-line.ts"
import {
  getActiveAgentProcesses,
  getCachedAgentProcesses,
  getProcessCommand,
  isCursorMacProcess,
} from "./agent-process-discovery.ts"
import { CappedMap } from "./cache/capped-map.ts"
import { type CiWatchRegistry, verifyWebhookSignature } from "./ci-watch-registry.ts"
import {
  type DashboardIssueRecord,
  type DashboardPrRecord,
  issueUpdatedAtMs,
  normalizeDashboardIssue,
  normalizeDashboardPr,
  STALE_ISSUES_TTL_MS,
} from "./dashboard-types.ts"
import type { PrReviewMonitor } from "./pr-review-monitor.ts"
import {
  type CooldownRegistry,
  createMetrics,
  type DaemonMetrics,
  type FileWatcherRegistry,
  GH_QUERY_TTL_MS,
  type GhQueryCache,
  type GitStateCache,
  type HookEligibilityCache,
  type ManifestCache,
  type ProjectSettingsCache,
  recordDispatch,
  serializeMetrics,
  type TranscriptIndexCache,
} from "./runtime-cache.ts"
import { getProjectTasks, getSessionData, listProjectSessions } from "./session-data.ts"
import { handleSessionRoutes } from "./session-routes.ts"
import type { CachedSnapshot } from "./snapshot.ts"
import type { ActiveHookDispatch } from "./types.ts"
import type { UpstreamSyncRegistry } from "./upstream-sync.ts"
import {
  buildSessionTasksView,
  type CapturedToolCall,
  captureSessionToolCall,
  captureSessionToolUsage,
  persistSessionToolCall,
  type SessionToolUsageState,
  seedSessionToolUsage,
  stripAnsi,
} from "./utils.ts"
import type { DaemonWorkerRuntime } from "./worker-runtime.ts"

type DaemonWebServerHandle = ReturnType<typeof Bun.serve>

export const WEB_ROOT = join(dirname(Bun.main), "src", "web")
export const PUBLIC_ROOT = join(dirname(Bun.main), "www", "public")
let _tsxTranspiler: InstanceType<typeof Bun.Transpiler> | undefined
let _tsTranspiler: InstanceType<typeof Bun.Transpiler> | undefined

/** Lazy-init to avoid CurrentWorkingDirectoryUnlinked when imported from tests. */
export function getWebTsxTranspiler(): InstanceType<typeof Bun.Transpiler> {
  if (!_tsxTranspiler) _tsxTranspiler = new Bun.Transpiler({ loader: "tsx", autoImportJSX: true })
  return _tsxTranspiler
}
export function getWebTsTranspiler(): InstanceType<typeof Bun.Transpiler> {
  if (!_tsTranspiler) _tsTranspiler = new Bun.Transpiler({ loader: "ts" })
  return _tsTranspiler
}

export const WEB_MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".tsx": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
}

export function resolveWebAssetPath(pathname: string): string | null {
  const relativeRaw = pathname === "/" ? "index.html" : pathname.replace(/^\/web\/?/, "")
  const relative = relativeRaw.replace(/^\/+/, "")
  if (!relative || relative.includes("..")) return null
  return join(WEB_ROOT, relative)
}

// ─── Web asset cache ──────────────────────────────────────────────────────
// Avoids per-request transpile/build when source files haven't changed.
// Keyed by filePath; invalidated when mtime changes.

interface CachedWebAsset {
  mtimeMs: number
  body: string | ArrayBuffer
  contentType: string
}

const webAssetCache = new CappedMap<string, CachedWebAsset>(200)

async function buildWebAsset(
  filePath: string,
  file: ReturnType<typeof Bun.file>,
  mtimeMs: number
): Promise<{ body: string | ArrayBuffer; contentType: string }> {
  const extension = extname(filePath)
  if (extension === ".tsx" || extension === ".ts") {
    const source = await file.text()
    const code =
      extension === ".tsx"
        ? getWebTsxTranspiler().transformSync(source)
        : getWebTsTranspiler().transformSync(source)
    const contentType = "text/javascript; charset=utf-8"
    webAssetCache.set(filePath, { mtimeMs, body: code, contentType })
    return { body: code, contentType }
  }
  if (extension === ".css") {
    const result = await Bun.build({ entrypoints: [filePath], plugins: [tailwindcss] })
    const output = result.outputs[0]
    if (output) {
      const contentType = "text/css; charset=utf-8"
      const body = await output.text()
      webAssetCache.set(filePath, { mtimeMs, body, contentType })
      return { body, contentType }
    }
  }
  const contentType = WEB_MIME_TYPES[extname(filePath)] ?? "application/octet-stream"
  return { body: await file.arrayBuffer(), contentType }
}

export async function serveWebAsset(pathname: string): Promise<Response | null> {
  const filePath = resolveWebAssetPath(pathname)
  if (!filePath) {
    return new Response("Bad Request", { status: 400 })
  }

  const file = Bun.file(filePath)
  if (!(await file.exists())) return null

  const stat = await file.stat()
  const mtimeMs = stat.mtimeMs ?? 0
  const lastModified = stat.mtime ? new Date(stat.mtime).toUTCString() : undefined

  const cached = webAssetCache.get(filePath)
  if (cached && cached.mtimeMs === mtimeMs) {
    return new Response(cached.body, {
      headers: {
        "cache-control": "max-age=5",
        "content-type": cached.contentType,
        ...(lastModified && { "last-modified": lastModified }),
      },
    })
  }

  const built = await buildWebAsset(filePath, file, mtimeMs)
  return new Response(built.body, {
    headers: {
      "cache-control": "max-age=5",
      "content-type": built.contentType,
      ...(lastModified && { "last-modified": lastModified }),
    },
  })
}

function formatReviewSegment(snapshot: WarmStatusLineSnapshot): string | null {
  if (snapshot.reviewDecision === "CHANGES_REQUESTED") return "changes requested"
  if (snapshot.reviewDecision === "APPROVED") return "approved"
  if (snapshot.commentCount > 0)
    return `${snapshot.commentCount} comment${snapshot.commentCount === 1 ? "" : "s"}`
  return null
}

export function formatWebProjectStatusLine(snapshot: WarmStatusLineSnapshot): string {
  const parts: string[] = []
  const gitInfo = stripAnsi(snapshot.gitInfo).trim()
  if (gitInfo) parts.push(gitInfo)
  if (snapshot.projectState) parts.push(`state: ${snapshot.projectState}`)
  if (snapshot.issueCount !== null)
    parts.push(`${snapshot.issueCount} issue${snapshot.issueCount === 1 ? "" : "s"}`)
  if (snapshot.prCount !== null)
    parts.push(`${snapshot.prCount} PR${snapshot.prCount === 1 ? "" : "s"}`)
  const reviewSeg = formatReviewSegment(snapshot)
  if (reviewSeg) parts.push(reviewSeg)
  if (parts.length === 0) return "No status data yet"
  return parts.join(" | ")
}

/**
 * Full daemon context assembled at bootstrap. Route groups use narrowed interfaces:
 * {@link DispatchRoutesContext}, {@link CacheRoutesContext}, and session routes via
 * {@link buildSessionRoutesContext}.
 */
export interface DaemonWebServerContext {
  port: number
  pruneTranscriptMemory: () => void
  transcriptIndex: TranscriptIndexCache
  manifestCache: ManifestCache
  globalMetrics: DaemonMetrics
  getProjectMetrics: (cwd: string) => DaemonMetrics
  touchProject: (cwd: string) => void
  registerProjectWatchers: (cwd: string) => void
  sessionActivity: Map<string, { lastSeen: number; dispatches: number }>
  sessionToolCalls: Map<string, CapturedToolCall[]>
  sessionToolUsage: Map<string, SessionToolUsageState>
  activeHookDispatches: Map<string, ActiveHookDispatch>
  projectMetrics: Map<string, DaemonMetrics>
  ghCache: GhQueryCache
  eligibilityCache: HookEligibilityCache
  cooldownRegistry: CooldownRegistry
  gitStateCache: GitStateCache
  ciWatchRegistry: CiWatchRegistry
  upstreamSyncRegistry: UpstreamSyncRegistry
  projectSettingsCache: ProjectSettingsCache
  registeredProjects: Set<string>
  projectLastSeen: Map<string, number>
  resolveSnapshot: (
    cwd: string,
    sessionId: string | null | undefined
  ) => Promise<WarmStatusLineSnapshot>
  watchers: FileWatcherRegistry
  snapshots: LRUCache<string, CachedSnapshot> | Map<string, CachedSnapshot>
  workerRuntime: DaemonWorkerRuntime
  prReviewMonitor: PrReviewMonitor
  taskStateCache: import("../../tasks/task-state-cache.ts").TaskStateCache
}

/** Hard request-level timeout for daemon dispatch (ms).
 *  Uses DISPATCH_TIMEOUTS + 10s grace. Fallback: 60s for unknown events. */
const DAEMON_REQUEST_TIMEOUT_GRACE_MS = 10_000
const DAEMON_REQUEST_TIMEOUT_FALLBACK_MS = 60_000

function daemonDispatchRequestTimeoutMs(canonicalEvent: string): number {
  const budgetSec = DISPATCH_TIMEOUTS[canonicalEvent]
  return budgetSec
    ? budgetSec * 1000 + DAEMON_REQUEST_TIMEOUT_GRACE_MS
    : DAEMON_REQUEST_TIMEOUT_FALLBACK_MS
}

/** Maximum age before an active dispatch entry is considered stale and reaped (ms).
 *  Generous enough to cover the slowest event (stop: 180s) plus overhead. */
const STALE_DISPATCH_MAX_AGE_MS = 300_000 // 5 minutes

/**
 * Narrow context for dispatch route handlers — only the capabilities those handlers need.
 */
export interface DispatchRoutesContext {
  projectMetrics: Map<string, DaemonMetrics>
  getProjectMetrics: (cwd: string) => DaemonMetrics
  globalMetrics: DaemonMetrics
  sessionActivity: Map<string, { lastSeen: number; dispatches: number }>
  sessionToolCalls: Map<string, CapturedToolCall[]>
  sessionToolUsage: Map<string, SessionToolUsageState>
  activeHookDispatches: Map<string, ActiveHookDispatch>
  workerRuntime: DaemonWorkerRuntime
  touchProject: (cwd: string) => void
  registerProjectWatchers: (cwd: string) => void
  manifestCache: ManifestCache
  resolveSnapshot: (
    cwd: string,
    sessionId: string | null | undefined
  ) => Promise<WarmStatusLineSnapshot>
  prReviewMonitor: PrReviewMonitor
  upstreamSyncRegistry: UpstreamSyncRegistry
  transcriptIndex: TranscriptIndexCache
  taskStateCache: import("../../tasks/task-state-cache.ts").TaskStateCache
}

export function buildDispatchRoutesContext(ctx: DaemonWebServerContext): DispatchRoutesContext {
  return {
    projectMetrics: ctx.projectMetrics,
    getProjectMetrics: ctx.getProjectMetrics,
    globalMetrics: ctx.globalMetrics,
    sessionActivity: ctx.sessionActivity,
    sessionToolCalls: ctx.sessionToolCalls,
    sessionToolUsage: ctx.sessionToolUsage,
    activeHookDispatches: ctx.activeHookDispatches,
    workerRuntime: ctx.workerRuntime,
    touchProject: ctx.touchProject,
    registerProjectWatchers: ctx.registerProjectWatchers,
    manifestCache: ctx.manifestCache,
    resolveSnapshot: ctx.resolveSnapshot,
    prReviewMonitor: ctx.prReviewMonitor,
    upstreamSyncRegistry: ctx.upstreamSyncRegistry,
    transcriptIndex: ctx.transcriptIndex,
    taskStateCache: ctx.taskStateCache,
  }
}

/**
 * Narrow context for cache route handlers — only the capabilities those handlers need.
 */
export interface CacheRoutesContext {
  ghCache: GhQueryCache
  eligibilityCache: HookEligibilityCache
  transcriptIndex: TranscriptIndexCache
  cooldownRegistry: CooldownRegistry
  gitStateCache: GitStateCache
  ciWatchRegistry: CiWatchRegistry
  projectSettingsCache: ProjectSettingsCache
  manifestCache: ManifestCache
  touchProject: (cwd: string) => void
  registerProjectWatchers: (cwd: string) => void
  snapshots: LRUCache<string, CachedSnapshot> | Map<string, CachedSnapshot>
  watchers: FileWatcherRegistry
}

export function buildCacheRoutesContext(ctx: DaemonWebServerContext): CacheRoutesContext {
  return {
    ghCache: ctx.ghCache,
    eligibilityCache: ctx.eligibilityCache,
    transcriptIndex: ctx.transcriptIndex,
    cooldownRegistry: ctx.cooldownRegistry,
    gitStateCache: ctx.gitStateCache,
    ciWatchRegistry: ctx.ciWatchRegistry,
    projectSettingsCache: ctx.projectSettingsCache,
    manifestCache: ctx.manifestCache,
    touchProject: ctx.touchProject,
    registerProjectWatchers: ctx.registerProjectWatchers,
    snapshots: ctx.snapshots,
    watchers: ctx.watchers,
  }
}

/**
 * Remove leaked entries from activeHookDispatches that are older than
 * STALE_DISPATCH_MAX_AGE_MS. Called on every incoming request as a
 * lightweight garbage collection pass.
 */
function reapStaleDispatches(activeHookDispatches: Map<string, ActiveHookDispatch>): void {
  if (activeHookDispatches.size === 0) return
  const cutoff = Date.now() - STALE_DISPATCH_MAX_AGE_MS
  for (const [id, entry] of activeHookDispatches) {
    if (entry.startedAt < cutoff) {
      activeHookDispatches.delete(id)
    }
  }
}

/** Watcher registration then touch — standard order for POST routes scoped to a project cwd. */
function registerProjectAndTouch(
  ctx: { touchProject: (cwd: string) => void; registerProjectWatchers: (cwd: string) => void },
  cwd: string
): void {
  ctx.registerProjectWatchers(cwd)
  ctx.touchProject(cwd)
}

/** Fire-and-forget upstream sync when the store returned no rows; returns whether a sync was scheduled. */
function kickUpstreamSyncWhenEmpty(
  ctx: DispatchRoutesContext,
  cwd: string,
  isEmpty: boolean
): boolean {
  if (!isEmpty) return false
  void ctx.upstreamSyncRegistry
    .register(cwd)
    .then(() => ctx.upstreamSyncRegistry.syncNow(cwd))
    .then((result) => {
      if (result) {
        // Process PR review changes for any active sessions in this project
        void processPrReviewChanges(ctx, cwd, result)
      }
    })
  return true
}

async function processPrReviewChanges(
  ctx: DispatchRoutesContext,
  cwd: string,
  syncResult: import("../../issue-store.ts").UpstreamSyncResult
): Promise<void> {
  // Get the repo slug for store lookups
  const { getRepoSlug } = await import("../../git-helpers.ts")
  const repo = await getRepoSlug(cwd)
  if (!repo) return

  // Find active sessions that might be interested in this project
  for (const [sessionId] of ctx.sessionActivity) {
    await ctx.prReviewMonitor.processSyncResult(cwd, sessionId, repo, syncResult)
  }
}

function clampDashboardListLimit(raw: number | undefined): number {
  return Math.max(1, Math.min(30, raw ?? 10))
}

function createDispatchLifecycleHandler(
  ctx: DispatchRoutesContext
): (update: DispatchLifecycleUpdate) => void {
  return (update) => {
    if (update.phase === "start") {
      ctx.activeHookDispatches.set(update.requestId, {
        requestId: update.requestId,
        canonicalEvent: update.canonicalEvent,
        hookEventName: update.hookEventName,
        cwd: update.cwd,
        sessionId: update.sessionId,
        hooks: update.hooks,
        startedAt: update.startedAt,
        toolName: update.toolName,
        toolInputSummary: update.toolInputSummary,
      })
      return
    }
    ctx.activeHookDispatches.delete(update.requestId)
  }
}

async function updateParsedPayloadMetrics(
  ctx: DispatchRoutesContext,
  payloadStr: string,
  canonicalEvent: string,
  durationMs: number
): Promise<void> {
  const parsed = await ctx.workerRuntime.parseDispatchPayload(payloadStr)
  if (!parsed) return

  const nowMs = Date.now()
  if (parsed.cwd) {
    ctx.touchProject(parsed.cwd)
    recordDispatch(ctx.getProjectMetrics(parsed.cwd), canonicalEvent, durationMs)
    ctx.registerProjectWatchers(parsed.cwd)
  }
  if (parsed.sessionId) {
    const prev = ctx.sessionActivity.get(parsed.sessionId)
    ctx.sessionActivity.set(parsed.sessionId, {
      lastSeen: nowMs,
      dispatches: (prev?.dispatches ?? 0) + 1,
    })
    if (canonicalEvent === "preToolUse" && parsed.toolName) {
      captureSessionToolCall(
        ctx.sessionToolCalls,
        parsed.sessionId,
        parsed.toolName,
        parsed.toolInput,
        nowMs
      )
      if (parsed.cwd) {
        try {
          await persistSessionToolCall(
            parsed.cwd,
            parsed.sessionId,
            parsed.toolName,
            parsed.toolInput,
            nowMs
          )
        } catch (error) {
          debugLog(
            `[daemon] failed to persist session tool call for ${parsed.sessionId}: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        }
      }
      captureSessionToolUsage(
        ctx.sessionToolUsage,
        parsed.sessionId,
        parsed.toolName,
        parsed.toolInput,
        nowMs
      )
    }
  }
}

async function getCurrentSessionToolUsageFromDaemon(
  ctx: DispatchRoutesContext,
  sessionId: string,
  transcriptPath?: string
): Promise<CurrentSessionToolUsage | null> {
  const cached = ctx.sessionToolUsage.get(sessionId)
  if (cached) {
    cached.lastSeen = Date.now()
    return {
      toolNames: [...cached.toolNames],
      skillInvocations: [...cached.skillInvocations],
    }
  }

  if (!transcriptPath) return null
  const index = await ctx.transcriptIndex.get(transcriptPath)
  if (!index) return null
  const seeded = seedSessionToolUsage(ctx.sessionToolUsage, sessionId, index.summary, Date.now())
  return {
    toolNames: [...seeded.toolNames],
    skillInvocations: [...seeded.skillInvocations],
  }
}

/** Maps dispatch validation failures to HTTP — always includes Zod `issues` when available. */
function daemonDispatchSchemaFailureResponse(e: unknown): Response | null {
  if (e instanceof DispatchPayloadValidationError) {
    return Response.json({ error: e.message, issues: e.zodError.issues }, { status: 400 })
  }
  if (e instanceof ZodError) {
    debugLog("[daemon] dispatch Zod validation failed:", e.issues)
    return Response.json(
      { error: "Dispatch schema validation failed", issues: e.issues },
      { status: 422 }
    )
  }
  return null
}

async function handleDispatchRoute(
  req: Request,
  url: URL,
  ctx: DispatchRoutesContext
): Promise<Response> {
  const canonicalEvent = url.searchParams.get("event")
  const hookEventName = url.searchParams.get("hookEventName") ?? canonicalEvent
  if (!canonicalEvent || !hookEventName) {
    return Response.json({ error: "Missing required query param: event" }, { status: 400 })
  }
  const payloadStr = await req.text()
  const start = performance.now()

  // Register fs.watch and seed in-memory event state for this session's task
  // directory so both TaskStateCache and task-count-context have accurate data
  // from the very first tool call in the session.
  try {
    const parsed = JSON.parse(payloadStr) as Record<string, unknown>
    const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : null
    if (sessionId && ctx.taskStateCache) {
      const { createDefaultTaskStore } = await import("../../task-roots.ts")
      const { tasksDir } = createDefaultTaskStore()
      const sessionTasksDir = join(tasksDir, sessionId)
      ctx.taskStateCache.watchSession(sessionId, sessionTasksDir)
      const { seedSessionFromDisk } = await import("../../tasks/task-event-state.ts")
      await seedSessionFromDisk(sessionId, sessionTasksDir)
    }
  } catch {
    // Best-effort — don't block dispatch if payload parsing or seeding fails
  }

  const requestTimeoutMs = daemonDispatchRequestTimeoutMs(canonicalEvent)

  // Daemon-level AbortController — when the request timeout fires, this
  // signal propagates through executeDispatch → strategy → individual hooks,
  // ensuring all spawned processes are SIGTERM'd instead of orphaned.
  const requestAbort = new AbortController()

  const TIMEOUT_SENTINEL = Symbol("timeout")
  const requestTimer = setTimeout(() => requestAbort.abort(), requestTimeoutMs)

  let raceResult: Awaited<ReturnType<typeof executeDispatch>> | typeof TIMEOUT_SENTINEL
  try {
    raceResult = await Promise.race([
      executeDispatch({
        canonicalEvent,
        hookEventName,
        payloadStr,
        daemonContext: true,
        signal: requestAbort.signal,
        currentSessionToolUsageProvider: async (sessionId, transcriptPath) =>
          getCurrentSessionToolUsageFromDaemon(ctx, sessionId, transcriptPath),
        disableTranscriptSummaryFallback: true,
        manifestProvider: async (cwd) => ctx.manifestCache.get(cwd),
        onDispatchLifecycle: createDispatchLifecycleHandler(ctx),
      }),
      new Promise<typeof TIMEOUT_SENTINEL>((resolve) =>
        setTimeout(() => resolve(TIMEOUT_SENTINEL), requestTimeoutMs)
      ),
    ])
  } catch (e) {
    clearTimeout(requestTimer)
    const durationMs = performance.now() - start
    recordDispatch(ctx.globalMetrics, canonicalEvent, durationMs)
    const schemaResp = daemonDispatchSchemaFailureResponse(e)
    if (schemaResp) return schemaResp
    throw e
  }

  clearTimeout(requestTimer)

  if (raceResult === TIMEOUT_SENTINEL) {
    // Ensure abort fires even if timer callback hasn't executed yet.
    if (!requestAbort.signal.aborted) requestAbort.abort()
    const durationMs = performance.now() - start
    recordDispatch(ctx.globalMetrics, canonicalEvent, durationMs)
    return Response.json(
      {
        error: `Dispatch timeout: ${canonicalEvent} exceeded ${requestTimeoutMs}ms`,
        timedOut: true,
      },
      { status: 504 }
    )
  }

  const durationMs = performance.now() - start
  recordDispatch(ctx.globalMetrics, canonicalEvent, durationMs)
  await updateParsedPayloadMetrics(ctx, payloadStr, canonicalEvent, durationMs)

  try {
    return Response.json(
      parseValidatedAgentDispatchWireJson(raceResult.response, canonicalEvent, hookEventName)
    )
  } catch (e) {
    const schemaResp = daemonDispatchSchemaFailureResponse(e)
    if (schemaResp) return schemaResp
    throw e
  }
}

function handleMetricsRoute(url: URL, ctx: DaemonWebServerContext): Response {
  const projectParam = url.searchParams.get("project")
  const cacheMetrics = {
    ghQuery: { size: ctx.ghCache.size, hits: ctx.ghCache.hits, misses: ctx.ghCache.misses },
    transcriptIndex: {
      size: ctx.transcriptIndex.size,
      hits: ctx.transcriptIndex.hits,
      misses: ctx.transcriptIndex.misses,
    },
    eligibility: { size: ctx.eligibilityCache.size },
    cooldown: { size: ctx.cooldownRegistry.size },
    gitState: { size: ctx.gitStateCache.size },
    projectSettings: { size: ctx.projectSettingsCache.size },
    manifest: { size: ctx.manifestCache.size },
    snapshots: { size: ctx.snapshots.size },
  }
  if (projectParam) {
    const pm = ctx.projectMetrics.get(projectParam)
    return Response.json({
      ...(pm ? serializeMetrics(pm) : serializeMetrics(createMetrics())),
      project: projectParam,
      caches: cacheMetrics,
    })
  }
  const projects: Record<string, ReturnType<typeof serializeMetrics>> = {}
  for (const [cwd, m] of ctx.projectMetrics) {
    projects[cwd] = serializeMetrics(m)
  }
  return Response.json({ ...serializeMetrics(ctx.globalMetrics), projects, caches: cacheMetrics })
}

async function handleProcessKill(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { pid?: number } | null
  const pid = body?.pid
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) {
    return Response.json(
      { error: "Missing required field: pid (positive integer)" },
      { status: 400 }
    )
  }
  const command = await getProcessCommand(pid)
  const killCommand = isCursorMacProcess(command ?? "")
    ? ["osascript", "-e", 'tell application "Cursor" to quit']
    : ["kill", "-TERM", String(pid)]
  const killProc = Bun.spawn(killCommand, { stdout: "pipe", stderr: "pipe" })
  const stderr = await new Response(killProc.stderr).text()
  await killProc.exited
  if (killProc.exitCode !== 0) {
    return Response.json(
      { error: stderr.trim() || `Failed to terminate pid ${pid}` },
      { status: 500 }
    )
  }
  return Response.json({ ok: true, pid })
}

function findBlockedProviders(
  sessions: Array<{ provider?: string }>,
  activeProcesses: { providers: Record<string, number[]> }
): Map<string, number[]> {
  const blocked = new Map<string, number[]>()
  for (const session of sessions) {
    const provider = (session.provider ?? "unknown").toLowerCase()
    const pids = activeProcesses.providers[provider] ?? []
    if (pids.length > 0) blocked.set(provider, pids)
  }
  return blocked
}

async function handleSessionDelete(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    cwd?: string
    sessionId?: string
  } | null
  if (typeof body?.cwd !== "string" || !body.cwd || typeof body?.sessionId !== "string") {
    return Response.json(
      { error: "Missing required fields: cwd (string), sessionId (string)" },
      { status: 400 }
    )
  }
  const targets = await resolveSessionDeletionTargets(body.cwd, body.sessionId)
  if (targets.matchedSessions.length === 0) {
    return Response.json({ error: `Session ${body.sessionId} not found` }, { status: 404 })
  }
  const activeProcesses = await getActiveAgentProcesses()
  const blocked = findBlockedProviders(targets.matchedSessions, activeProcesses)
  if (blocked.size > 0) {
    return Response.json(
      {
        error: "Cannot delete session while provider process is active",
        providers: Object.fromEntries(blocked),
      },
      { status: 409 }
    )
  }
  const result = await deleteSessionData(targets)
  if (result.failedPaths.length > 0) {
    return Response.json(
      { error: "Failed to delete one or more session paths", failedPaths: result.failedPaths },
      { status: 500 }
    )
  }
  return Response.json({
    ok: true,
    deletedCount: result.deletedCount,
    sessionIds: result.sessionIds,
  })
}

async function handleGhQuery(req: Request, ctx: CacheRoutesContext): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    args?: string[]
    cwd?: string
    ttlMs?: number
  } | null
  if (!Array.isArray(body?.args) || typeof body?.cwd !== "string" || !body.cwd) {
    return Response.json(
      { error: "Missing required fields: args (string[]), cwd (string)" },
      { status: 400 }
    )
  }
  registerProjectAndTouch(ctx, body.cwd)
  const ttlMs = typeof body?.ttlMs === "number" ? body.ttlMs : GH_QUERY_TTL_MS
  const { hit, value } = await ctx.ghCache.get(body.args, body.cwd, ttlMs)
  return Response.json({ hit, value })
}

async function handleHooksEligible(req: Request, ctx: CacheRoutesContext): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { cwd?: string } | null
  if (typeof body?.cwd !== "string" || !body.cwd) {
    return Response.json({ error: "Missing required field: cwd" }, { status: 400 })
  }
  registerProjectAndTouch(ctx, body.cwd)
  const snapshot = await ctx.eligibilityCache.compute(body.cwd)
  return Response.json(snapshot)
}

async function handleTranscriptIndex(req: Request, ctx: CacheRoutesContext): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    transcriptPath?: string
  } | null
  if (typeof body?.transcriptPath !== "string" || !body.transcriptPath) {
    return Response.json({ error: "Missing required field: transcriptPath" }, { status: 400 })
  }
  const index = await ctx.transcriptIndex.get(body.transcriptPath)
  if (!index) {
    return Response.json({ error: "Transcript not found or unreadable" }, { status: 404 })
  }
  return Response.json(index)
}

async function handleCooldownCheck(req: Request, ctx: CacheRoutesContext): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    hookFile?: string
    cooldownSeconds?: number
    cwd?: string
  } | null
  if (
    typeof body?.hookFile !== "string" ||
    typeof body?.cooldownSeconds !== "number" ||
    typeof body?.cwd !== "string" ||
    !body.cwd
  ) {
    return Response.json(
      {
        error: "Missing required fields: hookFile (string), cooldownSeconds (number), cwd (string)",
      },
      { status: 400 }
    )
  }
  const withinCooldown = ctx.cooldownRegistry.isWithinCooldown(
    body.hookFile,
    body.cooldownSeconds,
    body.cwd
  )
  return Response.json({ withinCooldown })
}

async function handleCooldownMark(req: Request, ctx: CacheRoutesContext): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    hookFile?: string
    cwd?: string
  } | null
  if (typeof body?.hookFile !== "string" || typeof body?.cwd !== "string" || !body.cwd) {
    return Response.json(
      { error: "Missing required fields: hookFile (string), cwd (string)" },
      { status: 400 }
    )
  }
  ctx.cooldownRegistry.mark(body.hookFile, body.cwd)
  return Response.json({ marked: true })
}

async function handleGitState(req: Request, ctx: CacheRoutesContext): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    cwd?: string
  } | null
  if (typeof body?.cwd !== "string" || !body.cwd) {
    return Response.json({ error: "Missing required field: cwd" }, { status: 400 })
  }
  registerProjectAndTouch(ctx, body.cwd)
  const state = await ctx.gitStateCache.get(body.cwd)
  if (!state) {
    return Response.json({ error: "Not a git repository or no branch" }, { status: 404 })
  }
  return Response.json(state)
}

type CacheRouteHandler = (req: Request, ctx: CacheRoutesContext) => Promise<Response>

const CACHE_ROUTE_TABLE: Record<string, CacheRouteHandler> = {
  "/gh-query": handleGhQuery,
  "/hooks/eligible": handleHooksEligible,
  "/transcript/index": handleTranscriptIndex,
  "/hooks/cooldown": handleCooldownCheck,
  "/hooks/cooldown/mark": handleCooldownMark,
  "/git/state": handleGitState,
}

async function handleCacheRoutes(
  req: Request,
  url: URL,
  ctx: CacheRoutesContext
): Promise<Response | null> {
  if (req.method !== "POST") return null
  const handler = CACHE_ROUTE_TABLE[url.pathname]
  if (!handler) return null
  return handler(req, ctx)
}

async function handleCiWatchPost(req: Request, ctx: DaemonWebServerContext): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { cwd?: string; sha?: string } | null
  if (typeof body?.cwd !== "string" || !body.cwd || typeof body?.sha !== "string" || !body.sha) {
    return Response.json(
      { error: "Missing required fields: cwd (string), sha (string)" },
      { status: 400 }
    )
  }
  const global = await readSwizSettings()
  if (global.ignoreCi) {
    return Response.json({ ignored: true })
  }
  registerProjectAndTouch(ctx, body.cwd)
  const started = ctx.ciWatchRegistry.start(body.cwd, body.sha)
  return Response.json(started)
}

type WebhookWorkflowRun = {
  head_sha?: string
  conclusion?: string | null
  id?: number
  status?: string
}

function parseWebhookPayload(
  rawBody: ArrayBuffer
): { run: WebhookWorkflowRun } | { error: string } {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(rawBody)) as {
      workflow_run?: WebhookWorkflowRun
    }
    const run = parsed.workflow_run
    if (!run) return { error: "no workflow_run in payload" }
    return { run }
  } catch {
    return { error: "Invalid JSON payload" }
  }
}

function webhookPayloadErrorResponse(error: string): Response {
  if (error === "Invalid JSON payload") {
    return Response.json({ error }, { status: 400 })
  }
  return Response.json({ ignored: true, reason: error })
}

async function checkWebhookSignature(req: Request, rawBody: ArrayBuffer): Promise<Response | null> {
  const webhookSecret = (await readSwizSettings()).githubWebhookSecret
  if (!webhookSecret) return null
  const sig = req.headers.get("X-Hub-Signature-256")
  const valid = await verifyWebhookSignature(webhookSecret, rawBody, sig)
  return valid ? null : Response.json({ error: "Invalid signature" }, { status: 401 })
}

function extractCompletedRun(
  run: WebhookWorkflowRun
): { sha: string; conclusion: string; runId: number } | null {
  const sha = run.head_sha
  const status = (run.status ?? "").toLowerCase()
  const conclusion = (run.conclusion ?? "").toLowerCase()
  if (!sha || status !== "completed" || !conclusion) return null
  return { sha, conclusion, runId: run.id ?? 0 }
}

async function handleCiWebhookPost(req: Request, ctx: DaemonWebServerContext): Promise<Response> {
  const event = req.headers.get("X-GitHub-Event")
  if (event !== "workflow_run") {
    return Response.json({ ignored: true, reason: "not a workflow_run event" })
  }

  const rawBody = await req.arrayBuffer()
  const sigError = await checkWebhookSignature(req, rawBody)
  if (sigError) return sigError

  const parsed = parseWebhookPayload(rawBody)
  if ("error" in parsed) return webhookPayloadErrorResponse(parsed.error)

  const completed = extractCompletedRun(parsed.run)
  if (!completed) return Response.json({ ignored: true, reason: "run not yet completed" })

  const { sha, conclusion, runId } = completed
  const resolved = await ctx.ciWatchRegistry.handleWebhookConclusion(sha, conclusion, runId)
  return Response.json({ resolved, sha, conclusion, runId })
}

async function handleCiRoutes(
  req: Request,
  url: URL,
  ctx: DaemonWebServerContext
): Promise<Response | null> {
  if (url.pathname === "/ci-watch" && req.method === "POST") {
    return handleCiWatchPost(req, ctx)
  }
  if (url.pathname === "/ci-watch/webhook" && req.method === "POST") {
    return handleCiWebhookPost(req, ctx)
  }
  if (url.pathname === "/ci-watches" && req.method === "GET") {
    const cwd = url.searchParams.get("cwd")
    const active = ctx.ciWatchRegistry
      .listActive()
      .filter((entry) => (cwd ? entry.cwd === cwd : true))
    return Response.json({ active })
  }
  return null
}

async function handleProjectPrsRoute(req: Request, ctx: DaemonWebServerContext): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    cwd?: string
    limit?: number
  } | null
  const cwd = body?.cwd
  if (typeof cwd !== "string" || !cwd) {
    return Response.json({ error: "Missing required field: cwd (string)" }, { status: 400 })
  }

  registerProjectAndTouch(ctx, cwd)

  const repo = await getRepoSlug(cwd)
  if (!repo) return Response.json({ repo: null, pullRequests: [] satisfies DashboardPrRecord[] })

  const limit = clampDashboardListLimit(body?.limit)
  const reader = getIssueStoreReader()
  let prs = await reader.listPullRequests<unknown>(repo)

  const syncing = kickUpstreamSyncWhenEmpty(ctx, cwd, prs.length === 0)

  if (prs.length === 0) {
    prs = await reader.listPullRequests<unknown>(repo, STALE_ISSUES_TTL_MS)
  }

  const normalizedPrs = prs
    .map((pr) => normalizeDashboardPr(pr))
    .filter((pr): pr is DashboardPrRecord => pr !== null)
    .toSorted((a, b) => {
      const aMs = a.updatedAt ? Date.parse(a.updatedAt) : 0
      const bMs = b.updatedAt ? Date.parse(b.updatedAt) : 0
      return (Number.isFinite(bMs) ? bMs : 0) - (Number.isFinite(aMs) ? aMs : 0)
    })
    .slice(0, limit)

  return Response.json({ repo, pullRequests: normalizedPrs, syncing })
}

async function handleProjectSyncNow(req: Request, ctx: DaemonWebServerContext): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { cwd?: string } | null
  const cwd = body?.cwd
  if (typeof cwd !== "string" || !cwd) {
    return Response.json({ error: "Missing required field: cwd (string)" }, { status: 400 })
  }
  registerProjectAndTouch(ctx, cwd)
  // Register idempotently, then kick off sync in the background — returns immediately.
  void ctx.upstreamSyncRegistry.register(cwd).then(() => ctx.upstreamSyncRegistry.syncNow(cwd))
  return Response.json({ ok: true, started: true })
}

async function handleProjectIssuesRoute(
  req: Request,
  ctx: DaemonWebServerContext
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    cwd?: string
    limit?: number
  } | null
  const cwd = body?.cwd
  if (typeof cwd !== "string" || !cwd) {
    return Response.json({ error: "Missing required field: cwd (string)" }, { status: 400 })
  }

  registerProjectAndTouch(ctx, cwd)

  const repo = await getRepoSlug(cwd)
  if (!repo) return Response.json({ repo: null, issues: [] satisfies DashboardIssueRecord[] })

  const limit = clampDashboardListLimit(body?.limit)
  const reader = getIssueStoreReader()
  let issues = await reader.listIssues<unknown>(repo)

  const syncing = kickUpstreamSyncWhenEmpty(ctx, cwd, issues.length === 0)

  if (issues.length === 0) {
    issues = await reader.listIssues<unknown>(repo, STALE_ISSUES_TTL_MS)
  }

  const normalizedIssues = issues
    .map((issue) => normalizeDashboardIssue(issue))
    .filter((issue): issue is DashboardIssueRecord => issue !== null)
    .toSorted((a, b) => issueUpdatedAtMs(b.updatedAt) - issueUpdatedAtMs(a.updatedAt))
    .slice(0, limit)

  return Response.json({ repo, issues: normalizedIssues, syncing })
}

async function handleSettingsRoutes(
  req: Request,
  url: URL,
  ctx: DaemonWebServerContext
): Promise<Response | null> {
  if (url.pathname === "/settings/global" && req.method === "GET") {
    return Response.json({ settings: await readSwizSettings() })
  }
  if (url.pathname === "/settings/global/update" && req.method === "POST") {
    return handleGlobalSettingsUpdate(req)
  }
  if (url.pathname === "/settings/project" && req.method === "POST") {
    return handleProjectSettingsGet(req, ctx)
  }
  if (url.pathname === "/settings/project/update" && req.method === "POST") {
    return handleProjectSettingsUpdate(req, ctx)
  }
  return null
}

async function handleGlobalSettingsUpdate(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { updates?: Record<string, any> } | null
  if (!body?.updates || typeof body.updates !== "object") {
    return Response.json({ error: "Missing required field: updates (object)" }, { status: 400 })
  }
  const validKeys = [
    "autoContinue",
    "critiquesEnabled",
    "prMergeMode",
    "pushGate",
    "sandboxedEdits",
    "speak",
    "swizNotifyHooks",
    "gitStatusGate",
    "ambitionMode",
    "memoryWordThreshold",
    "memoryLineThreshold",
    "transcriptMonitorMaxConcurrentDispatches",
  ]
  let updatedAny = false
  for (const key of validKeys) {
    if (key in body.updates) {
      await settingsStore.setGlobal(key, body.updates[key])
      updatedAny = true
    }
  }
  if (!updatedAny) {
    return Response.json({ error: "No supported updates provided" }, { status: 400 })
  }
  return Response.json({ success: true, settings: await readSwizSettings() })
}

async function handleProjectSettingsGet(
  req: Request,
  ctx: DaemonWebServerContext
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { cwd?: string } | null
  if (typeof body?.cwd !== "string" || !body.cwd) {
    return Response.json({ error: "Missing required field: cwd" }, { status: 400 })
  }
  registerProjectAndTouch(ctx, body.cwd)
  const cached = await ctx.projectSettingsCache.get(body.cwd)
  const globalSettings = await readSwizSettings()
  return Response.json({ ...cached, globalSettings: { prMergeMode: globalSettings.prMergeMode } })
}

async function applyProjectSettingsUpdates(
  cwd: string,
  normalized: Record<string, any>
): Promise<void> {
  const projectUpdates: Record<string, any> = {}
  for (const key of Object.keys(normalized)) {
    if (key !== "prMergeMode") projectUpdates[key] = normalized[key]
  }
  if (Object.keys(projectUpdates).length > 0) {
    await writeProjectSettings(cwd, projectUpdates)
  }
  if (normalized.prMergeMode !== undefined) {
    const gs = await readSwizSettings()
    await writeSwizSettings({
      ...gs,
      prMergeMode: normalized.prMergeMode as boolean,
    })
  }
}

async function handleProjectSettingsUpdate(
  req: Request,
  ctx: DaemonWebServerContext
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    cwd?: string
    updates?: {
      collaborationMode?: "auto" | "solo" | "team" | "relaxed-collab"
      prMergeMode?: boolean
      strictNoDirectMain?: boolean
      trivialMaxFiles?: number | null
      trivialMaxLines?: number | null
      defaultBranch?: string | null
      memoryLineThreshold?: number | null
      memoryWordThreshold?: number | null
      largeFileSizeKb?: number | null
      ambitionMode?: "standard" | "aggressive" | "creative" | "reflective" | "inherit" | null
      taskDurationWarningMinutes?: number | null
      transcriptMonitorMaxConcurrentDispatches?: number | null
      autoSteerTranscriptWatching?: boolean
      speak?: boolean
    }
  } | null
  const cwd = body?.cwd
  const updates = body?.updates
  if (typeof cwd !== "string" || !cwd || !updates || typeof updates !== "object") {
    return Response.json(
      { error: "Missing required fields: cwd (string), updates (object)" },
      { status: 400 }
    )
  }

  const normalized = normalizeProjectSettingsUpdates(updates)
  if ("error" in normalized) {
    return Response.json({ error: normalized.error }, { status: 400 })
  }
  if (Object.keys(normalized).length === 0) {
    return Response.json({ error: "No supported updates provided" }, { status: 400 })
  }

  registerProjectAndTouch(ctx, cwd)
  await applyProjectSettingsUpdates(cwd, normalized)
  ctx.projectSettingsCache.invalidateProject(cwd)
  ctx.manifestCache.invalidateProject(cwd)
  const cached = await ctx.projectSettingsCache.get(cwd)
  const globalSettings = await readSwizSettings()
  return Response.json({ ...cached, globalSettings: { prMergeMode: globalSettings.prMergeMode } })
}

function validateBooleanField(updates: Record<string, any>, key: string): string | null {
  if (key in updates && typeof updates[key] !== "boolean") {
    return `${key} must be a boolean`
  }
  return null
}

function normalizeProjectSettingsUpdates(
  updates: Record<string, any>
): Record<string, any> | { error: string } {
  const result: Record<string, any> = {}
  const validModes = new Set(["auto", "solo", "team", "relaxed-collab"])
  const optionalKeys = [
    "trivialMaxFiles",
    "trivialMaxLines",
    "defaultBranch",
    "memoryLineThreshold",
    "memoryWordThreshold",
    "largeFileSizeKb",
    "taskDurationWarningMinutes",
    "transcriptMonitorMaxConcurrentDispatches",
    "ambitionMode",
  ] as const

  if ("collaborationMode" in updates) {
    const mode = updates.collaborationMode
    if (!validModes.has(String(mode))) {
      return { error: "collaborationMode must be one of: auto, solo, team, relaxed-collab" }
    }
    result.collaborationMode = mode
  }

  for (const boolKey of [
    "prMergeMode",
    "strictNoDirectMain",
    "autoSteerTranscriptWatching",
    "speak",
  ] as const) {
    const err = validateBooleanField(updates, boolKey)
    if (err) return { error: err }
    if (boolKey in updates) result[boolKey] = updates[boolKey]
  }

  for (const key of optionalKeys) {
    if (key in updates) result[key] = updates[key]
  }
  return result
}

function buildSessionRoutesContext(ctx: DaemonWebServerContext) {
  return {
    touchProject: ctx.touchProject,
    getKnownProjects: () => [
      ...new Set([process.cwd(), ...ctx.registeredProjects, ...ctx.projectMetrics.keys()]),
    ],
    getProjectLastSeen: (cwd: string) => ctx.projectLastSeen.get(cwd) ?? 0,
    getProjectStatusLine: async (cwd: string, sessionId?: string) => {
      const snapshot = await ctx.resolveSnapshot(cwd, sessionId ?? null)
      return formatWebProjectStatusLine(snapshot)
    },
    listProjectSessions: (cwd: string, limit: number, pinnedSessionId?: string) =>
      listProjectSessions(cwd, limit, ctx.sessionActivity, pinnedSessionId),
    getSessionData: (cwd: string, sessionId: string, limit: number) =>
      getSessionData(cwd, sessionId, limit, ctx.sessionToolCalls),
    getSessionTasks: async (sessionId: string, limit: number) => {
      const { createDefaultTaskStore } = await import("../../task-roots.ts")
      const { tasksDir } = createDefaultTaskStore()
      const tasks = await ctx.taskStateCache.getTasks(sessionId, join(tasksDir, sessionId))
      return buildSessionTasksView(tasks, limit)
    },
    getProjectTasks,
    getAgentProcessSnapshot: () => getCachedAgentProcesses(),
  }
}

function handleDispatchActive(url: URL, ctx: DaemonWebServerContext): Response {
  const cwd = url.searchParams.get("cwd")
  const sessionId = url.searchParams.get("sessionId")
  const active = [...ctx.activeHookDispatches.values()]
    .filter((entry) => (!cwd || entry.cwd === cwd) && (!sessionId || entry.sessionId === sessionId))
    .sort((a, b) => b.startedAt - a.startedAt)
  return Response.json({ active })
}

async function handleProcessAgents(): Promise<Response> {
  try {
    return Response.json(await getCachedAgentProcesses())
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Failed to inspect active agent processes",
      },
      { status: 500 }
    )
  }
}

function handleCacheStatus(ctx: DaemonWebServerContext): Response {
  return Response.json({
    watchers: ctx.watchers.status(),
    snapshotCacheSize: ctx.snapshots.size,
    ghCacheSize: ctx.ghCache.size,
    eligibilityCacheSize: ctx.eligibilityCache.size,
    transcriptIndexSize: ctx.transcriptIndex.size,
    cooldownRegistrySize: ctx.cooldownRegistry.size,
    gitStateCacheSize: ctx.gitStateCache.size,
    projectSettingsCacheSize: ctx.projectSettingsCache.size,
    manifestCacheSize: ctx.manifestCache.size,
  })
}

async function resolveTaskCountsFromCache(
  sessionId: string | null | undefined,
  cache: DaemonWebServerContext["taskStateCache"]
): Promise<TaskCounts | null> {
  if (!sessionId) return null
  try {
    const { createDefaultTaskStore } = await import("../../task-roots.ts")
    const { tasksDir } = createDefaultTaskStore()
    const state = await cache.getState(sessionId, join(tasksDir, sessionId))
    if (state.tasks.length === 0) return null
    return buildTaskCountsFromTasks(state.tasks)
  } catch {
    return null
  }
}

async function handleStatusLineSnapshot(
  req: Request,
  ctx: DaemonWebServerContext
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    cwd?: string
    sessionId?: string | null
  } | null
  if (typeof body?.cwd !== "string" || !body.cwd) {
    return Response.json({ error: "Missing required field: cwd" }, { status: 400 })
  }
  const sessionId = body?.sessionId ?? null
  const [snapshot, taskCounts] = await Promise.all([
    ctx.resolveSnapshot(body.cwd, sessionId),
    resolveTaskCountsFromCache(sessionId, ctx.taskStateCache),
  ])
  return Response.json({ snapshot: { ...snapshot, taskCounts } })
}

type TopRouteHandler = (
  req: Request,
  url: URL,
  ctx: DaemonWebServerContext
) => Promise<Response> | Response

async function handleHookLogs(url: URL): Promise<Response> {
  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") ?? "200", 10)))
  const entries = await readHookLogs(limit)
  return Response.json({ entries: entries.reverse() })
}

async function handleGhRateLimit(): Promise<Response> {
  const stats = await getGhRateLimitStats()
  return Response.json(stats)
}

const TOP_ROUTE_TABLE: Record<string, TopRouteHandler> = {
  "POST /dispatch": handleDispatchRoute,
  "GET /dispatch/active": (_req, url, ctx) => handleDispatchActive(url, ctx),
  "GET /metrics": (_req, url, ctx) => handleMetricsRoute(url, ctx),
  "GET /api/hook-logs": (_req, url) => handleHookLogs(url),
  "GET /api/gh-rate-limit": () => handleGhRateLimit(),
  "GET /process/agents": () => handleProcessAgents(),
  "POST /process/agents/kill": (req) => handleProcessKill(req),
  "POST /sessions/delete": (req) => handleSessionDelete(req),
  "POST /projects/issues": (req, _url, ctx) => handleProjectIssuesRoute(req, ctx),
  "POST /projects/prs": (req, _url, ctx) => handleProjectPrsRoute(req, ctx),
  "POST /projects/sync-now": (req, _url, ctx) => handleProjectSyncNow(req, ctx),
  "GET /cache/status": (_req, _url, ctx) => handleCacheStatus(ctx),
  "POST /status-line/snapshot": (req, _url, ctx) => handleStatusLineSnapshot(req, ctx),
}

async function handleTopLevelRoutes(
  req: Request,
  url: URL,
  ctx: DaemonWebServerContext
): Promise<Response | null> {
  const key = `${req.method} ${url.pathname}`
  const handler = TOP_ROUTE_TABLE[key]
  if (!handler) return null
  return handler(req, url, ctx)
}

const DELEGATE_HANDLERS: Array<
  (req: Request, url: URL, ctx: DaemonWebServerContext) => Promise<Response | null>
> = [
  handleTopLevelRoutes,
  (req, url, ctx) => handleCacheRoutes(req, url, buildCacheRoutesContext(ctx)),
  handleCiRoutes,
  handleSettingsRoutes,
  (req, url, ctx) => handleSessionRoutes(req, url, buildSessionRoutesContext(ctx)),
]

async function handleFetchRoutes(
  req: Request,
  url: URL,
  ctx: DaemonWebServerContext
): Promise<Response> {
  for (const handler of DELEGATE_HANDLERS) {
    const response = await handler(req, url, ctx)
    if (response) return response
  }
  return new Response("Not Found", { status: 404 })
}

export function startDaemonWebServer(ctx: DaemonWebServerContext): DaemonWebServerHandle {
  const notFound = () => new Response("Not Found", { status: 404 })
  const server = Bun.serve({
    port: ctx.port,
    routes: {
      "/health": new Response("ok"),
      "/": async (req) => {
        if (req.method !== "GET") return notFound()
        return (await serveWebAsset("/")) ?? notFound()
      },
      "/web": async (req) => {
        if (req.method !== "GET") return notFound()
        return (await serveWebAsset("/web/index.html")) ?? notFound()
      },
      "/web/*": async (req) => {
        if (req.method !== "GET") return notFound()
        return (await serveWebAsset(new URL(req.url).pathname)) ?? notFound()
      },
      "/public/*": async (req) => {
        if (req.method !== "GET") return notFound()
        const pathname = new URL(req.url).pathname
        const relative = pathname.replace(/^\/public\//, "").replace(/^\/+/, "")
        if (!relative || relative.includes("..")) return notFound()
        const filePath = join(PUBLIC_ROOT, relative)
        const file = Bun.file(filePath)
        if (!(await file.exists())) return notFound()
        const contentType = WEB_MIME_TYPES[extname(filePath)] ?? "application/octet-stream"
        return new Response(file, {
          headers: { "cache-control": "max-age=3600", "content-type": contentType },
        })
      },
      "/favicon.ico": async (req) => {
        if (req.method !== "GET") return notFound()
        return (await serveWebAsset("/web/favicon.ico")) ?? new Response(null, { status: 204 })
      },
    },
    async fetch(req) {
      ctx.pruneTranscriptMemory()
      reapStaleDispatches(ctx.activeHookDispatches)
      const url = new URL(req.url)
      return handleFetchRoutes(req, url, ctx)
    },
  })
  return server
}
