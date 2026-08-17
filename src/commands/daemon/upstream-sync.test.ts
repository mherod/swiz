import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { IssueStore, type UpstreamSyncResult } from "../../issue-store.ts"
import { resolveUpstreamRepoSlug, UpstreamSyncRegistry } from "./upstream-sync.ts"

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function createSyncResult(): UpstreamSyncResult {
  const bucket = () => ({ upserted: 0, removed: 0, skipped: 0, changes: [] })
  const tracked = () => ({ upserted: 0, changes: [] })
  return {
    issues: bucket(),
    pullRequests: bucket(),
    ciStatuses: tracked(),
    comments: { upserted: 0 },
    labels: bucket(),
    milestones: bucket(),
    branchCi: tracked(),
    prBranchDetail: tracked(),
    branchProtection: tracked(),
    events: { inserted: 0, cursor: null },
    restCache: { requests: 0, notModified: 0, writes: 0 },
    fetchOk: true,
  }
}

describe("resolveUpstreamRepoSlug", () => {
  test("reuses repository capability decisions", async () => {
    const base = {
      canonicalRoot: "/repo",
      repoKey: "upstream-sync-test",
      resolvedAt: Date.now(),
    }

    expect(
      await resolveUpstreamRepoSlug("/repo", () =>
        Promise.resolve({ ...base, isRepo: false, repoSlug: null, hasGhCli: true })
      )
    ).toBeNull()
    expect(
      await resolveUpstreamRepoSlug("/repo", () =>
        Promise.resolve({ ...base, isRepo: true, repoSlug: "mherod/swiz", hasGhCli: false })
      )
    ).toBeNull()
    expect(
      await resolveUpstreamRepoSlug("/repo", () =>
        Promise.resolve({ ...base, isRepo: true, repoSlug: "mherod/swiz", hasGhCli: true })
      )
    ).toBe("mherod/swiz")
  })
})

describe("UpstreamSyncRegistry fork entries", () => {
  test("runs fork and upstream syncs independently while both are in flight", async () => {
    const releaseSyncs = deferred()
    const syncCalls: string[] = []
    const store = new IssueStore(":memory:")
    const registry = new UpstreamSyncRegistry({
      intervalMs: 5,
      timeoutMs: 1_000,
      resolveSlug: async () => "owner/fork",
      resolveFork: async () => ({ upstreamSlug: "org/upstream" }),
      sync: async (repo) => {
        syncCalls.push(repo)
        await releaseSyncs.promise
        return createSyncResult()
      },
      store,
    })

    try {
      await registry.register("/virtual/fork")
      await Bun.sleep(30)

      expect(syncCalls).toEqual(["owner/fork", "org/upstream"])
      expect(registry.listActive().filter((entry) => entry.syncing)).toHaveLength(2)
    } finally {
      registry.close()
      releaseSyncs.resolve()
      await Bun.sleep(0)
      store.close()
    }
  })

  test("unregister removes both fork and upstream entries", async () => {
    const store = new IssueStore(":memory:")
    const registry = new UpstreamSyncRegistry({
      intervalMs: 60_000,
      resolveSlug: async () => "owner/fork",
      resolveFork: async () => ({ upstreamSlug: "org/upstream" }),
      sync: async () => createSyncResult(),
      store,
    })

    try {
      await registry.register("/virtual/fork")
      expect(registry.listActive()).toHaveLength(2)

      expect(registry.unregister("/virtual/fork")).toBe(true)
      expect(registry.listActive()).toHaveLength(0)
    } finally {
      registry.close()
      store.close()
    }
  })
})

