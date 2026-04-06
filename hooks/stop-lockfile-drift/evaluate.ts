/**
 * Main Orchestration Module
 *
 * Resolves context and runs drift validation.
 * Entry point for the modular stop-lockfile-drift hook.
 */

import type { SwizHookOutput } from "../../src/SwizHook.ts"
import type { StopHookInput } from "../../src/schemas.ts"
import { blockStopObj } from "../../src/utils/hook-utils.ts"
import { formatDriftBlockReason } from "./action-plan.ts"
import { resolveLockfileDriftContext } from "./context.ts"
import { validateLockfileDrift } from "./drift-validator.ts"

/**
 * Main evaluation function: validate lockfile drift.
 * Returns blocking output or empty object when stop may proceed.
 */
export async function evaluateStopLockfileDrift(input: StopHookInput): Promise<SwizHookOutput> {
  // Resolve prerequisites and load context
  const ctx = await resolveLockfileDriftContext(input)
  if (!ctx) return {} // Fail-open: prerequisites not met

  // Run drift validation
  const result = await validateLockfileDrift(ctx)

  // Format result
  const reason = formatDriftBlockReason(result)
  if (!reason) {
    return {}
  }

  return blockStopObj(reason)
}
