/** Resolve the effective home directory used by swiz path helpers. */
export function getHomeDir(): string {
  return process.env.HOME ?? "~"
}

/** Resolve HOME or return null when unset. */
export function getHomeDirOrNull(): string | null {
  return process.env.HOME ?? null
}

/**
 * Resolve HOME with an explicit fallback for call sites that require one.
 *
 * Usage examples:
 * - `getHomeDirWithFallback("")` for optional path roots
 * - `getHomeDirWithFallback("/tmp")` for writable fallback storage
 */
export function getHomeDirWithFallback(fallback: string): string {
  return process.env.HOME ?? fallback
}

/** Expand literal `$HOME` tokens in command strings. */
export function expandHomeVars(value: string, homeDir: string = getHomeDir()): string {
  return value.replace(/\$HOME/g, homeDir)
}