describe("UpstreamSyncRegistry lifecycle", () => {
  test("aborts timed-out sync, resets syncing, and permits next interval without overlap", async () => {
    let syncCalls = 0
    const observedSignals: AbortSignal[] = []
    const store = new IssueStore(":memory:")
    const registry = new UpstreamSyncRegistry({
      intervalMs: 30,
      timeoutMs: 15,
      resolveSlug: async () => "owner/repo",
      resolveFork: async () => null,
      sync: async (_repo, _cwd, opts) => {
        syncCalls++
        if (opts?.signal) observedSignals.push(opts.signal)
        if (syncCalls === 1) {
          // First call hangs until aborted
          await new Promise<void>((resolve) => {
            if (opts?.signal?.aborted) return resolve()
            opts?.signal?.addEventListener("abort", () => resolve(), { once: true })
          })
          return createSyncResult()
        }
        return createSyncResult()
      },
      store,
    })

    try {
      await registry.register("/virtual/repo")
      // Wait long enough for first sync to timeout and abort, and next interval to trigger
      await Bun.sleep(100)

      expect(syncCalls).toBeGreaterThanOrEqual(2)
      expect(observedSignals[0]?.aborted).toBe(true)
      // Once settled, syncing is false
      expect(registry.listActive()[0]?.syncing).toBe(false)
    } finally {
      registry.close()
      store.close()
    }
  })

  test("aborts in-flight computation when project is unregistered", async () => {
    let capturedSignal: AbortSignal | null = null
    const syncStarted = deferred()
    const store = new IssueStore(":memory:")
    const registry = new UpstreamSyncRegistry({
      intervalMs: 5,
      timeoutMs: 10_000,
      resolveSlug: async () => "owner/repo",
      resolveFork: async () => null,
      sync: async (_repo, _cwd, opts) => {
        capturedSignal = opts?.signal ?? null
        syncStarted.resolve()
        await new Promise<void>((resolve) => {
          if (opts?.signal?.aborted) return resolve()
          opts?.signal?.addEventListener("abort", () => resolve(), { once: true })
        })
        return createSyncResult()
      },
      store,
    })

    try {
      await registry.register("/virtual/repo")
      await syncStarted.promise

      expect(capturedSignal).not.toBeNull()
      expect(capturedSignal!.aborted).toBe(false)

      expect(registry.unregister("/virtual/repo")).toBe(true)
      expect(capturedSignal!.aborted).toBe(true)
      expect(registry.listActive()).toHaveLength(0)
    } finally {
      registry.close()
      store.close()
    }
  })

  test("aborts all in-flight computations when registry closes", async () => {
    const capturedSignals: AbortSignal[] = []
    const syncsStarted = deferred()
    let startedCount = 0
    const store = new IssueStore(":memory:")
    const registry = new UpstreamSyncRegistry({
      intervalMs: 5,
      timeoutMs: 10_000,
      resolveSlug: async () => "owner/fork",
      resolveFork: async () => ({ upstreamSlug: "org/upstream" }),
      sync: async (_repo, _cwd, opts) => {
        if (opts?.signal) capturedSignals.push(opts.signal)
        startedCount++
        if (startedCount === 2) syncsStarted.resolve()
        await new Promise<void>((resolve) => {
          if (opts?.signal?.aborted) return resolve()
          opts?.signal?.addEventListener("abort", () => resolve(), { once: true })
        })
        return createSyncResult()
      },
      store,
    })

    try {
      await registry.register("/virtual/fork")
      await syncsStarted.promise

      expect(capturedSignals).toHaveLength(2)
      expect(capturedSignals.every((s) => !s.aborted)).toBe(true)

      registry.close()
      expect(capturedSignals.every((s) => s.aborted)).toBe(true)
      expect(registry.listActive()).toHaveLength(0)
    } finally {
      registry.close()
      store.close()
    }
  })

  test("prunes a stored cwd cursor when startup registration fails", async () => {
    const store = new IssueStore(":memory:")
    store.setSyncCursor("owner/deleted", "cwd", "/deleted/repo")
    const registry = new UpstreamSyncRegistry({
      intervalMs: 60_000,
      resolveSlug: async () => null,
      resolveFork: async () => null,
      store,
    })

    try {
      await registry.restoreKnownRepos()

      expect(store.getSyncCursor("owner/deleted", "cwd")).toBeNull()
      expect(registry.listActive()).toHaveLength(0)
    } finally {
      registry.close()
      store.close()
    }
  })
})

/**
 * A real on-disk project so realpath, the `.git` walk, and symlink aliasing are
 * exercised for real rather than mocked. `mkdtemp` lands under a symlinked
 * `/var` on macOS, so the fixture root is itself an alias — assertions compare
 * against what the registry reports, never a hardcoded path.
 */
