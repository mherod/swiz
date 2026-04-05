/**
 * Type definitions for stop-lockfile-drift validator.
 *
 * Domain concepts:
 * - LockfileInfo: metadata about detected lockfile (path, install command)
 * - DriftValidationResult: outcome of drift detection
 * - LockfileDriftContext: shared context for validation
 */

export interface LockfileInfo {
  lockfile: string
  installCmd: string
}

export interface DriftedPackage {
  pkgFile: string
  lockfile: string
  installCmd: string
}

export interface DriftValidationResult {
  kind: "ok" | "drift-detected"
  driftedPackages?: DriftedPackage[]
}

export interface LockfileDriftContext {
  cwd: string
  sessionId: string | null
  range: string
  changedFiles: Set<string>
}
