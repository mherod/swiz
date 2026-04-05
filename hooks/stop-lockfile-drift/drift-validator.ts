/**
 * Drift validation: check if package.json changes lack lockfile updates.
 */

import { findDriftedPackages } from "./lockfile-detector.ts"
import type { DriftValidationResult, LockfileDriftContext } from "./types.ts"

/**
 * Validate lockfile drift: return blocking result if packages drifted.
 */
export async function validateLockfileDrift(
  ctx: LockfileDriftContext
): Promise<DriftValidationResult> {
  const drifted = await findDriftedPackages(ctx)

  if (drifted.length === 0) {
    return { kind: "ok" }
  }

  return {
    kind: "drift-detected",
    driftedPackages: drifted,
  }
}
