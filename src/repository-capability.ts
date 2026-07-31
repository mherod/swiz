/**
 * One verified answer to "what kind of project is this cwd?", shared across a
 * dispatch instead of re-derived at every boundary.
 *
 * A daemon-backed dispatch used to probe the repository up to four times for a
 * single hook event: the CLI non-git fast path, the CLI's pre-command replay,
 * the core dispatch short-circuit, and the replay inside `prepareDispatchGroups`
 * each ran their own `git rev-parse`. One probe measured 6.2 ms p50 and ten
 * concurrent identical probes measured 47.2 ms p50, all of it fixed work on the
 * pre-hook path (#752).
 *
 * Resolve once, key on {@link ProjectIdentity.canonicalRoot} so path aliases and
 * subdirectories collapse to one entry, and reuse.
 *
 * Deliberately excluded: pending-mutation counts. Those change whenever a
 * command queues offline work, and caching them would let a freshly queued
 * mutation go unreplayed for the TTL window. The count stays a live read against
 * the issue store — it is a local query, not a subprocess.
 */

import { getRepoSlug, hasGhCli, isGitRepo } from "./git-helpers.ts"
import { type ProjectIdentityResolution, resolveProjectIdentity } from "./project-identity.ts"
import { KeyedAsyncCache } from "./utils/keyed-async-cache.ts"

/**
 * Short by design. Repository identity rarely changes mid-session, but a TTL
 * bounds how long dispatch can believe a stale answer after `git init`, a clone,
 * a remote change, or a `gh` install — the cases where a wrong cached value
 * would otherwise persist for the daemon's whole lifetime.
 */
export const REPOSITORY_CAPABILITY_TTL_MS = 5_000

/**
 * Swiz-authored repository facts for one project root.
 *
 * Only ever produced by {@link resolveRepositoryCapability}. Values arriving on
 * an inbound agent payload are stripped during normalization — an agent could
 * otherwise claim `isRepo: false` and skip every hook.
 */
export interface RepositoryCapability {
  /** Absolute, symlink-resolved repository root, or the resolved cwd outside a repo. */
  canonicalRoot: string
  /** Stable hash of `canonicalRoot`; matches the repo keys hook cooldown sentinels write. */
  repoKey: string
  /** True when `canonicalRoot` is inside a git repository. */
  isRepo: boolean
  /** `owner/repo` from the origin remote, or null outside a repo / without a GitHub origin. */
  repoSlug: string | null
  /** True when the `gh` CLI is on PATH. */
  hasGhCli: boolean
  /** Epoch ms this capability was resolved. */
  resolvedAt: number
}

/** Injectable probes so tests can count subprocess calls without spawning git. */
export interface RepositoryCapabilityProbes {
  isGitRepo: (dir: string) => Promise<boolean>
  getRepoSlug: (dir: string) => Promise<string | null>
  hasGhCli: () => boolean
}

export type GitRepoResolver = (cwd: string) => Promise<boolean>
export type RepoSlugResolver = (cwd: string) => Promise<string | null>

const DEFAULT_PROBES: RepositoryCapabilityProbes = { isGitRepo, getRepoSlug, hasGhCli }

function isRepositoryCapability(value: unknown): value is RepositoryCapability {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return (
    typeof Reflect.get(value, "canonicalRoot") === "string" &&
    typeof Reflect.get(value, "repoKey") === "string" &&
    typeof Reflect.get(value, "isRepo") === "boolean" &&
    (typeof Reflect.get(value, "repoSlug") === "string" ||
      Reflect.get(value, "repoSlug") === null) &&
    typeof Reflect.get(value, "hasGhCli") === "boolean" &&
    Number.isFinite(Reflect.get(value, "resolvedAt"))
  )
}

/**
 * Reuse dispatcher-verified repository membership when present, otherwise
 * resolve it through the canonical Git boundary used by standalone hooks.
 */
export async function isGitRepoForHookPayload(
  input: object,
  cwd: string,
  resolveFallback: GitRepoResolver = isGitRepo
): Promise<boolean> {
  const capability = Reflect.get(input, "_repositoryCapability")
  if (isRepositoryCapability(capability)) return capability.isRepo
  return await resolveFallback(cwd)
}

