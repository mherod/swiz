/**
 * Full daemon web-server context type and the narrowed per-domain context
 * builders derived from it. Extracted from web-server.ts (issue #685) to
 * keep the router file focused on routing.
 */

import { stat } from "node:fs/promises"
import { join } from "node:path"
import type { LRUCache } from "lru-cache"
import { findTaskStoreForSession } from "../../task-roots.ts"
import type { WarmStatusLineSnapshot } from "../status-line.ts"
import { getCachedAgentProcesses } from "./agent-process-discovery.ts"
import type { CappedMap } from "./cache/capped-map.ts"
import type { CacheRoutesContext } from "./cache-routes.ts"
import type { CiRoutesContext } from "./ci-routes.ts"
import type { CiWatchRegistry } from "./ci-watch-registry.ts"
import type { ComplianceRoutesContext } from "./compliance-routes.ts"
import type { IssueRoutesContext } from "./issue-routes.ts"
import type { LifecycleTaskRegistry } from "./lifecycle-task-registry.ts"
import type { MetricsRoutesContext } from "./metrics-routes.ts"
import type {
  CooldownRegistry,
  DaemonMetrics,
  FileWatcherRegistry,
  GhQueryCache,
  GitStateCache,
  HookEligibilityCache,
  LastUserMessageCache,
  ManifestCache,
  ProjectSettingsCache,
  TranscriptIndexCache,
} from "./runtime-cache.ts"
import { getProjectTasks, getSessionData, listProjectSessions } from "./session-data.ts"
import type { SessionRoutesContext } from "./session-routes.ts"
import type { SettingsRoutesContext } from "./settings-routes.ts"
import type { CachedSnapshot } from "./snapshot.ts"
import type { ActiveHookDispatch } from "./types.ts"
import type { UpstreamSyncRegistry } from "./upstream-sync.ts"
import {
  buildSessionTasksView,
  type CapturedToolCall,
  type SessionToolUsageState,
  stripAnsi,
} from "./utils.ts"
import type { DaemonWorkerRuntime } from "./worker-runtime.ts"

/**
 * Full daemon context assembled at bootstrap. Route groups use narrowed interfaces
 * built by the `build*RoutesContext` helpers below.
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
  lastUserMessageCache: LastUserMessageCache
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
  taskStateCache: import("../../tasks/task-state-cache.ts").TaskStateCache
  lifecycleTaskRegistry: LifecycleTaskRegistry
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

export function buildCacheRoutesContext(ctx: DaemonWebServerContext): CacheRoutesContext {
  return {
    ghCache: ctx.ghCache,
    eligibilityCache: ctx.eligibilityCache,
    transcriptIndex: ctx.transcriptIndex,
    cooldownRegistry: ctx.cooldownRegistry,
    gitStateCache: ctx.gitStateCache,
    lastUserMessageCache: ctx.lastUserMessageCache,
    ciWatchRegistry: ctx.ciWatchRegistry,
    projectSettingsCache: ctx.projectSettingsCache,
    manifestCache: ctx.manifestCache,
    touchProject: ctx.touchProject,
    registerProjectWatchers: ctx.registerProjectWatchers,
    snapshots: ctx.snapshots,
    watchers: ctx.watchers,
  }
}

export function buildSessionRoutesContext(ctx: DaemonWebServerContext): SessionRoutesContext {
  return {
    touchProject: ctx.touchProject,
    getKnownProjects: () => [...new Set([...ctx.registeredProjects, ...ctx.projectMetrics.keys()])],
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
      const { tasksDir } = findTaskStoreForSession(sessionId)
      const sessionDir = join(tasksDir, sessionId)
      try {
        await stat(sessionDir)
      } catch {
        return null
      }
      const tasks = await ctx.taskStateCache.getTasks(sessionId, sessionDir)
      return buildSessionTasksView(tasks, limit)
    },
    getProjectTasks,
    getAgentProcessSnapshot: () => getCachedAgentProcesses(),
  }
}

export function buildCiRoutesContext(ctx: DaemonWebServerContext): CiRoutesContext {
  return {
    ciWatchRegistry: ctx.ciWatchRegistry,
    touchProject: ctx.touchProject,
    registerProjectWatchers: ctx.registerProjectWatchers,
  }
}

export function buildIssueRoutesContext(ctx: DaemonWebServerContext): IssueRoutesContext {
  return {
    touchProject: ctx.touchProject,
    registerProjectWatchers: ctx.registerProjectWatchers,
    upstreamSyncRegistry: ctx.upstreamSyncRegistry,
  }
}

export function buildSettingsRoutesContext(ctx: DaemonWebServerContext): SettingsRoutesContext {
  return {
    touchProject: ctx.touchProject,
    registerProjectWatchers: ctx.registerProjectWatchers,
    projectSettingsCache: ctx.projectSettingsCache,
    manifestCache: ctx.manifestCache,
  }
}

export function buildComplianceRoutesContext(ctx: DaemonWebServerContext): ComplianceRoutesContext {
  return {
    taskStateCache: ctx.taskStateCache,
    resolveSnapshot: ctx.resolveSnapshot,
    sessionComplianceState: ctx.sessionComplianceState,
    upstreamSyncRegistry: ctx.upstreamSyncRegistry,
  }
}

export function buildMetricsRoutesContext(ctx: DaemonWebServerContext): MetricsRoutesContext {
  return {
    ghCache: ctx.ghCache,
    transcriptIndex: ctx.transcriptIndex,
    eligibilityCache: ctx.eligibilityCache,
    cooldownRegistry: ctx.cooldownRegistry,
    gitStateCache: ctx.gitStateCache,
    projectSettingsCache: ctx.projectSettingsCache,
    manifestCache: ctx.manifestCache,
    snapshots: ctx.snapshots,
    projectMetrics: ctx.projectMetrics,
    globalMetrics: ctx.globalMetrics,
    watchers: ctx.watchers,
  }
}
