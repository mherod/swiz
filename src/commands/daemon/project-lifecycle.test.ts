import { describe, expect, test } from "bun:test"
import {
  evictIdleProjects,
  PROJECT_IDLE_EVICTION_MS,
  type ProjectLifecycleCaches,
  setupWatchers,
  snapshotCacheKey,
} from "./project-lifecycle.ts"

function fixture() {
  const invalidations: string[] = []
  const callbacks = new Map<string, () => void>()
  const registrations: Array<{ cwd: string; signal?: AbortSignal }> = []
  const unregisters: string[] = []
  const syncs: string[] = []
  const checks: string[] = []
  const taskClears: string[] = []
  const closes: string[] = []
  const snapshots = new Map<string, boolean>()
  const projectLastSeen = new Map<string, number>()
  const projectMetrics = new Map<string, boolean>()
  const cache = (name: string) => ({
    invalidateProject: (cwd: string) => {
      invalidations.push(`${name}:${cwd}`)
    },
    invalidateAll: () => {
      invalidations.push(`${name}:all`)
    },
  })
  const caches: ProjectLifecycleCaches = {
    ghCache: cache("gh"),
    eligibilityCache: cache("eligibility"),
    gitStateCache: cache("git"),
    repositoryCapabilityCache: cache("capability"),
    projectSettingsCache: cache("settings"),
    manifestCache: cache("manifest"),
    transcriptIndex: cache("transcript"),
    cooldownRegistry: cache("cooldown"),
    lifecycleTaskRegistry: {
      clearProject: (cwd) => {
        taskClears.push(cwd)
      },
    },
    snapshots,
    watchers: {
      register: (_path, label, callback) => {
        callbacks.set(label, callback)
      },
      start: async () => {},
      unregisterByLabelSuffix: (suffix) => {
        for (const label of callbacks.keys()) if (label.endsWith(suffix)) callbacks.delete(label)
        return 0
      },
      close: () => {
        closes.push("watchers")
      },
    },
    upstreamSyncRegistry: {
      register: async (cwd, signal) => {
        registrations.push({ cwd, signal })
        return { deduped: false, registered: true }
      },
      syncNow: async (cwd) => {
        syncs.push(cwd)
        return null
      },
      unregister: (cwd) => {
        unregisters.push(cwd)
        return true
      },
      close: () => {
        closes.push("upstream")
      },
    },
  }
  const manager = setupWatchers(
    caches,
    {
      checkProject: async (cwd) => {
        checks.push(cwd)
      },
    },
    projectLastSeen,
    {
      invalidateHistory: (cwd) => {
        invalidations.push(`history:${cwd}`)
      },
      transcriptWatchPaths: (cwd) => [{ path: `${cwd}/transcripts`, label: `transcripts:${cwd}` }],
    }
  )
  return {
    manager,
    caches,
    callbacks,
    invalidations,
    registrations,
    unregisters,
    syncs,
    checks,
    taskClears,
    closes,
    snapshots,
    projectLastSeen,
    projectMetrics,
  }
}

describe("project lifetime", () => {
  test("invalidation retains activation and clears only the project's reconstructible state", async () => {
    const f = fixture()
    try {
      f.manager.registerProjectWatchers("/project-a")
      f.manager.registerProjectWatchers("/project-b")
      await Promise.resolve()
      f.snapshots.set(snapshotCacheKey("/project-a", "one"), true)
      f.snapshots.set(snapshotCacheKey("/project-b", "two"), true)
      f.manager.invalidateProject("/project-a")
      expect(f.invalidations).toHaveLength(9)
      expect(f.invalidations.every((value) => value.endsWith(":/project-a"))).toBe(true)
      expect([...f.snapshots.keys()]).toEqual([snapshotCacheKey("/project-b", "two")])
      expect([...f.manager.registeredProjects]).toEqual(["/project-a", "/project-b"])
      expect(f.unregisters).toEqual([])
      expect(f.taskClears).toEqual([])
      expect(f.registrations.every((entry) => !entry.signal?.aborted)).toBe(true)
    } finally {
      f.manager.close()
    }
  })

  test("capacity eviction cancels the oldest lifetime and suppresses its late callbacks", async () => {
    const f = fixture()
    try {
      f.projectLastSeen.set("/project-a", 1)
      f.projectLastSeen.set("/project-b", 2)
      f.manager.registerProjectWatchers("/project-a")
      const staleTranscriptCallback = f.callbacks.get("transcripts:/project-a")!
      f.manager.registerProjectWatchers("/project-b")
      f.manager.registerProjectWatchers("/project-c")
      const count = f.invalidations.length
      staleTranscriptCallback()
      await Promise.resolve()
      expect([...f.manager.registeredProjects]).toEqual(["/project-b", "/project-c"])
      expect(f.registrations[0]?.signal?.aborted).toBe(true)
      expect(f.unregisters).toEqual(["/project-a"])
      expect(f.taskClears).toEqual(["/project-a"])
      expect(f.invalidations).toHaveLength(count)
      expect(f.checks).toEqual([])
      expect(f.syncs).toEqual(["/project-b", "/project-c"])
    } finally {
      f.manager.close()
    }
  })

  test("idle eviction uses the same resource cleanup and permits reactivation", async () => {
    const f = fixture()
    try {
      f.projectLastSeen.set("/project-a", 0)
      f.projectLastSeen.set("/project-b", PROJECT_IDLE_EVICTION_MS + 1)
      f.projectMetrics.set("/project-a", true)
      f.projectMetrics.set("/project-b", true)
      f.manager.registerProjectWatchers("/project-a")
      f.manager.registerProjectWatchers("/project-b")
      evictIdleProjects(
        PROJECT_IDLE_EVICTION_MS + 1,
        f,
        f.manager.registeredProjects,
        f.manager.evictProject
      )
      expect(f.unregisters).toEqual(["/project-a"])
      expect(f.taskClears).toEqual(["/project-a"])
      expect([...f.projectMetrics.keys()]).toEqual(["/project-b"])
      expect(f.invalidations).toHaveLength(9)
      f.manager.registerProjectWatchers("/project-a/")
      await Promise.resolve()
      expect(f.registrations.map((entry) => entry.cwd)).toEqual([
        "/project-a",
        "/project-b",
        "/project-a",
      ])
      expect(f.registrations[2]?.signal?.aborted).toBe(false)
      expect(f.syncs).toEqual(["/project-b", "/project-a"])
    } finally {
      f.manager.close()
    }
  })

  test("close is idempotent and prevents queued activation or watcher work", async () => {
    const f = fixture()
    f.manager.registerProjectWatchers("/project-a")
    const staleGitCallback = f.callbacks.get("git:/project-a")!
    const staleGlobalCallback = f.callbacks.get("manifest")!
    f.manager.close()
    const count = f.invalidations.length
    f.manager.close()
    staleGitCallback()
    staleGlobalCallback()
    f.manager.registerProjectWatchers("/project-b")
    await Promise.resolve()
    expect(f.manager.registeredProjects.size).toBe(0)
    expect(f.invalidations).toHaveLength(count)
    expect(f.registrations).toHaveLength(1)
    expect(f.syncs).toEqual([])
    expect(f.closes).toEqual(["watchers", "upstream"])
  })
})
