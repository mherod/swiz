import { getRepoSlug, isGitRepo } from "./git-helpers.ts"
import {
  type ProjectIdentityResolution,
  resolveProjectIdentityResolution,
} from "./project-identity.ts"

/**
 * Swiz-verified repository facts shared by dispatch and hook consumers.
 *
 * This value is internal enrichment. Agent-provided payload fields with the
 * same name must always be overwritten before hook execution.
 */
export interface RepositoryCapability extends ProjectIdentityResolution {
  /** GitHub `owner/repo` for the origin remote, or null when unavailable. */
  repoSlug: string | null
}

export type RepoSlugResolver = (cwd: string) => Promise<string | null>
export type GitRepoResolver = (cwd: string) => Promise<boolean>

function isRepositoryCapability(
  value: Partial<RepositoryCapability> | null | undefined
): value is RepositoryCapability {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const capability = value as Partial<RepositoryCapability>
  return (
    typeof capability.canonicalRoot === "string" &&
    typeof capability.repoKey === "string" &&
    typeof capability.isGitRepo === "boolean" &&
    (typeof capability.repoSlug === "string" || capability.repoSlug === null)
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
  const capability = Reflect.get(input, "_repositoryCapability") as
    | Partial<RepositoryCapability>
    | null
    | undefined
  if (isRepositoryCapability(capability)) return capability.isGitRepo
  return await resolveFallback(cwd)
}

/** Build a capability from an already-resolved project identity. */
export async function resolveRepositoryCapabilityFromIdentity(
  identity: ProjectIdentityResolution,
  resolveSlug: RepoSlugResolver = getRepoSlug
): Promise<RepositoryCapability> {
  let repoSlug: string | null = null
  if (identity.isGitRepo) {
    try {
      repoSlug = await resolveSlug(identity.canonicalRoot)
    } catch {
      // Repository membership is still authoritative when the origin remote
      // cannot be queried. Replay simply has no slug to act on.
    }
  }
  return { ...identity, repoSlug }
}

/** Resolve canonical identity, repository membership, and origin slug once. */
export async function resolveRepositoryCapability(
  cwd: string,
  resolveSlug: RepoSlugResolver = getRepoSlug
): Promise<RepositoryCapability> {
  const identity = await resolveProjectIdentityResolution(cwd)
  return resolveRepositoryCapabilityFromIdentity(identity, resolveSlug)
}
