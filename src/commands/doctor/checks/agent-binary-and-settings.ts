import { AGENTS, type AgentDef } from "../../../agents.ts"
import type { CheckResult, DiagnosticCheck } from "../types.ts"
import { whichExists } from "../utils.ts"

async function checkAgentBinary(agent: AgentDef): Promise<CheckResult> {
  const path = await whichExists(agent.binary)

  return {
    name: `${agent.name} binary`,
    status: path ? "pass" : "warn",
    detail: path ?? `"${agent.binary}" not found on PATH`,
  }
}

async function checkAgentSettings(agent: AgentDef): Promise<CheckResult> {
  const file = Bun.file(agent.settingsPath)
  const exists = await file.exists()

  if (!exists) {
    return {
      name: `${agent.name} settings`,
      status: "warn",
      detail: `${agent.settingsPath} not found`,
    }
  }

  // Non-JSON config formats (e.g. TOML): verify readable and non-empty.
  if (!agent.settingsPath.endsWith(".json")) {
    try {
      const content = await file.text()
      if (!content.trim()) {
        return {
          name: `${agent.name} settings`,
          status: "warn",
          detail: `${agent.settingsPath} is empty`,
        }
      }
      return {
        name: `${agent.name} settings`,
        status: "pass",
        detail: agent.settingsPath,
      }
    } catch {
      return {
        name: `${agent.name} settings`,
        status: "fail",
        detail: `${agent.settingsPath} exists but is not readable`,
      }
    }
  }

  try {
    await file.json()
    return {
      name: `${agent.name} settings`,
      status: "pass",
      detail: agent.settingsPath,
    }
  } catch {
    return {
      name: `${agent.name} settings`,
      status: "fail",
      detail: `${agent.settingsPath} exists but is malformed JSON`,
    }
  }
}

export const agentBinaryAndSettingsCheck: DiagnosticCheck = {
  name: "agent-binary-and-settings",
  async run() {
    const results: CheckResult[] = []
    for (const agent of AGENTS) {
      results.push(await checkAgentBinary(agent))
      results.push(await checkAgentSettings(agent))
    }
    return results
  },
}
