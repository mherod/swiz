/**
 * Shared helpers for resolving working directories.
 *
 * Keep cwd fallback/normalisation rules centralised so callers do not
 * re-implement `cwd ?? process.cwd()` or `cwd.trim() || process.cwd()`.
 *
 * Usage:
 * `const dir = resolveCwd(input.cwd)`
 * `const spawnCwd = resolveSpawnCwd(cwdFromCliFlag)`
 */

/** Extract cwd from a value that may be a string or an object with a cwd property. */
function extractCwdRaw(value: string | object | null | undefined): string | null {
  if (value == null) return null
  if (typeof value === "string") return value
  if ("cwd" in value && typeof value.cwd === "string") return value.cwd
  throw new Error("Invalid cwd input: expected string or object with cwd property.")
}

/** Normalise spawn cwd inputs; empty/whitespace falls back to process cwd. */
export function resolveSpawnCwd(cwd?: string | object | null): string {
  const raw = extractCwdRaw(cwd)
  if (!raw) return process.cwd()
  const trimmed = raw.trim()
  return trimmed || process.cwd()
}
