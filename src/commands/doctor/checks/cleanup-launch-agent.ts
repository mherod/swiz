import { type CleanupAgentOptions, inspectCleanupLaunchAgent } from "../../install/cleanup-agent.ts"
import type { CheckResult, DiagnosticCheck } from "../types.ts"

export const CLEANUP_LAUNCH_AGENT_CHECK_NAME = "Cleanup LaunchAgent"

export function needsCleanupLaunchAgentRepair(results: CheckResult[]): boolean {
  return results.some(
    (result) => result.name === CLEANUP_LAUNCH_AGENT_CHECK_NAME && result.status === "warn"
  )
}

export async function checkCleanupLaunchAgent(
  options: CleanupAgentOptions = {}
): Promise<CheckResult> {
  const name = CLEANUP_LAUNCH_AGENT_CHECK_NAME
  try {
    const state = await inspectCleanupLaunchAgent(options)
    if (!state.supported) return { name, status: "pass", detail: "macOS only; not applicable" }
    const issue = !state.exists
      ? "not installed"
      : !state.current
        ? "configuration outdated or invalid"
        : !state.loaded
          ? "not loaded"
          : null
    if (issue) {
      return { name, status: "warn", detail: `${issue} — run swiz doctor --fix or swiz install` }
    }
    return { name, status: "pass", detail: "loaded; runs on load and every 24 hours" }
  } catch (error) {
    return { name, status: "fail", detail: `could not inspect cleanup LaunchAgent: ${error}` }
  }
}

export const cleanupLaunchAgentCheck: DiagnosticCheck = {
  name: "cleanup-launch-agent",
  run: () => checkCleanupLaunchAgent(),
}
