/** Resolve the effective home directory used by swiz path helpers. */
export function getHomeDir(): string {
  return process.env.HOME ?? "~"
}

/** Expand literal `$HOME` tokens in command strings. */
export function expandHomeVars(value: string, homeDir: string = getHomeDir()): string {
  return value.replace(/\$HOME/g, homeDir)
}
