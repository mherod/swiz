/**
 * Cache/runtime POST route handlers for the daemon web server.
 *
 * Extracted from web-server.ts (issue #685). web-server.ts builds a
 * {@link CacheRoutesContext} from its full context and delegates matching POST
 * requests to {@link handleCacheRoutes}.
 */

import type { LRUCache } from "lru-cache"
import { getIssueStoreReader } from "../../issue-store.ts"
import type { CiWatchRegistry } from "./ci-watch-registry.ts"
import { registerProjectAndTouch } from "./route-helpers.ts"
import {
  type CooldownRegistry,
  type FileWatcherRegistry,
  GH_QUERY_TTL_MS,
  type GhQueryCache,
  type GitStateCache,
  type HookEligibilityCache,
  type LastUserMessageCache,
  type ManifestCache,
  type ProjectSettingsCache,
  type TranscriptIndexCache,
} from "./runtime-cache.ts"
import type { CachedSnapshot } from "./snapshot.ts"

/**
 * Narrow context for cache route handlers — only the capabilities those handlers need.
 */
export interface CacheRoutesContext {
  ghCache: GhQueryCache
  eligibilityCache: HookEligibilityCache
  transcriptIndex: TranscriptIndexCache
  cooldownRegistry: CooldownRegistry
  gitStateCache: GitStateCache
  lastUserMessageCache: LastUserMessageCache
  ciWatchRegistry: CiWatchRegistry
  projectSettingsCache: ProjectSettingsCache
  manifestCache: ManifestCache
  touchProject: (cwd: string) => void
  registerProjectWatchers: (cwd: string) => void
  snapshots: LRUCache<string, CachedSnapshot> | Map<string, CachedSnapshot>
  watchers: FileWatcherRegistry
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

async function handleLastUserMessage(req: Request, ctx: CacheRoutesContext): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    sessionId?: string
    transcriptPath?: string
    cwd?: string
  } | null
  if (typeof body?.sessionId !== "string" || !body.sessionId) {
    return Response.json({ error: "Missing required field: sessionId" }, { status: 400 })
  }
  if (typeof body.cwd === "string" && body.cwd) registerProjectAndTouch(ctx, body.cwd)
  const entry = await ctx.lastUserMessageCache.get(body.sessionId, body.transcriptPath)
  if (!entry) {
    return Response.json({ error: "No user message recorded for session" }, { status: 404 })
  }
  return Response.json(entry)
}

async function handleSessionEditsList(req: Request, _ctx: CacheRoutesContext): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    projectKey?: string
    sessionId?: string
  } | null
  if (
    typeof body?.projectKey !== "string" ||
    !body.projectKey ||
    typeof body?.sessionId !== "string" ||
    !body.sessionId
  ) {
    return Response.json(
      { error: "Missing required fields: projectKey (string), sessionId (string)" },
      { status: 400 }
    )
  }
  const reader = getIssueStoreReader()
  const edits = await reader.listSessionEdits(body.projectKey, body.sessionId)
  return Response.json({ edits })
}

type CacheRouteHandler = (req: Request, ctx: CacheRoutesContext) => Promise<Response>

const CACHE_ROUTE_TABLE: Record<string, CacheRouteHandler> = {
  "/gh-query": handleGhQuery,
  "/hooks/eligible": handleHooksEligible,
  "/transcript/index": handleTranscriptIndex,
  "/hooks/cooldown": handleCooldownCheck,
  "/hooks/cooldown/mark": handleCooldownMark,
  "/git/state": handleGitState,
  "/sessions/last-user-message": handleLastUserMessage,
  "/session-edits/list": handleSessionEditsList,
}

export async function handleCacheRoutes(
  req: Request,
  url: URL,
  ctx: CacheRoutesContext
): Promise<Response | null> {
  if (req.method !== "POST") return null
  const handler = CACHE_ROUTE_TABLE[url.pathname]
  if (!handler) return null
  return handler(req, ctx)
}
