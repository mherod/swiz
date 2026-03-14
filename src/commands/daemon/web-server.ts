import { dirname, extname, join } from "node:path"
import tailwindcss from "bun-plugin-tailwind"
import type { LRUCache } from "lru-cache"
import { executeDispatch } from "../../dispatch/execute.ts"
import { getGhRateLimitStats } from "../../gh-rate-limit.ts"
import { getRepoSlug } from "../../git-helpers.ts"
import { getIssueStore } from "../../issue-store.ts"
import { deleteSessionData, resolveSessionDeletionTargets } from "../../session-data-delete.ts"
import {
  readSwizSettings,
  settingsStore,
  writeProjectSettings,
  writeSwizSettings,
} from "../../settings.ts"
import type { WarmStatusLineSnapshot } from "../status-line.ts"
import type { CiWatchRegistry } from "./ci-watch-registry.ts"
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

export const WEB_ROOT = join(dirname(Bun.main), "src", "web")
export const PUBLIC_ROOT = join(dirname(Bun.main), "www", "public")
export const WEB_TSX_TRANSPILER = new Bun.Transpiler({
  loader: "tsx",
  autoImportJSX: true,
})
export const WEB_TS_TRANSPILER = new Bun.Transpiler({
  loader: "ts",
})

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

export async function serveWebAsset(pathname: string): Promise<Response | null> {
  const filePath = resolveWebAssetPath(pathname)
  if (!filePath) {
    return new Response("Bad Request", { status: 400 })
  }

  const file = Bun.file(filePath)
  if (!(await file.exists())) return null

  const extension = extname(filePath)
  if (extension === ".tsx" || extension === ".ts") {
    const source = await file.text()
    const code =
      extension === ".tsx"
        ? WEB_TSX_TRANSPILER.transformSync(source)
        : WEB_TS_TRANSPILER.transformSync(source)
    return new Response(code, {
      headers: {
        "cache-control": "no-cache",
        "content-type": "text/javascript; charset=utf-8",
      },
    })
  }

  if (extension === ".css") {
    const result = await Bun.build({
      entrypoints: [filePath],
      plugins: [tailwindcss],
    })
    const output = result.outputs[0]
    if (output) {
      return new Response(output, {
        headers: {
          "cache-control": "no-cache",
          "content-type": "text/css; charset=utf-8",
        },
      })
    }
  }

  const contentType = WEB_MIME_TYPES[extname(filePath)] ?? "application/octet-stream"
  return new Response(file, {
    headers: {
      "cache-control": "no-cache",
      "content-type": contentType,
    },
  })
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
  if (snapshot.reviewDecision === "CHANGES_REQUESTED") {
    parts.push("changes requested")
  } else if (snapshot.reviewDecision === "APPROVED") {
    parts.push("approved")
  } else if (snapshot.commentCount > 0) {
    parts.push(`${snapshot.commentCount} comment${snapshot.commentCount === 1 ? "" : "s"}`)
  }
  if (parts.length === 0) return "No status data yet"
  return parts.join(" | ")
}

interface DashboardIssueLabel {
  name: string
  color: string | null
}

interface DashboardIssueActor {
  login: string
}

interface DashboardIssueRecord {
  number: number
  title: string
  updatedAt: string | null
  state: string | null
  author: DashboardIssueActor | null
  assignees: DashboardIssueActor[]
  labels: DashboardIssueLabel[]
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value
  }
  return null
}

function normalizeDashboardIssue(raw: unknown): DashboardIssueRecord | null {
  const issue = asObject(raw)
  if (!issue) return null
  if ("pull_request" in issue || "pullRequest" in issue) return null

  const number = typeof issue.number === "number" ? issue.number : null
  const title = pickString(issue.title)
  if (!number || !title) return null

  const authorObject = asObject(issue.author) ?? asObject(issue.user)
  const authorLogin = pickString(authorObject?.login)

  const assignees = Array.isArray(issue.assignees)
    ? issue.assignees
        .map((entry) => pickString(asObject(entry)?.login))
        .filter((login): login is string => login !== null)
        .map((login) => ({ login }))
    : []

  const labels = Array.isArray(issue.labels)
    ? issue.labels
        .map((entry) => {
          const label = asObject(entry)
          const name = pickString(label?.name)
          if (!name) return null
          return {
            name,
            color: pickString(label?.color),
          }
        })
        .filter((label): label is DashboardIssueLabel => label !== null)
    : []

  return {
    number,
    title,
    updatedAt: pickString(issue.updatedAt, issue.updated_at),
    state: pickString(issue.state),
    author: authorLogin ? { login: authorLogin } : null,
    assignees,
    labels,
  }
}

function issueUpdatedAtMs(updatedAt: string | null): number {
  if (!updatedAt) return 0
  const parsed = Date.parse(updatedAt)
  return Number.isFinite(parsed) ? parsed : 0
}

