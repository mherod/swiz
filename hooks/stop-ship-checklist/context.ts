/**
 * Context resolution for the unified ship checklist workflow.
 *
 * Loads settings, validates prerequisites, and determines which gates
 * (git, CI, issues) should be active. All settings are loaded once and
 * shared across the three workflow concerns.
 */

import type { StopHookInput } from "../../src/schemas.ts"
import {
  getEffectiveSwizSettings,
  readProjectSettings,
  readSwizSettings,
} from "../../src/settings.ts"
import { isGitRepo } from "../../src/utils/hook-utils.ts"
import type { ShipChecklistContext, WorkflowGates } from "./types.ts"

/**
 * Resolve all settings and prerequisites for the ship checklist.
 * Returns null (fail-open) if any prerequisite fails or if all gates are disabled.
 */
export async function resolveShipChecklistContext(
  input: StopHookInput
): Promise<ShipChecklistContext | null> {
  const cwd = input.cwd ?? process.cwd()

  // Prerequisite: must be in a git repository
  if (!(await isGitRepo(cwd))) {
    return null
  }

  // Load settings to determine which gates are active
  try {
    const [globalSettings, projectSettings] = await Promise.all([
      readSwizSettings(),
      readProjectSettings(cwd),
    ])

    const effective = getEffectiveSwizSettings(globalSettings, input.session_id, projectSettings)

    const gates: WorkflowGates = {
      git: effective.gitStatusGate ?? true,
      ci: effective.githubCiGate ?? false,
      issues: effective.personalRepoIssuesGate ?? false,
    }

    // Fail-open: if all gates are disabled, no evaluation needed
    if (!gates.git && !gates.ci && !gates.issues) {
      return null
    }

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
