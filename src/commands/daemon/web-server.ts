import { dirname, extname, join } from "node:path"
import { executeDispatch } from "../../dispatch/execute.ts"
import { deleteSessionData, resolveSessionDeletionTargets } from "../../session-data-delete.ts"
import {
  readSwizSettings,
  settingsStore,
  writeProjectSettings,
  writeSwizSettings,
} from "../../settings.ts"
import {
  type ActiveHookDispatch,
  type CachedSnapshot,
  type CiWatchRegistry,
  type CooldownRegistry,
  createMetrics,
  type DaemonMetrics,
  type FileWatcherRegistry,
  GH_QUERY_TTL_MS,
  type GhQueryCache,
  type GitStateCache,
  getProjectTasks,
  getSessionData,
  getSessionTasks,
  type HookEligibilityCache,
  listProjectSessions,
  type ManifestCache,
  type ProjectSettingsCache,
  recordDispatch,
  serializeMetrics,
  type TranscriptIndexCache,
} from "../daemon.ts"
import type { WarmStatusLineSnapshot } from "../status-line.ts"
import { handleSessionRoutes } from "./session-routes.ts"
import { type CapturedToolCall, captureSessionToolCall, stripAnsi } from "./utils.ts"
import type { DaemonWorkerRuntime } from "./worker-runtime.ts"

export const WEB_ROOT = join(dirname(Bun.main), "src", "web")
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
  projectSettingsCache: ProjectSettingsCache
  registeredProjects: Set<string>
  projectLastSeen: Map<string, number>
  resolveSnapshot: (
    cwd: string,
    sessionId: string | null | undefined
  ) => Promise<WarmStatusLineSnapshot>
  watchers: FileWatcherRegistry
  snapshots: Map<string, CachedSnapshot>
  workerRuntime: DaemonWorkerRuntime
}

