import { dirname, join } from "node:path"
import { stderrLog } from "../../debug.ts"
import { canonicalizePath } from "../../project-identity.ts"
import {
  getProjectSettingsPath,
  getSwizSettingsPath,
  invalidateSettingsCache,
} from "../../settings.ts"
import { invalidateTurnsCache } from "../../transcript-turns.ts"
import type { FileWatcherRegistry } from "./cache/worker-file-watcher-registry.ts"
import { providerSessionIndex, sessionDataCache } from "./session-data.ts"
import type { UpstreamSyncRegistry } from "./upstream-sync.ts"
import { transcriptWatchPathsForProject } from "./utils.ts"

export const PROJECT_IDLE_EVICTION_MS = 3 * 60 * 1000
export const MAX_WATCHED_PROJECTS = 2
const SNAPSHOT_KEY_SEPARATOR = "\x00"

export function snapshotCacheKey(cwd: string, sessionId: string | null | undefined): string {
  return `${cwd}${SNAPSHOT_KEY_SEPARATOR}${sessionId ?? ""}`
}

export function deleteProjectSnapshots(
  snapshots: { keys(): Iterable<string>; delete(key: string): unknown },
  cwd: string
): void {
  const prefix = snapshotCacheKey(cwd, null)
  for (const key of snapshots.keys()) {
    if (key.startsWith(prefix)) snapshots.delete(key)
  }
}

interface ProjectCache {
  invalidateProject(cwd: string): void
}

interface GlobalProjectCache extends ProjectCache {
  invalidateAll(): void
}

export interface ProjectLifecycleCaches {
  watchers: Pick<FileWatcherRegistry, "register" | "start" | "unregisterByLabelSuffix" | "close">
  ghCache: GlobalProjectCache
  eligibilityCache: GlobalProjectCache
  gitStateCache: GlobalProjectCache
  repositoryCapabilityCache: GlobalProjectCache
  projectSettingsCache: GlobalProjectCache
  manifestCache: GlobalProjectCache
  transcriptIndex: ProjectCache
  cooldownRegistry: ProjectCache
  lifecycleTaskRegistry: { clearProject(cwd: string): void }
  snapshots: { clear(): void; keys(): Iterable<string>; delete(key: string): unknown }
  upstreamSyncRegistry: Pick<UpstreamSyncRegistry, "register" | "syncNow" | "unregister" | "close">
}

export interface ProjectWatcherManager {
  registeredProjects: Set<string>
  registerProjectWatchers: (cwd: string) => void
  evictProject: (cwd: string) => void
  invalidateProject: (cwd: string) => void
  close: () => void
}

interface ProjectLifecycleOptions {
  /** History caches can be replaced without opening workers or reading transcripts in tests. */
  invalidateHistory?: (cwd: string) => void
  transcriptWatchPaths?: typeof transcriptWatchPathsForProject
}

function invalidateProjectHistory(cwd: string): void {
  sessionDataCache.invalidateProject(cwd)
  providerSessionIndex.invalidate(cwd)
  invalidateTurnsCache(cwd)
}

/** One lifetime owns a project's watches, invalidation and unfinished upstream activation. */
class ProjectLifecycle implements ProjectWatcherManager {
  readonly registeredProjects = new Set<string>()
  private readonly lifetimes = new Map<string, AbortController>()
  private readonly globalCaches: GlobalProjectCache[]
  private readonly projectCaches: ProjectCache[]
  private readonly invalidateHistory: (cwd: string) => void
  private readonly transcriptWatchPaths: typeof transcriptWatchPathsForProject
  private closed = false

  constructor(
    private readonly caches: ProjectLifecycleCaches,
    private readonly transcriptMonitor: { checkProject(cwd: string): Promise<void> },
    private readonly projectLastSeen: ReadonlyMap<string, number>,
    options: ProjectLifecycleOptions
  ) {
    this.globalCaches = [
      caches.ghCache,
      caches.eligibilityCache,
      caches.gitStateCache,
      caches.repositoryCapabilityCache,
      caches.projectSettingsCache,
      caches.manifestCache,
    ]
    this.projectCaches = [...this.globalCaches, caches.transcriptIndex, caches.cooldownRegistry]
    this.invalidateHistory = options.invalidateHistory ?? invalidateProjectHistory
    this.transcriptWatchPaths = options.transcriptWatchPaths ?? transcriptWatchPathsForProject
    this.registerGlobalWatchers()
  }

  private registerGlobalWatchers(): void {
    const { watchers, snapshots } = this.caches
    const flush = () => {
      if (this.closed) return
      snapshots.clear()
      for (const cache of this.globalCaches) cache.invalidateAll()
      const settingsPath = getSwizSettingsPath()
      if (settingsPath) invalidateSettingsCache(settingsPath)
    }
    const projectRoot = dirname(Bun.main)
    const settingsPath = getProjectSettingsPath(projectRoot)
    if (settingsPath) {
      watchers.register(settingsPath, "settings", flush)
      invalidateSettingsCache(settingsPath)
    }
    watchers.register(join(projectRoot, "src", "manifest.ts"), "manifest", flush)
    watchers.register(join(projectRoot, "hooks/"), "hooks", flush)
    const globalSettingsPath = getSwizSettingsPath()
    if (globalSettingsPath) watchers.register(globalSettingsPath, "global-settings", flush)
    void watchers.start().catch(() => {})
  }

