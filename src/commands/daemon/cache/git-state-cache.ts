import { type GitBranchStatus, getGitBranchStatus } from "../../../git-helpers.ts"

export interface CachedGitState {
  status: GitBranchStatus
  cachedAt: number
}

export class GitStateCache {
  private entries = new Map<string, CachedGitState>()
  private inFlight = new Map<string, Promise<CachedGitState | null>>()

  async get(cwd: string): Promise<CachedGitState | null> {
    const cached = this.entries.get(cwd)
    if (cached) return cached
    const inflight = this.inFlight.get(cwd)
    if (inflight) return inflight
    const computation = getGitBranchStatus(cwd).then((status) => {
      this.inFlight.delete(cwd)
      if (!status) return null
      const entry: CachedGitState = { status, cachedAt: Date.now() }
      this.entries.set(cwd, entry)
      return entry
    })
    this.inFlight.set(cwd, computation)
    return computation
  }

  invalidateProject(cwd: string): void {
    this.entries.delete(cwd)
  }

  invalidateAll(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}
