/**
 * Action Plan Generation Module
 *
 * Formats drift validation results into blocking reason and action steps.
 */

import type { DriftValidationResult } from "./types.ts"

/**
 * Format blocking reason from drift validation result.
 */
export function formatDriftBlockReason(result: DriftValidationResult): string | null {
  if (result.kind === "ok") {
    return null
  }

  if (!result.driftedPackages || result.driftedPackages.length === 0) {
    return null
  }

  let reason = "Package dependency changes detected without lockfile updates.\n\n"
  reason += "Drifted packages:\n"

  for (const drifted of result.driftedPackages) {
    reason += `  ${drifted.pkgFile} (lockfile: ${drifted.lockfile}) — run: ${drifted.installCmd}\n`
  }

  reason += "\nRun the install command to regenerate the lockfile, then commit it before stopping."

  return reason
}