  invalidateProject = (cwd: string): void => {
    if (this.closed) return
    this.invalidateResources(canonicalizePath(cwd))
  }

  private invalidateResources(cwd: string): void {
    for (const cache of this.projectCaches) cache.invalidateProject(cwd)
    this.invalidateHistory(cwd)
    deleteProjectSnapshots(this.caches.snapshots, cwd)
  }

  evictProject = (cwd: string): void => {
    const canonical = canonicalizePath(cwd)
    this.lifetimes.get(canonical)?.abort()
    this.lifetimes.delete(canonical)
    this.registeredProjects.delete(canonical)
    this.invalidateResources(canonical)
    this.caches.watchers.unregisterByLabelSuffix(`:${canonical}`)
    this.caches.upstreamSyncRegistry.unregister(canonical)
    this.caches.lifecycleTaskRegistry.clearProject(canonical)
  }

  registerProjectWatchers = (cwd: string): void => {
    const canonical = canonicalizePath(cwd)
    if (this.closed || this.registeredProjects.has(canonical)) return
    this.evictOldestProject()
    const lifetime = new AbortController()
    this.lifetimes.set(canonical, lifetime)
    this.registeredProjects.add(canonical)
    this.registerProjectPaths(canonical, lifetime.signal)
    void this.caches.upstreamSyncRegistry
      .register(canonical, lifetime.signal)
      .then((result) => {
        if (result.registered && !lifetime.signal.aborted) {
          return this.caches.upstreamSyncRegistry.syncNow(canonical)
        }
        return null
      })
      .catch(() => {})
    void this.caches.watchers.start().catch(() => {})
  }

  private evictOldestProject(): void {
    if (this.registeredProjects.size < MAX_WATCHED_PROJECTS) return
    let oldestCwd: string | undefined
    let oldestTime = Infinity
    for (const cwd of this.registeredProjects) {
      const lastSeen = this.lastSeenForProject(cwd)
      if (lastSeen < oldestTime) {
        oldestCwd = cwd
        oldestTime = lastSeen
      }
    }
    if (oldestCwd) {
      stderrLog("project eviction", `[daemon] Evicting project ${oldestCwd} to stay within limit`)
      this.evictProject(oldestCwd)
    }
  }

  private lastSeenForProject(cwd: string): number {
    let lastSeen = this.projectLastSeen.get(cwd) ?? 0
    for (const [candidate, seen] of this.projectLastSeen) {
      if (canonicalizePath(candidate) === cwd) lastSeen = Math.max(lastSeen, seen)
    }
    return lastSeen
  }

  private registerProjectPaths(cwd: string, signal: AbortSignal): void {
    const { watchers } = this.caches
    const projectFlush = () => {
      if (!signal.aborted) this.invalidateProject(cwd)
    }
    const projectSettings = getProjectSettingsPath(cwd)
    if (projectSettings) watchers.register(projectSettings, `project-settings:${cwd}`, projectFlush)
    // Git metadata deliberately bypasses generic source-watch exclusions (#807).
    watchers.register(join(cwd, ".git/"), `git:${cwd}`, projectFlush, { allowIgnoredPath: true })
    const transcriptFlush = () => {
      if (signal.aborted) return
      projectFlush()
      void this.transcriptMonitor.checkProject(cwd).catch((error) => {
        stderrLog("transcript-monitor", `Failed to check project ${cwd}: ${error}`)
      })
    }
    for (const path of this.transcriptWatchPaths(cwd)) {
      // Only the provider directory: the monitor owns targeted session-file reads.
      watchers.register(path.path, path.label, transcriptFlush, { depth: 0 })
    }
  }

  close = (): void => {
    if (this.closed) return
    this.closed = true
    for (const cwd of this.registeredProjects) this.evictProject(cwd)
    this.caches.watchers.close()
    this.caches.upstreamSyncRegistry.close()
  }
}

export function setupWatchers(
  caches: ProjectLifecycleCaches,
  transcriptMonitor: { checkProject(cwd: string): Promise<void> },
  projectLastSeen: ReadonlyMap<string, number>,
  options: ProjectLifecycleOptions = {}
): ProjectWatcherManager {
  return new ProjectLifecycle(caches, transcriptMonitor, projectLastSeen, options)
}

export function evictIdleProjects(
  now: number,
  state: {
    projectLastSeen: Map<string, number>
    projectMetrics: { delete(cwd: string): unknown }
  },
  registeredProjects: Set<string>,
  evictProject: (cwd: string) => void
): void {
  const cutoff = now - PROJECT_IDLE_EVICTION_MS
  for (const [cwd, lastSeen] of state.projectLastSeen) {
    if (lastSeen >= cutoff) continue
    state.projectLastSeen.delete(cwd)
    state.projectMetrics.delete(cwd)
    const canonical = canonicalizePath(cwd)
    if (registeredProjects.has(canonical)) evictProject(canonical)
  }
}