async function createProjectFixture(): Promise<{
  root: string
  nested: string
  alias: string
  sibling: string
  cleanup: () => Promise<void>
}> {
  const base = await mkdtemp(join(tmpdir(), "swiz-project-identity-"))
  const root = join(base, "repo")
  const sibling = `${root}-backup`
  const alias = join(base, "alias")
  await mkdir(join(root, ".git"), { recursive: true })
  await mkdir(join(root, "src", "nested"), { recursive: true })
  await mkdir(join(sibling, ".git"), { recursive: true })
  await symlink(root, alias)
  return {
    root,
    nested: join(root, "src", "nested"),
    alias,
    sibling,
    cleanup: () => rm(base, { recursive: true, force: true }),
  }
}

function createRegistry(store: IssueStore): UpstreamSyncRegistry {
  return new UpstreamSyncRegistry({
    intervalMs: 60_000,
    resolveSlug: async () => "owner/repo",
    resolveFork: async () => null,
    sync: async () => createSyncResult(),
    store,
  })
}

describe("UpstreamSyncRegistry project identity", () => {
  test("collapses trailing-slash, subdirectory, and symlink cwds onto one entry", async () => {
    const fixture = await createProjectFixture()
    const store = new IssueStore(":memory:")
    const registry = createRegistry(store)

    try {
      expect((await registry.register(fixture.root)).deduped).toBe(false)
      expect((await registry.register(`${fixture.root}/`)).deduped).toBe(true)
      expect((await registry.register(fixture.nested)).deduped).toBe(true)
      expect((await registry.register(fixture.alias)).deduped).toBe(true)
      expect(registry.listActive()).toHaveLength(1)
    } finally {
      registry.close()
      store.close()
      await fixture.cleanup()
    }
  })

  test("dedupes legacy cwd variants restored concurrently on startup", async () => {
    // restoreKnownRepos() replays every stored cursor through Promise.all, so
    // variants of one root arrive concurrently and must not each win a loop.
    const fixture = await createProjectFixture()
    const store = new IssueStore(":memory:")
    const registry = createRegistry(store)

    try {
      const results = await Promise.all([
        registry.register(fixture.root),
        registry.register(`${fixture.root}/`),
        registry.register(fixture.nested),
        registry.register(fixture.alias),
      ])

      expect(registry.listActive()).toHaveLength(1)
      expect(results.filter((result) => !result.deduped)).toHaveLength(1)
    } finally {
      registry.close()
      store.close()
      await fixture.cleanup()
    }
  })

  test("resolves sync status from any cwd inside the project", async () => {
    const fixture = await createProjectFixture()
    const store = new IssueStore(":memory:")
    const registry = createRegistry(store)

    try {
      await registry.register(fixture.root)

      expect(registry.findActiveForCwd(fixture.nested)?.repo).toBe("owner/repo")
      expect(registry.findActiveForCwd(`${fixture.root}/`)?.repo).toBe("owner/repo")
      expect(registry.findActiveForCwd(fixture.alias)?.repo).toBe("owner/repo")
    } finally {
      registry.close()
      store.close()
      await fixture.cleanup()
    }
  })

  test("does not match a sibling project sharing a path prefix", async () => {
    // `<root>-backup` starts with `<root>` as a string but is its own project.
    const fixture = await createProjectFixture()
    const store = new IssueStore(":memory:")
    const registry = createRegistry(store)

    try {
      await registry.register(fixture.root)

      expect(registry.findActiveForCwd(fixture.sibling)).toBeNull()
      expect(registry.unregister(fixture.sibling)).toBe(false)
      expect(registry.listActive()).toHaveLength(1)
    } finally {
      registry.close()
      store.close()
      await fixture.cleanup()
    }
  })

  test("unregisters from a subdirectory cwd", async () => {
    const fixture = await createProjectFixture()
    const store = new IssueStore(":memory:")
    const registry = createRegistry(store)

    try {
      await registry.register(fixture.root)

      expect(registry.unregister(fixture.nested)).toBe(true)
      expect(registry.listActive()).toHaveLength(0)
    } finally {
      registry.close()
      store.close()
      await fixture.cleanup()
    }
  })
})
