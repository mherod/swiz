import { type GitBranchStatus, getGitBranchStatus } from "../../../git-helpers.ts"
import { KeyedAsyncCache } from "../../../utils/keyed-async-cache.ts"

export interface CachedGitState {
  status: GitBranchStatus
  cachedAt: number
}

/**
 * Per-project git branch status, cached until explicitly invalidated.
 *
 * Entries never expire on their own — the daemon invalidates on the events that
 * can change branch state — so no TTL is configured here.
 */
export class GitStateCache {
  private readonly cache = new KeyedAsyncCache<CachedGitState | null>()

  get(cwd: string): Promise<CachedGitState | null> {
    return this.cache.get(cwd, async (dir) => {
      const status = await getGitBranchStatus(dir)
      return status ? { status, cachedAt: Date.now() } : null
    })
  }

  invalidateProject(cwd: string): void {
    this.cache.invalidate(cwd)
  }

  invalidateAll(): void {
    this.cache.invalidateAll()
  }

  get size(): number {
    return this.cache.size
  }
}
