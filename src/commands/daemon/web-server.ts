import { dirname, extname, join } from "node:path"
import tailwindcss from "bun-plugin-tailwind"
import type { LRUCache } from "lru-cache"
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
import type { WarmStatusLineSnapshot } from "../status-line.ts"
import { type CiWatchRegistry, verifyWebhookSignature } from "./ci-watch-registry.ts"
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
import {
  getProjectTasks,
  getSessionData,
  getSessionTasks,
  listProjectSessions,
} from "./session-data.ts"
import { type AgentProcessSnapshot, handleSessionRoutes } from "./session-routes.ts"
import type { CachedSnapshot } from "./snapshot.ts"
import type { ActiveHookDispatch } from "./types.ts"
import type { UpstreamSyncRegistry } from "./upstream-sync.ts"
import { type CapturedToolCall, captureSessionToolCall, stripAnsi } from "./utils.ts"
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

const webAssetCache = new Map<string, CachedWebAsset>()

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
  const cached = webAssetCache.get(filePath)
  if (cached && cached.mtimeMs === mtimeMs) {
    return new Response(cached.body, {
      headers: { "cache-control": "no-cache", "content-type": cached.contentType },
    })
  }

  const built = await buildWebAsset(filePath, file, mtimeMs)
  return new Response(built.body, {
    headers: { "cache-control": "no-cache", "content-type": built.contentType },
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

import {
  type DashboardIssueRecord,
  type DashboardPrRecord,
  issueUpdatedAtMs,
  normalizeDashboardIssue,
  normalizeDashboardPr,
  STALE_ISSUES_TTL_MS,
} from "./dashboard-types.ts"

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
}

function isCursorMacProcess(command: string): boolean {
  return command.includes("cursor.app/contents/macos/cursor")
}

async function getProcessCommand(pid: number): Promise<string | null> {
  const proc = Bun.spawn(["ps", "-p", String(pid), "-o", "command="], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  if (proc.exitCode !== 0) return null
  const command = stdout.trim().toLowerCase()
  return command.length > 0 ? command : null
}

function parseLsofCwdOutput(lsofOut: string): Record<number, string> {
  const pidCwds: Record<number, string> = {}
  let currentPid = 0
  for (const line of lsofOut.split("\n")) {
    if (line.startsWith("p")) {
      currentPid = parseInt(line.slice(1), 10)
    } else if (line.startsWith("n") && currentPid > 0) {
      pidCwds[currentPid] = line.slice(1)
    }
  }
  return pidCwds
}

async function resolvePidCwds(allPids: number[]): Promise<Record<number, string>> {
  const pidCwds: Record<number, string> = {}
  const chunkSize = 120
  for (let i = 0; i < allPids.length; i += chunkSize) {
    const pidChunk = allPids.slice(i, i + chunkSize)
    try {
      const lsofProc = Bun.spawn(["lsof", "-p", pidChunk.join(","), "-d", "cwd", "-Fn"], {
        stdout: "pipe",
        stderr: "pipe",
      })
      let lsofTimedOut = false
      const killTimer = setTimeout(() => {
        lsofTimedOut = true
        lsofProc.kill()
      }, 3000)
      try {
        const [lsofOut] = await Promise.all([
          new Response(lsofProc.stdout).text(),
          new Response(lsofProc.stderr).text(),
        ])
        await lsofProc.exited
        if (!lsofTimedOut) Object.assign(pidCwds, parseLsofCwdOutput(lsofOut))
      } finally {
        clearTimeout(killTimer)
      }
    } catch {
      // lsof not found on PATH or spawn failed — skip cwd resolution gracefully
      break
    }
  }
  return pidCwds
}

function classifyProviderPid(command: string, executable: string): string | null {
  if (command.includes("claude-agent-sdk/cli.js")) return "claude"
  if (command.includes("/codex") || command.includes(" codex ")) return "codex"
  if (command.includes("gemini")) return "gemini"
  if (isCursorMacProcess(command) || executable === "agent" || executable.endsWith("/agent")) {
    return "cursor"
  }
  return null
}

function parseProviderPids(stdout: string): Map<string, Set<number>> {
  const providers = new Map<string, Set<number>>()
  for (const row of stdout.split("\n")) {
    const trimmed = row.trim()
    if (!trimmed) continue
    const match = /^(\d+)\s+(.+)$/.exec(trimmed)
    if (!match) continue
    const pid = Number(match[1])
    const command = (match[2] ?? "").toLowerCase()
    const executable = command.split(/\s+/, 1)[0] ?? ""
    if (!pid || !command) continue

    const provider = classifyProviderPid(command, executable)
    if (!provider) continue
    const existing = providers.get(provider) ?? new Set<number>()
    existing.add(pid)
    providers.set(provider, existing)
  }
  return providers
}

async function getActiveAgentProcesses(): Promise<AgentProcessSnapshot> {
  try {
    const proc = Bun.spawn(["ps", "-Ao", "pid,command"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    if (proc.exitCode !== 0) return { providers: {}, pidCwds: {} }

    const providers = parseProviderPids(stdout)

    const allPids: number[] = []
    for (const pids of providers.values()) {
      for (const pid of pids) allPids.push(pid)
    }

    const pidCwds = allPids.length > 0 ? await resolvePidCwds(allPids) : {}

    const snapshot: Record<string, number[]> = {}
    for (const [provider, pids] of providers) {
      snapshot[provider] = [...pids].sort((a, b) => a - b)
    }
    return { providers: snapshot, pidCwds }
  } catch {
    return { providers: {}, pidCwds: {} }
  }
}

// ─── Agent process snapshot cache ──────────────────────────────────────────
// Short-TTL cache with in-flight coalescing. Avoids redundant ps+lsof scans
// when multiple routes request the snapshot concurrently or within the TTL.

const AGENT_PROCESS_CACHE_TTL_MS = 3_000

let cachedSnapshot: AgentProcessSnapshot | null = null
let cachedAt = 0
let inflight: Promise<AgentProcessSnapshot> | null = null

async function getCachedAgentProcesses(): Promise<AgentProcessSnapshot> {
  if (cachedSnapshot && Date.now() - cachedAt < AGENT_PROCESS_CACHE_TTL_MS) {
    return cachedSnapshot
  }
  if (inflight) return inflight
  inflight = getActiveAgentProcesses().then((snapshot) => {
    cachedSnapshot = snapshot
    cachedAt = Date.now()
    inflight = null
    return snapshot
  })
  return inflight
}

/** Hard request-level timeout for daemon dispatch (ms).
 *  Uses DISPATCH_TIMEOUTS + 10s grace. Fallback: 60s for unknown events. */
const DAEMON_REQUEST_TIMEOUT_GRACE_MS = 10_000
const DAEMON_REQUEST_TIMEOUT_FALLBACK_MS = 60_000

/** Maximum age before an active dispatch entry is considered stale and reaped (ms).
 *  Generous enough to cover the slowest event (stop: 180s) plus overhead. */
const STALE_DISPATCH_MAX_AGE_MS = 300_000 // 5 minutes

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

function createDispatchLifecycleHandler(
  ctx: DaemonWebServerContext
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
  ctx: DaemonWebServerContext,
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
    }
  }
}

async function handleDispatchRoute(
  req: Request,
  url: URL,
  ctx: DaemonWebServerContext
): Promise<Response> {
  const canonicalEvent = url.searchParams.get("event")
  const hookEventName = url.searchParams.get("hookEventName") ?? canonicalEvent
  if (!canonicalEvent || !hookEventName) {
    return Response.json({ error: "Missing required query param: event" }, { status: 400 })
  }
  const payloadStr = await req.text()
  const start = performance.now()

  const budgetSec = DISPATCH_TIMEOUTS[canonicalEvent]
  const requestTimeoutMs = budgetSec
    ? budgetSec * 1000 + DAEMON_REQUEST_TIMEOUT_GRACE_MS
    : DAEMON_REQUEST_TIMEOUT_FALLBACK_MS

  // Daemon-level AbortController — when the request timeout fires, this
  // signal propagates through executeDispatch → strategy → individual hooks,
  // ensuring all spawned processes are SIGTERM'd instead of orphaned.
  const requestAbort = new AbortController()

  const TIMEOUT_SENTINEL = Symbol("timeout")
  const requestTimer = setTimeout(() => requestAbort.abort(), requestTimeoutMs)

  const raceResult = await Promise.race([
    executeDispatch({
      canonicalEvent,
      hookEventName,
      payloadStr,
      daemonContext: true,
      signal: requestAbort.signal,
      transcriptSummaryProvider: async (path) => {
        const index = await ctx.transcriptIndex.get(path)
        return index?.summary ?? null
      },
      manifestProvider: async (cwd) => ctx.manifestCache.get(cwd),
      onDispatchLifecycle: createDispatchLifecycleHandler(ctx),
    }),
    new Promise<typeof TIMEOUT_SENTINEL>((resolve) =>
      setTimeout(() => resolve(TIMEOUT_SENTINEL), requestTimeoutMs)
    ),
  ])

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

  return Response.json(raceResult.response)
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

async function handleGhQuery(req: Request, ctx: DaemonWebServerContext): Promise<Response> {
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
  ctx.registerProjectWatchers(body.cwd)
  ctx.touchProject(body.cwd)
  const ttlMs = typeof body?.ttlMs === "number" ? body.ttlMs : GH_QUERY_TTL_MS
  const { hit, value } = await ctx.ghCache.get(body.args, body.cwd, ttlMs)
  return Response.json({ hit, value })
}

async function handleHooksEligible(req: Request, ctx: DaemonWebServerContext): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { cwd?: string } | null
  if (typeof body?.cwd !== "string" || !body.cwd) {
    return Response.json({ error: "Missing required field: cwd" }, { status: 400 })
  }
  ctx.registerProjectWatchers(body.cwd)
  ctx.touchProject(body.cwd)
  const snapshot = await ctx.eligibilityCache.compute(body.cwd)
  return Response.json(snapshot)
}

async function handleTranscriptIndex(req: Request, ctx: DaemonWebServerContext): Promise<Response> {
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

async function handleCooldownCheck(req: Request, ctx: DaemonWebServerContext): Promise<Response> {
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

async function handleCooldownMark(req: Request, ctx: DaemonWebServerContext): Promise<Response> {
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

async function handleGitState(req: Request, ctx: DaemonWebServerContext): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    cwd?: string
  } | null
  if (typeof body?.cwd !== "string" || !body.cwd) {
    return Response.json({ error: "Missing required field: cwd" }, { status: 400 })
  }
  ctx.registerProjectWatchers(body.cwd)
  ctx.touchProject(body.cwd)
  const state = await ctx.gitStateCache.get(body.cwd)
  if (!state) {
    return Response.json({ error: "Not a git repository or no branch" }, { status: 404 })
  }
  return Response.json(state)
}

type CacheRouteHandler = (req: Request, ctx: DaemonWebServerContext) => Promise<Response>

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
  ctx: DaemonWebServerContext
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
  ctx.registerProjectWatchers(body.cwd)
  ctx.touchProject(body.cwd)
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

async function checkWebhookSignature(req: Request, rawBody: ArrayBuffer): Promise<Response | null> {
  const webhookSecret = (await readSwizSettings()).githubWebhookSecret
  if (!webhookSecret) return null
  const sig = req.headers.get("X-Hub-Signature-256")
  const valid = await verifyWebhookSignature(webhookSecret, rawBody, sig)
  return valid ? null : Response.json({ error: "Invalid signature" }, { status: 401 })
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
  if ("error" in parsed) {
    const status = parsed.error === "Invalid JSON payload" ? 400 : 200
    return Response.json(
      status === 400 ? { error: parsed.error } : { ignored: true, reason: parsed.error },
      { status }
    )
  }

  const { run } = parsed
  const sha = run.head_sha
  const status = (run.status ?? "").toLowerCase()
  const conclusion = (run.conclusion ?? "").toLowerCase()
  const runId = run.id ?? 0

  if (!sha || status !== "completed" || !conclusion) {
    return Response.json({ ignored: true, reason: "run not yet completed" })
  }

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

async function handlePrPollRoute(req: Request, ctx: DaemonWebServerContext): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { cwd?: string } | null
  if (typeof body?.cwd !== "string" || !body.cwd) {
    return Response.json({ error: "Missing required field: cwd (string)" }, { status: 400 })
  }
  const cwd = body.cwd
  const start = performance.now()
  try {
    const payloadStr = JSON.stringify({ cwd })
    const result = await executeDispatch({
      canonicalEvent: "prPoll",
      hookEventName: "prPoll",
      payloadStr,
      daemonContext: true,
      transcriptSummaryProvider: async (path) => {
        const index = await ctx.transcriptIndex.get(path)
        return index?.summary ?? null
      },
      manifestProvider: async (projectCwd) => ctx.manifestCache.get(projectCwd),
    })
    const durationMs = performance.now() - start
    recordDispatch(ctx.globalMetrics, "prPoll", durationMs)
    ctx.touchProject(cwd)
    recordDispatch(ctx.getProjectMetrics(cwd), "prPoll", durationMs)
    ctx.registerProjectWatchers(cwd)
    return Response.json({ success: true, response: result.response, durationMs, exitCode: 0 })
  } catch (error) {
    const durationMs = performance.now() - start
    return Response.json(
      {
        success: false,
        stderr: error instanceof Error ? error.message : String(error),
        durationMs,
        exitCode: 1,
      },
      { status: 500 }
    )
  }
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

  ctx.registerProjectWatchers(cwd)
  ctx.touchProject(cwd)

  const repo = await getRepoSlug(cwd)
  if (!repo) return Response.json({ repo: null, pullRequests: [] satisfies DashboardPrRecord[] })

  const limit = Math.max(1, Math.min(30, body?.limit ?? 10))
  const reader = getIssueStoreReader()
  let prs = await reader.listPullRequests<unknown>(repo)

  let syncing = false
  if (prs.length === 0) {
    // Fire-and-forget: don't block the response on network sync
    void ctx.upstreamSyncRegistry.register(cwd).then(() => ctx.upstreamSyncRegistry.syncNow(cwd))
    syncing = true
  }

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
  ctx.registerProjectWatchers(cwd)
  ctx.touchProject(cwd)
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

  ctx.registerProjectWatchers(cwd)
  ctx.touchProject(cwd)

  const repo = await getRepoSlug(cwd)
  if (!repo) return Response.json({ repo: null, issues: [] satisfies DashboardIssueRecord[] })

  const limit = Math.max(1, Math.min(30, body?.limit ?? 10))
  const reader = getIssueStoreReader()
  let issues = await reader.listIssues<unknown>(repo)

  let syncing = false
  if (issues.length === 0) {
    // Fire-and-forget: don't block the response on network sync
    void ctx.upstreamSyncRegistry.register(cwd).then(() => ctx.upstreamSyncRegistry.syncNow(cwd))
    syncing = true
  }

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
  const body = (await req.json().catch(() => null)) as { updates?: Record<string, unknown> } | null
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
    "gitStatusGate",
    "ambitionMode",
    "memoryWordThreshold",
    "memoryLineThreshold",
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
  ctx.registerProjectWatchers(body.cwd)
  ctx.touchProject(body.cwd)
  const cached = await ctx.projectSettingsCache.get(body.cwd)
  const globalSettings = await readSwizSettings()
  return Response.json({ ...cached, globalSettings: { prMergeMode: globalSettings.prMergeMode } })
}

async function applyProjectSettingsUpdates(
  cwd: string,
  normalized: Record<string, unknown>
): Promise<void> {
  const projectUpdates: Record<string, unknown> = {}
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

  ctx.registerProjectWatchers(cwd)
  ctx.touchProject(cwd)
  await applyProjectSettingsUpdates(cwd, normalized)
  ctx.projectSettingsCache.invalidateProject(cwd)
  ctx.manifestCache.invalidateProject(cwd)
  const cached = await ctx.projectSettingsCache.get(cwd)
  const globalSettings = await readSwizSettings()
  return Response.json({ ...cached, globalSettings: { prMergeMode: globalSettings.prMergeMode } })
}

function validateBooleanField(updates: Record<string, unknown>, key: string): string | null {
  if (key in updates && typeof updates[key] !== "boolean") {
    return `${key} must be a boolean`
  }
  return null
}

function normalizeProjectSettingsUpdates(
  updates: Record<string, unknown>
): Record<string, unknown> | { error: string } {
  const result: Record<string, unknown> = {}
  const validModes = new Set(["auto", "solo", "team", "relaxed-collab"])
  const optionalKeys = [
    "trivialMaxFiles",
    "trivialMaxLines",
    "defaultBranch",
    "memoryLineThreshold",
    "memoryWordThreshold",
    "largeFileSizeKb",
    "taskDurationWarningMinutes",
    "ambitionMode",
  ] as const

  if ("collaborationMode" in updates) {
    const mode = updates.collaborationMode
    if (!validModes.has(String(mode))) {
      return { error: "collaborationMode must be one of: auto, solo, team, relaxed-collab" }
    }
    result.collaborationMode = mode
  }

  for (const boolKey of ["prMergeMode", "strictNoDirectMain"] as const) {
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
    getSessionTasks,
    getProjectTasks,
    getAgentProcessSnapshot: () => getCachedAgentProcesses(),
  }
}

function handleDispatchActive(url: URL, ctx: DaemonWebServerContext): Response {
  const cwd = url.searchParams.get("cwd")
  const sessionId = url.searchParams.get("sessionId")
  const active = [...ctx.activeHookDispatches.values()]
    .filter((entry) => (cwd ? entry.cwd === cwd : true))
    .filter((entry) => (sessionId ? entry.sessionId === sessionId : true))
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
  const snapshot = await ctx.resolveSnapshot(body.cwd, body?.sessionId ?? null)
  return Response.json({ snapshot })
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
  "POST /pr-poll": (req, _url, ctx) => handlePrPollRoute(req, ctx),
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
  handleCacheRoutes,
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
