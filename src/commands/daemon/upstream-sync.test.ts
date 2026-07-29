import { describe, expect, test } from "bun:test"
import { IssueStore, type UpstreamSyncResult } from "../../issue-store.ts"
import { UpstreamSyncRegistry } from "./upstream-sync.ts"

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
