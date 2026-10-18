import { getAgent } from "../../../agents.ts"
import { collectEnforcementReport } from "../../../enforcement-evidence.ts"
import { isSessionstartSelfHealPaused } from "../../../sessionstart-self-heal-state.ts"
import type { DiagnosticCheck } from "../types.ts"

export const enforcementCheck: DiagnosticCheck = {
  name: "enforcement-evidence",
  async run() {
    const report = await collectEnforcementReport({ cwd: process.cwd() })
    if (!report.sessions.length)
      return {
        name: "Observed enforcement",
        status: "warn",
        detail:
          "No recent session dispatch observed in this project. Registration alone is not live proof; run a harmless deny probe in the host, then swiz enforcement.",
      }
    return Promise.all(
      report.sessions.map(async (session) => {
        const agent = getAgent(session.agent)
        const paused = agent ? await isSessionstartSelfHealPaused(agent.id) : null
        return {
          name: `Observed enforcement (${session.agent}: ${session.sessionId})`,
          status: "warn" as const,
          detail: `${session.evidence} dispatch at ${session.lastObservedAt}; ${session.denied} denied, ${session.passed} passed, ${session.unknown} unknown. Host acceptance remains unverified. Automatic repair: ${paused === null ? "unknown" : paused ? "paused" : "enabled"} (separate from installed enforcement). Inspect: swiz enforcement --session ${session.sessionId}`,
        }
      })
    )
  },
}
