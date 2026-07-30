import { realpathSync } from "node:fs"
import { getCanonicalPathHash, resolveGitPaths } from "./git-helpers.ts"

/**
 * Canonical identity for a project directory.
 *
 * Every daemon boundary that keys state on "a project" — sync registries,
 * staleness lookups, per-project caches — has to agree on what counts as the
 * same project. Keying on the raw cwd string does not: `/path`, `/path/`, a
 * symlink alias, and `/path/subdir` are four different keys for one repo, so
 * registries accumulate duplicate entries and exact-match lookups silently
 * miss (#717). Resolve identity once at the boundary, then key on
 * `canonicalRoot`.
 */
export interface ProjectIdentity {
  /** Absolute, symlink-resolved repository root — or the resolved cwd when not in a repo. */
  canonicalRoot: string
  /** Stable hash of `canonicalRoot`; matches the repo keys hook cooldown sentinels write. */
  repoKey: string
}

function stripTrailingSlashes(path: string): string {
  if (path.length <= 1) return path
  const trimmed = path.replace(/\/+$/, "")
  return trimmed === "" ? "/" : trimmed
}

/**
 * Resolve a path to its symlink-free, trailing-slash-free form.
 *
 * Falls back to the trimmed input when the path does not exist on disk, so
 * virtual paths used by tests still normalise consistently instead of throwing.
 */
export function canonicalizePath(path: string): string {
  const trimmed = stripTrailingSlashes(path)
  try {
    return stripTrailingSlashes(realpathSync(trimmed))
  } catch {
    return trimmed
  }
}

/**
 * True when `path` is `root` itself or sits inside it.
 *
 * Compares on path segments rather than a bare `startsWith`: `/repo-backup`
 * starts with `/repo` as a string but is a different project. Symlink
 * resolution is the caller's job — pass values from `canonicalizePath` when the
 * inputs may be aliases.
 */
export function isPathWithinRoot(path: string, root: string): boolean {
  const target = stripTrailingSlashes(path)
  const base = stripTrailingSlashes(root)
  if (target === base) return true
  return target.startsWith(base === "/" ? "/" : `${base}/`)
}

/**
 * Resolve `cwd` to the canonical root of the repository containing it.
 *
 * Uses `resolveGitPaths` — which walks up to `.git` — instead of spawning
 * `git rev-parse --show-toplevel`, so this stays cheap enough to call on daemon
 * route entry. Returns the canonicalised cwd when it is not inside a repo.
 */
export async function resolveProjectRoot(cwd: string): Promise<string> {
  const canonical = canonicalizePath(cwd)
  const gitPaths = await resolveGitPaths(canonical)
  return gitPaths ? canonicalizePath(gitPaths.workTree) : canonical
}

/** Resolve `cwd` to its canonical root and stable repo key in one pass. */
export async function resolveProjectIdentity(cwd: string): Promise<ProjectIdentity> {
  const canonicalRoot = await resolveProjectRoot(cwd)
  return { canonicalRoot, repoKey: getCanonicalPathHash(canonicalRoot) }
}
