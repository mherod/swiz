/**
 * Context resolution for the unified ship checklist workflow.
 *
 * Loads settings, validates prerequisites, and determines which gates
 * (git, CI, issues) should be active. All settings are loaded once and
 * shared across the three workflow concerns.
 */

import { isGitRepoForHookPayload } from "../../src/repository-capability.ts"
import type { StopHookInput } from "../../src/schemas.ts"
import {
  getEffectiveSwizSettings,
  readProjectSettings,
  readSwizSettings,
} from "../../src/settings.ts"
import type { ShipChecklistContext, WorkflowGates } from "./types.ts"

function resolveWorkflowGates(
  settings: ReturnType<typeof getEffectiveSwizSettings>
): WorkflowGates {
  return {
    git: settings.gitStatusGate ?? true,
    ci: settings.githubCiGate ?? false,
    issues: settings.personalRepoIssuesGate ?? false,
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
    const [globalSettings, projectSettings] = await Promise.all([
      readSwizSettings(),
      readProjectSettings(cwd),
    ])

    const effective = getEffectiveSwizSettings(globalSettings, input.session_id, projectSettings)

    // Disabling auto-continue makes an explicit stop final. Ship gates remain
    // available when auto-continue is enabled, but must not manufacture a new
    // work cycle after the user has opted out.
    if (effective.autoContinue === false) {
      return null
    }

    const gates = resolveWorkflowGates(effective)

    // Fail-open: if all gates are disabled, no evaluation needed
    if (!hasEnabledGate(gates)) return null

    return {
      cwd,
      sessionId: input.session_id,
      gates,
    }
  } catch {
    // Fail-open: settings loading errors don't block stop
    return null
  }
}