/** Build a capability from an identity already resolved by the daemon cache. */
export async function resolveRepositoryCapabilityFromIdentity(
  identity: ProjectIdentityResolution,
  resolveSlug: RepoSlugResolver = getRepoSlug
): Promise<RepositoryCapability> {
  let repoSlug: string | null = null
  if (identity.isGitRepo) {
    try {
      repoSlug = await resolveSlug(identity.canonicalRoot)
    } catch {
      // Repository membership remains authoritative when origin lookup fails.
    }
  }

  return {
    canonicalRoot: identity.canonicalRoot,
    repoKey: identity.repoKey,
    isRepo: identity.isGitRepo,
    repoSlug,
    hasGhCli: hasGhCli(),
    resolvedAt: Date.now(),
  }
}

let capabilityCache = new KeyedAsyncCache<RepositoryCapability>({
  ttlMs: REPOSITORY_CAPABILITY_TTL_MS,
})

async function computeRepositoryCapability(
  cwd: string,
  probes: RepositoryCapabilityProbes
): Promise<RepositoryCapability> {
  // Filesystem-only: walks up to `.git` rather than spawning `rev-parse`.
  const identity = await resolveProjectIdentity(cwd)

  // The single repository subprocess. `isGitRepo` stays the authority rather
  // than inferring repo-ness from the identity walk, so fail-open behaviour for
  // bare repos, worktrees, and GIT_DIR overrides is unchanged.
  const isRepo = await probes.isGitRepo(identity.canonicalRoot)

  // `hasGhCli` is a PATH lookup, not a subprocess. Slug resolution is memoised
  // per-cwd inside git-helpers, and is pointless outside a repo.
  const ghAvailable = probes.hasGhCli()
  const repoSlug = isRepo ? await probes.getRepoSlug(identity.canonicalRoot) : null

  return {
    canonicalRoot: identity.canonicalRoot,
    repoKey: identity.repoKey,
    isRepo,
    repoSlug,
    hasGhCli: ghAvailable,
    resolvedAt: Date.now(),
  }
}

export interface ResolveRepositoryCapabilityOptions {
  /** Test seam. Production callers omit this. */
  probes?: RepositoryCapabilityProbes
  /** Bypass the cache and force a fresh probe. */
  forceRefresh?: boolean
}

/**
 * Resolve — or reuse — the repository capability for `cwd`.
 *
 * Concurrent callers for the same project share one computation. Never throws:
 * a probe failure degrades to a non-repo capability so dispatch keeps its
 * existing fail-open behaviour instead of erroring the hook event.
 */
export async function resolveRepositoryCapability(
  cwd: string,
  options: ResolveRepositoryCapabilityOptions = {}
): Promise<RepositoryCapability> {
  const probes = options.probes ?? DEFAULT_PROBES
  // Key on the raw cwd: canonicalisation itself costs a filesystem walk, and
  // callers within one dispatch pass an identical cwd string.
  if (options.forceRefresh) capabilityCache.invalidate(cwd)
  try {
    return await capabilityCache.get(cwd, (dir) => computeRepositoryCapability(dir, probes))
  } catch {
    return {
      canonicalRoot: cwd,
      repoKey: "",
      isRepo: false,
      repoSlug: null,
      hasGhCli: false,
      resolvedAt: Date.now(),
    }
  }
}

/** Drop every cached capability. Used by daemon cache invalidation and tests. */
export function invalidateRepositoryCapabilities(): void {
  capabilityCache.invalidateAll()
}

/** Replace the cache instance so tests get full isolation, including TTL clock state. */
export function resetRepositoryCapabilityCacheForTests(
  options: { ttlMs?: number; now?: () => number } = {}
): void {
  capabilityCache = new KeyedAsyncCache<RepositoryCapability>({
    ttlMs: options.ttlMs ?? REPOSITORY_CAPABILITY_TTL_MS,
    now: options.now,
  })
}
