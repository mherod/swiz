/**
 * Context resolution for the unified ship checklist workflow.
 *
 * Loads settings, validates prerequisites, and determines which gates
 * (git, CI, issues) should be active. All settings are loaded once and
 * shared across the three workflow concerns.
 */

import { isGitRepoForHookPayload } from "../../src/repository-capability.ts"
import type { StopHookInput } from "../../src/schemas.ts"
import type { EffectiveSwizSettings } from "../../src/settings.ts"
import { stopContinuationModeForHook } from "../../src/stop-continuation.ts"
import { getEffectiveSwizSettingsForToolHook } from "../../src/utils/hook-effective-settings.ts"
import type { ShipChecklistContext, WorkflowGates } from "./types.ts"

function resolveWorkflowGates(
  settings: EffectiveSwizSettings,
  deliveryOnly: boolean
): WorkflowGates {
  return {
    git: settings.gitStatusGate ?? true,
    ci: settings.githubCiGate ?? false,
    issues: !deliveryOnly && (settings.personalRepoIssuesGate ?? false),
  }
}

function hasEnabledGate(gates: WorkflowGates): boolean {
  return gates.git || gates.ci || gates.issues
}

/**
 * Resolve all settings and prerequisites for the ship checklist.
 * Returns null (fail-open) if any prerequisite fails or if all gates are disabled.
 */
export async function resolveShipChecklistContext(
  input: StopHookInput
): Promise<ShipChecklistContext | null> {
  const cwd = input.cwd ?? process.cwd()

  // Prerequisite: must be in a git repository
  if (!(await isGitRepoForHookPayload(input, cwd))) {
    return null
  }

  // Load settings to determine which gates are active
  try {
    const effective = await getEffectiveSwizSettingsForToolHook({
      cwd,
      session_id: input.session_id,
      payload: input,
    })
    const mode = await stopContinuationModeForHook({ ...input, _effectiveSettings: effective })
    if (mode === "commit") return null
    const deliveryOnly = mode === "delivery"
    const gates = resolveWorkflowGates(effective, deliveryOnly)

    // Fail-open: if all gates are disabled, no evaluation needed
    if (!hasEnabledGate(gates)) return null

    return {
      cwd,
      sessionId: input.session_id,
      gates,
      deliveryOnly,
    }
  } catch {
    // Fail-open: settings loading errors don't block stop
    return null
  }
}