interface AgentProcessSnapshot {
  providers: Record<string, number[]>
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

async function getActiveAgentProcesses(): Promise<AgentProcessSnapshot> {
  const proc = Bun.spawn(["ps", "-Ao", "pid,command"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  if (proc.exitCode !== 0) return { providers: {} }

  const providers = new Map<string, Set<number>>()
  const addProviderPid = (provider: string, pid: number) => {
    const existing = providers.get(provider) ?? new Set<number>()
    existing.add(pid)
    providers.set(provider, existing)
  }

  const rows = stdout.split("\n")
  for (const row of rows) {
    const trimmed = row.trim()
    if (!trimmed) continue
    const match = /^(\d+)\s+(.+)$/.exec(trimmed)
    if (!match) continue
    const pid = Number(match[1])
    const command = (match[2] ?? "").toLowerCase()
    const executable = command.split(/\s+/, 1)[0] ?? ""
    if (!pid || !command) continue

    if (command.includes("claude-agent-sdk/cli.js")) {
      addProviderPid("claude", pid)
    }
    if (command.includes("/codex") || command.includes(" codex ")) {
      addProviderPid("codex", pid)
    }
    if (command.includes("gemini")) {
      addProviderPid("gemini", pid)
    }
    if (isCursorMacProcess(command) || executable === "agent" || executable.endsWith("/agent")) {
      addProviderPid("cursor", pid)
    }
  }

  const snapshot: Record<string, number[]> = {}
  for (const [provider, pids] of providers) {
    snapshot[provider] = [...pids].sort((a, b) => a - b)
  }
  return { providers: snapshot }
}

export function startDaemonWebServer(ctx: DaemonWebServerContext) {
  const {
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
  } = ctx

  const notFound = () => new Response("Not Found", { status: 404 })
  const server = Bun.serve({
    port,
    routes: {
      // Static response route: Bun caches this for zero-allocation dispatch.
      "/health": new Response("ok"),
      "/": async (req) => {
        if (req.method !== "GET") return notFound()
        const asset = await serveWebAsset("/")
        return asset ?? notFound()
      },
      "/web": async (req) => {
        if (req.method !== "GET") return notFound()
        const asset = await serveWebAsset("/web/index.html")
        return asset ?? notFound()
      },
      "/web/*": async (req) => {
        if (req.method !== "GET") return notFound()
        const pathname = new URL(req.url).pathname
        const asset = await serveWebAsset(pathname)
        return asset ?? notFound()
      },
      "/favicon.ico": async (req) => {
        if (req.method !== "GET") return notFound()
        const asset = await serveWebAsset("/web/favicon.ico")
        return asset ?? new Response(null, { status: 204 })
      },
    },
    async fetch(req) {
      pruneTranscriptMemory()
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
          transcriptSummaryProvider: async (path) => {
            const index = await transcriptIndex.get(path)
            return index?.summary ?? null
          },
          manifestProvider: async (cwd) => manifestCache.get(cwd),
          onDispatchLifecycle: (update) => {
            if (update.phase === "start") {
              activeHookDispatches.set(update.requestId, {
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
            activeHookDispatches.delete(update.requestId)
          },
        })
        const durationMs = performance.now() - start
        recordDispatch(globalMetrics, canonicalEvent, durationMs)
        const parsed = await workerRuntime.parseDispatchPayload(payloadStr)
        if (parsed) {
          const nowMs = Date.now()
          if (parsed.cwd) {
            touchProject(parsed.cwd)
            recordDispatch(getProjectMetrics(parsed.cwd), canonicalEvent, durationMs)
            registerProjectWatchers(parsed.cwd)
          }
          if (parsed.sessionId) {
            const prev = sessionActivity.get(parsed.sessionId)
            sessionActivity.set(parsed.sessionId, {
              lastSeen: nowMs,
              dispatches: (prev?.dispatches ?? 0) + 1,
            })

            if (canonicalEvent === "preToolUse" && parsed.toolName) {
              captureSessionToolCall(
                sessionToolCalls,
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

      if (url.pathname === "/dispatch/active" && req.method === "GET") {
        const cwd = url.searchParams.get("cwd")
        const sessionId = url.searchParams.get("sessionId")
        const active = [...activeHookDispatches.values()]
          .filter((entry) => (cwd ? entry.cwd === cwd : true))
          .filter((entry) => (sessionId ? entry.sessionId === sessionId : true))
          .sort((a, b) => b.startedAt - a.startedAt)
        return Response.json({ active })
      }

      if (url.pathname === "/metrics" && req.method === "GET") {
        const projectParam = url.searchParams.get("project")
        if (projectParam) {
          const pm = projectMetrics.get(projectParam)
          return Response.json({
            ...(pm ? serializeMetrics(pm) : serializeMetrics(createMetrics())),
            project: projectParam,
          })
        }
        const projects: Record<string, ReturnType<typeof serializeMetrics>> = {}
        for (const [cwd, m] of projectMetrics) {
          projects[cwd] = serializeMetrics(m)
        }
        return Response.json({ ...serializeMetrics(globalMetrics), projects })
      }

      if (url.pathname === "/process/agents" && req.method === "GET") {
        const snapshot = await getActiveAgentProcesses()
        return Response.json(snapshot)
      }

      if (url.pathname === "/process/agents/kill" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          pid?: number
        } | null
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
        const killProc = Bun.spawn(killCommand, {
          stdout: "pipe",
          stderr: "pipe",
        })
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

      if (url.pathname === "/sessions/delete" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          cwd?: string
          sessionId?: string
        } | null
        const cwd = body?.cwd
        const sessionId = body?.sessionId
        if (typeof cwd !== "string" || cwd.length === 0 || typeof sessionId !== "string") {
          return Response.json(
            { error: "Missing required fields: cwd (string), sessionId (string)" },
            { status: 400 }
          )
        }
        const targets = await resolveSessionDeletionTargets(cwd, sessionId)
        if (targets.matchedSessions.length === 0) {
          return Response.json({ error: `Session ${sessionId} not found` }, { status: 404 })
        }
        const activeProcesses = await getActiveAgentProcesses()
        const blockedProviders = new Map<string, number[]>()
        for (const session of targets.matchedSessions) {
          const provider = (session.provider ?? "unknown").toLowerCase()
          const providerPids = activeProcesses.providers[provider] ?? []
          if (providerPids.length > 0) blockedProviders.set(provider, providerPids)
        }
        if (blockedProviders.size > 0) {
          return Response.json(
            {
              error: "Cannot delete session while provider process is active",
              providers: Object.fromEntries(blockedProviders),
            },
            { status: 409 }
          )
        }
        const { deletedCount, failedPaths, sessionIds } = await deleteSessionData(targets)
        if (failedPaths.length > 0) {
          return Response.json(
            {
              error: "Failed to delete one or more session paths",
              failedPaths,
            },
            { status: 500 }
          )
        }
        return Response.json({ ok: true, deletedCount, sessionIds })
      }

      if (url.pathname === "/gh-query" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          args?: string[]
          cwd?: string
          ttlMs?: number
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
        touchProject(cwd)
        const ttlMs = typeof body?.ttlMs === "number" ? body.ttlMs : GH_QUERY_TTL_MS
        const { hit, value } = await ghCache.get(args, cwd, ttlMs)
        return Response.json({ hit, value })
      }

      if (url.pathname === "/hooks/eligible" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          cwd?: string
        } | null
        const cwd = body?.cwd
        if (typeof cwd !== "string" || cwd.length === 0) {
          return Response.json({ error: "Missing required field: cwd" }, { status: 400 })
        }
        registerProjectWatchers(cwd)
        touchProject(cwd)
        const snapshot = await eligibilityCache.compute(cwd)
        return Response.json(snapshot)
      }

      if (url.pathname === "/transcript/index" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          transcriptPath?: string
        } | null
        const tp = body?.transcriptPath
        if (typeof tp !== "string" || tp.length === 0) {
          return Response.json({ error: "Missing required field: transcriptPath" }, { status: 400 })
        }
        const index = await transcriptIndex.get(tp)
        if (!index) {
          return Response.json({ error: "Transcript not found or unreadable" }, { status: 404 })
        }
        return Response.json(index)
      }

      if (url.pathname === "/hooks/cooldown" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          hookFile?: string
          cooldownSeconds?: number
          cwd?: string
        } | null
        const hookFile = body?.hookFile
        const cooldownSeconds = body?.cooldownSeconds
        const cwd = body?.cwd
        if (
          typeof hookFile !== "string" ||
          typeof cooldownSeconds !== "number" ||
          typeof cwd !== "string" ||
          cwd.length === 0
        ) {
          return Response.json(
            {
              error:
                "Missing required fields: hookFile (string), cooldownSeconds (number), cwd (string)",
            },
            { status: 400 }
          )
        }
        const withinCooldown = cooldownRegistry.isWithinCooldown(hookFile, cooldownSeconds, cwd)
        return Response.json({ withinCooldown })
      }

      if (url.pathname === "/hooks/cooldown/mark" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          hookFile?: string
          cwd?: string
        } | null
        const hookFile = body?.hookFile
        const cwd = body?.cwd
        if (typeof hookFile !== "string" || typeof cwd !== "string" || cwd.length === 0) {
          return Response.json(
            { error: "Missing required fields: hookFile (string), cwd (string)" },
            { status: 400 }
          )
        }
        cooldownRegistry.mark(hookFile, cwd)
        return Response.json({ marked: true })
      }

      if (url.pathname === "/git/state" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          cwd?: string
        } | null
        const cwd = body?.cwd
        if (typeof cwd !== "string" || cwd.length === 0) {
          return Response.json({ error: "Missing required field: cwd" }, { status: 400 })
        }
        registerProjectWatchers(cwd)
        touchProject(cwd)
        const state = await gitStateCache.get(cwd)
        if (!state) {
          return Response.json({ error: "Not a git repository or no branch" }, { status: 404 })
        }
        return Response.json(state)
      }

      if (url.pathname === "/ci-watch" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          cwd?: string
          sha?: string
        } | null
        const cwd = body?.cwd
        const sha = body?.sha
        if (
          typeof cwd !== "string" ||
          cwd.length === 0 ||
          typeof sha !== "string" ||
          sha.length === 0
        ) {
          return Response.json(
            { error: "Missing required fields: cwd (string), sha (string)" },
            { status: 400 }
          )
        }
        registerProjectWatchers(cwd)
        touchProject(cwd)
        const started = ciWatchRegistry.start(cwd, sha)
        return Response.json(started)
      }

      if (url.pathname === "/ci-watches" && req.method === "GET") {
        const cwd = url.searchParams.get("cwd")
        const active = ciWatchRegistry
          .listActive()
          .filter((entry) => (cwd ? entry.cwd === cwd : true))
        return Response.json({ active })
      }

      if (url.pathname === "/pr-poll" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          cwd?: string
        } | null
        const cwd = body?.cwd
        if (typeof cwd !== "string" || cwd.length === 0) {
          return Response.json({ error: "Missing required field: cwd (string)" }, { status: 400 })
        }

        const start = performance.now()
        try {
          const payloadStr = JSON.stringify({ cwd })
          const result = await executeDispatch({
            canonicalEvent: "prPoll",
            hookEventName: "prPoll",
            payloadStr,
            daemonContext: true,
            transcriptSummaryProvider: async (path) => {
              const index = await transcriptIndex.get(path)
              return index?.summary ?? null
            },
            manifestProvider: async (projectCwd) => manifestCache.get(projectCwd),
          })
          const durationMs = performance.now() - start
          recordDispatch(globalMetrics, "prPoll", durationMs)

          touchProject(cwd)
          recordDispatch(getProjectMetrics(cwd), "prPoll", durationMs)
          registerProjectWatchers(cwd)

          return Response.json({
            success: true,
            response: result.response,
            durationMs,
            exitCode: 0,
          })
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

      if (url.pathname === "/settings/global" && req.method === "GET") {
        const globalSettings = await readSwizSettings()
        return Response.json({ settings: globalSettings })
      }

      if (url.pathname === "/settings/global/update" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          updates?: Record<string, unknown>
        } | null
        const updates = body?.updates
        if (!updates || typeof updates !== "object") {
          return Response.json(
            { error: "Missing required field: updates (object)" },
            { status: 400 }
          )
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
          if (key in updates) {
            await settingsStore.setGlobal(key, updates[key])
            updatedAny = true
          }
        }

        if (!updatedAny) {
          return Response.json({ error: "No supported updates provided" }, { status: 400 })
        }

        const globalSettings = await readSwizSettings()
        return Response.json({ success: true, settings: globalSettings })
      }

      if (url.pathname === "/settings/project" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          cwd?: string
        } | null
        const cwd = body?.cwd
        if (typeof cwd !== "string" || cwd.length === 0) {
          return Response.json({ error: "Missing required field: cwd" }, { status: 400 })
        }
        registerProjectWatchers(cwd)
        touchProject(cwd)
        const cached = await projectSettingsCache.get(cwd)
        const globalSettings = await readSwizSettings()
        return Response.json({
          ...cached,
          globalSettings: {
            prMergeMode: globalSettings.prMergeMode,
          },
        })
      }

      if (url.pathname === "/settings/project/update" && req.method === "POST") {
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
        if (
          typeof cwd !== "string" ||
          cwd.length === 0 ||
          !updates ||
          typeof updates !== "object"
        ) {
          return Response.json(
            { error: "Missing required fields: cwd (string), updates (object)" },
            { status: 400 }
          )
        }

        const normalizedUpdates: Record<string, unknown> = {}

        if ("collaborationMode" in updates) {
          const mode = updates.collaborationMode
          if (mode !== "auto" && mode !== "solo" && mode !== "team" && mode !== "relaxed-collab") {
            return Response.json(
              {
                error: "collaborationMode must be one of: auto, solo, team, relaxed-collab",
              },
              { status: 400 }
            )
          }
          normalizedUpdates.collaborationMode = mode
        }

        if ("prMergeMode" in updates) {
          if (typeof updates.prMergeMode !== "boolean") {
            return Response.json({ error: "prMergeMode must be a boolean" }, { status: 400 })
          }
          normalizedUpdates.prMergeMode = updates.prMergeMode
        }

        if ("strictNoDirectMain" in updates) {
          if (typeof updates.strictNoDirectMain !== "boolean") {
            return Response.json({ error: "strictNoDirectMain must be a boolean" }, { status: 400 })
          }
          normalizedUpdates.strictNoDirectMain = updates.strictNoDirectMain
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
          if (key in updates) {
            normalizedUpdates[key] = updates[key]
          }
        }

        if (Object.keys(normalizedUpdates).length === 0) {
          return Response.json({ error: "No supported updates provided" }, { status: 400 })
        }

        registerProjectWatchers(cwd)
        touchProject(cwd)
        const projectUpdates: Record<string, unknown> = {}
        for (const key of Object.keys(normalizedUpdates)) {
          if (key !== "prMergeMode") {
            projectUpdates[key] = normalizedUpdates[key]
          }
        }
        if (Object.keys(projectUpdates).length > 0) {
          await writeProjectSettings(cwd, projectUpdates)
        }
        if (normalizedUpdates.prMergeMode !== undefined) {
          const globalSettings = await readSwizSettings()
          await writeSwizSettings({
            ...globalSettings,
            prMergeMode: normalizedUpdates.prMergeMode as boolean,
          })
        }
        projectSettingsCache.invalidateProject(cwd)
        manifestCache.invalidateProject(cwd)
        const cached = await projectSettingsCache.get(cwd)
        const globalSettings = await readSwizSettings()
        return Response.json({
          ...cached,
          globalSettings: {
            prMergeMode: globalSettings.prMergeMode,
          },
        })
      }

      const sessionRouteResponse = await handleSessionRoutes(req, url, {
        touchProject,
        getKnownProjects: () => [
          ...new Set([process.cwd(), ...registeredProjects, ...projectMetrics.keys()]),
        ],
        getProjectLastSeen: (cwd) => projectLastSeen.get(cwd) ?? 0,
        getProjectStatusLine: async (cwd, sessionId) => {
          const snapshot = await resolveSnapshot(cwd, sessionId ?? null)
          return formatWebProjectStatusLine(snapshot)
        },
        listProjectSessions: (cwd, limit, pinnedSessionId) =>
          listProjectSessions(cwd, limit, sessionActivity, pinnedSessionId),
        getSessionData: (cwd, sessionId, limit) =>
          getSessionData(cwd, sessionId, limit, sessionToolCalls),
        getSessionTasks,
        getProjectTasks,
      })
      if (sessionRouteResponse) return sessionRouteResponse

      if (url.pathname === "/cache/status" && req.method === "GET") {
        return Response.json({
          watchers: watchers.status(),
          snapshotCacheSize: snapshots.size,
          ghCacheSize: ghCache.size,
          eligibilityCacheSize: eligibilityCache.size,
          transcriptIndexSize: transcriptIndex.size,
          cooldownRegistrySize: cooldownRegistry.size,
          gitStateCacheSize: gitStateCache.size,
          projectSettingsCacheSize: projectSettingsCache.size,
          manifestCacheSize: manifestCache.size,
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

  return server
}
