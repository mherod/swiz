/**
 * Metrics and observability route handlers for the daemon web server.
 * Extracted from web-server.ts (issue #685) to keep routing code focused.
 */
import { getWorkerPoolMetrics } from "../../dispatch/worker-pool.ts"
import { getGhRateLimitStats } from "../../gh-rate-limit.ts"
import { getHookLogMetrics, readHookLogs } from "../../hook-log.ts"
import { getCodexPlanSyncMetrics } from "../../tasks/codex-update-plan.ts"
import { getTurnsCacheStats } from "../../transcript-turns.ts"
import type {
  CooldownRegistry,
  DaemonMetrics,
  GhQueryCache,
  GitStateCache,
  HookEligibilityCache,
  ManifestCache,
  ProjectSettingsCache,
  TranscriptIndexCache,
} from "./runtime-cache.ts"
import { createMetrics, serializeMetrics } from "./runtime-cache.ts"

export interface MetricsRoutesContext {
  ghCache: GhQueryCache
  transcriptIndex: TranscriptIndexCache
  eligibilityCache: HookEligibilityCache
  cooldownRegistry: CooldownRegistry
  gitStateCache: GitStateCache
  projectSettingsCache: ProjectSettingsCache
  manifestCache: ManifestCache
  snapshots: { size: number }
  projectMetrics: Map<string, DaemonMetrics>
  globalMetrics: DaemonMetrics
  watchers: { status: () => unknown }
}

export function handleMetricsRoute(url: URL, ctx: MetricsRoutesContext): Response {
  const projectParam = url.searchParams.get("project")
  const cacheMetrics = {
    ghQuery: { size: ctx.ghCache.size, hits: ctx.ghCache.hits, misses: ctx.ghCache.misses },
    transcriptIndex: {
      size: ctx.transcriptIndex.size,
      hits: ctx.transcriptIndex.hits,
      misses: ctx.transcriptIndex.misses,
      appendedBytes: ctx.transcriptIndex.appendedBytes,
      coldRebuilds: ctx.transcriptIndex.coldRebuilds,
      resets: ctx.transcriptIndex.resets,
    },
    codexPlanSync: getCodexPlanSyncMetrics(),
    turnsCache: getTurnsCacheStats(),
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
      hookLogs: getHookLogMetrics(),
      workerPool: getWorkerPoolMetrics(),
    })
  }
  const projects: Record<string, ReturnType<typeof serializeMetrics>> = {}
  for (const [cwd, m] of ctx.projectMetrics) {
    projects[cwd] = serializeMetrics(m)
  }
  return Response.json({
    ...serializeMetrics(ctx.globalMetrics),
    projects,
    caches: cacheMetrics,
    hookLogs: getHookLogMetrics(),
    workerPool: getWorkerPoolMetrics(),
  })
}

export function handleCacheStatus(ctx: MetricsRoutesContext): Response {
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

export async function handleHookLogs(url: URL): Promise<Response> {
  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") ?? "200", 10)))
  const entries = await readHookLogs(limit)
  return Response.json({ entries: entries.reverse() })
}

export async function handleGhRateLimit(): Promise<Response> {
  const stats = await getGhRateLimitStats()
  return Response.json(stats)
}
