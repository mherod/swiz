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

/**
 * Redact the absolute home directory prefix to `~` for display in agent-visible
 * text. Only matches the home path at a token boundary (followed by `/`, end of
 * string, or a non-word char) so siblings like `/Users/bob2` are left intact.
 * No-op when HOME is unset, `~`, or `/`.
 */
export function tildifyHome(value: string, homeDir: string = getHomeDir()): string {
  if (!value || !homeDir || homeDir === "~" || homeDir === "/") return value
  if (!value.includes(homeDir)) return value
  const escaped = homeDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return value.replace(new RegExp(`${escaped}(?=/|$|[^\\w])`, "g"), "~")
}
