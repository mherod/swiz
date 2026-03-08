/**
 * Shared helpers for resolving working directories.
 *
 * Keep cwd fallback/normalization rules centralized so callers do not
 * re-implement `cwd ?? process.cwd()` or `cwd.trim() || process.cwd()`.
 *
 * Usage:
 * `const dir = resolveCwd(input.cwd)`
 * `const spawnCwd = resolveSpawnCwd(cwdFromCliFlag)`
 */

/** Resolve optional cwd to a concrete directory path. */
export function resolveCwd(cwd?: string | null): string {
  return cwd ?? process.cwd()
}

/** Normalize spawn cwd inputs; empty/whitespace falls back to process cwd. */
export function resolveSpawnCwd(cwd: string): string {
  const trimmed = cwd.trim()
  return trimmed || process.cwd()
}
