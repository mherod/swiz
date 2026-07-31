import { getRepoSlug } from "./git-helpers.ts"
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
