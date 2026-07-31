import {
  canonicalizePath,
  isPathWithinRoot,
  type ProjectIdentityResolution,
  resolveProjectIdentityResolution,
} from "../../../project-identity.ts"
import {
  type RepositoryCapability,
  resolveRepositoryCapabilityFromIdentity,
} from "../../../repository-capability.ts"
import { CappedMap } from "./capped-map.ts"

export const REPOSITORY_CAPABILITY_TTL_MS = 5_000
const DEFAULT_MAX_ENTRIES = 200

interface CachedRepositoryCapability {
  capability: RepositoryCapability
  cachedAt: number
}

export interface RepositoryCapabilityCacheOptions {
  ttlMs?: number
  maxEntries?: number
  now?: () => number
  resolveIdentity?: (cwd: string) => Promise<ProjectIdentityResolution>
  resolveCapability?: (identity: ProjectIdentityResolution) => Promise<RepositoryCapability>
}

/** Bounded short-TTL daemon cache with per-project in-flight coalescing. */
export class RepositoryCapabilityCache {
  private readonly entries: CappedMap<string, CachedRepositoryCapability>
  private readonly inFlight = new Map<string, Promise<RepositoryCapability>>()
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly resolveIdentity: (cwd: string) => Promise<ProjectIdentityResolution>
  private readonly resolveCapability: (
    identity: ProjectIdentityResolution
  ) => Promise<RepositoryCapability>

  constructor(options: RepositoryCapabilityCacheOptions = {}) {
    this.entries = new CappedMap(options.maxEntries ?? DEFAULT_MAX_ENTRIES)
    this.ttlMs = options.ttlMs ?? REPOSITORY_CAPABILITY_TTL_MS
    this.now = options.now ?? Date.now
    this.resolveIdentity = options.resolveIdentity ?? resolveProjectIdentityResolution
    this.resolveCapability = options.resolveCapability ?? resolveRepositoryCapabilityFromIdentity
  }

  async get(cwd: string): Promise<RepositoryCapability> {
    const identity = await this.resolveIdentity(cwd)
    const key = identity.repoKey
    const cached = this.entries.get(key)
    if (cached && this.now() - cached.cachedAt < this.ttlMs) {
      return cached.capability
    }
    if (cached) this.entries.delete(key)

    const existing = this.inFlight.get(key)
    if (existing) return existing

    const computation = this.resolveCapability(identity)
      .then((capability) => {
        this.entries.set(key, { capability, cachedAt: this.now() })
        return capability
      })
      .finally(() => {
        this.inFlight.delete(key)
      })
    this.inFlight.set(key, computation)
    return computation
  }

  invalidateProject(cwd: string): void {
    const canonical = canonicalizePath(cwd)
    for (const [key, entry] of this.entries) {
      const root = entry.capability.canonicalRoot
      if (isPathWithinRoot(canonical, root) || isPathWithinRoot(root, canonical)) {
        this.entries.delete(key)
      }
    }
  }

  invalidateAll(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}