const STALE_ISSUES_TTL_MS = 60 * 60 * 1000

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
  const result = await executeDispatch({
    canonicalEvent,
    hookEventName,
    payloadStr,
    daemonContext: true,
    transcriptSummaryProvider: async (path) => {
      const index = await ctx.transcriptIndex.get(path)
      return index?.summary ?? null
    },
    manifestProvider: async (cwd) => ctx.manifestCache.get(cwd),
    onDispatchLifecycle: (update) => {
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
    },
  })
  const durationMs = performance.now() - start
  recordDispatch(ctx.globalMetrics, canonicalEvent, durationMs)
  const parsed = await ctx.workerRuntime.parseDispatchPayload(payloadStr)
  if (parsed) {
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
  return Response.json(result.response)
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

async function handleCiRoutes(
  req: Request,
  url: URL,
  ctx: DaemonWebServerContext
): Promise<Response | null> {
  if (url.pathname === "/ci-watch" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as { cwd?: string; sha?: string } | null
    if (typeof body?.cwd !== "string" || !body.cwd || typeof body?.sha !== "string" || !body.sha) {
      return Response.json(
        { error: "Missing required fields: cwd (string), sha (string)" },
        { status: 400 }
      )
    }
    ctx.registerProjectWatchers(body.cwd)
    ctx.touchProject(body.cwd)
    const started = ctx.ciWatchRegistry.start(body.cwd, body.sha)
    return Response.json(started)
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

interface DashboardPrRecord {
  number: number
  title: string
  state: string | null
  headRefName: string | null
  url: string | null
  createdAt: string | null
  updatedAt: string | null
  author: DashboardIssueActor | null
  reviewDecision: string | null
  mergeable: string | null
}

function normalizeDashboardPr(raw: unknown): DashboardPrRecord | null {
  const pr = asObject(raw)
  if (!pr) return null
  const number = typeof pr.number === "number" ? pr.number : null
  const title = pickString(pr.title)
  if (!number || !title) return null
  const authorObject = asObject(pr.author) ?? asObject(pr.user)
  const authorLogin = pickString(authorObject?.login)
  return {
    number,
    title,
    state: pickString(pr.state),
    headRefName: pickString(pr.headRefName),
    url: pickString(pr.url),
    createdAt: pickString(pr.createdAt),
    updatedAt: pickString(pr.updatedAt, pr.updated_at),
    author: authorLogin ? { login: authorLogin } : null,
    reviewDecision: pickString(pr.reviewDecision),
    mergeable: pickString(pr.mergeable),
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
  const store = getIssueStore()
  let prs = store.listPullRequests<unknown>(repo)

  if (prs.length === 0) {
    await ctx.upstreamSyncRegistry.register(cwd)
    await ctx.upstreamSyncRegistry.syncNow(cwd)
    prs = store.listPullRequests<unknown>(repo)
  }

  if (prs.length === 0) {
    prs = store.listPullRequests<unknown>(repo, STALE_ISSUES_TTL_MS)
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

  return Response.json({ repo, pullRequests: normalizedPrs })
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
  const store = getIssueStore()
  let issues = store.listIssues<unknown>(repo)

  // The dashboard often loads a project before the background sync has ever run for it.
  // Prime the cache synchronously on the first miss so the issues panel can hydrate immediately.
  if (issues.length === 0) {
    await ctx.upstreamSyncRegistry.register(cwd)
    await ctx.upstreamSyncRegistry.syncNow(cwd)
    issues = store.listIssues<unknown>(repo)
  }

  if (issues.length === 0) {
    issues = store.listIssues<unknown>(repo, STALE_ISSUES_TTL_MS)
  }

  const normalizedIssues = issues
    .map((issue) => normalizeDashboardIssue(issue))
    .filter((issue): issue is DashboardIssueRecord => issue !== null)
    .toSorted((a, b) => issueUpdatedAtMs(b.updatedAt) - issueUpdatedAtMs(a.updatedAt))
    .slice(0, limit)

  return Response.json({ repo, issues: normalizedIssues })
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

function normalizeProjectSettingsUpdates(
  updates: Record<string, unknown>
): Record<string, unknown> | { error: string } {
  const result: Record<string, unknown> = {}
  if ("collaborationMode" in updates) {
    const mode = updates.collaborationMode
    if (mode !== "auto" && mode !== "solo" && mode !== "team" && mode !== "relaxed-collab") {
      return { error: "collaborationMode must be one of: auto, solo, team, relaxed-collab" }
    }
    result.collaborationMode = mode
  }
  if ("prMergeMode" in updates) {
    if (typeof updates.prMergeMode !== "boolean") {
      return { error: "prMergeMode must be a boolean" }
    }
    result.prMergeMode = updates.prMergeMode
  }
  if ("strictNoDirectMain" in updates) {
    if (typeof updates.strictNoDirectMain !== "boolean") {
      return { error: "strictNoDirectMain must be a boolean" }
    }
    result.strictNoDirectMain = updates.strictNoDirectMain
  }
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
    getAgentProcessSnapshot: () => getActiveAgentProcesses(),
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
    return Response.json(await getActiveAgentProcesses())
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

async function handleGhRateLimit(): Promise<Response> {
  const stats = await getGhRateLimitStats()
  return Response.json(stats)
}

const TOP_ROUTE_TABLE: Record<string, TopRouteHandler> = {
  "POST /dispatch": handleDispatchRoute,
  "GET /dispatch/active": (_req, url, ctx) => handleDispatchActive(url, ctx),
  "GET /metrics": (_req, url, ctx) => handleMetricsRoute(url, ctx),
  "GET /api/gh-rate-limit": () => handleGhRateLimit(),
  "GET /process/agents": () => handleProcessAgents(),
  "POST /process/agents/kill": (req) => handleProcessKill(req),
  "POST /sessions/delete": (req) => handleSessionDelete(req),
  "POST /projects/issues": (req, _url, ctx) => handleProjectIssuesRoute(req, ctx),
  "POST /projects/prs": (req, _url, ctx) => handleProjectPrsRoute(req, ctx),
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

export function startDaemonWebServer(ctx: DaemonWebServerContext) {
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
      const url = new URL(req.url)
      return handleFetchRoutes(req, url, ctx)
    },
  })
  return server
}
