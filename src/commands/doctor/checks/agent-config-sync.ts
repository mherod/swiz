import { getAgentSettingsPath } from "../../../agent-paths.ts"
import { type AgentDef, CONFIGURABLE_AGENTS, translateEvent } from "../../../agents.ts"
import { manifest } from "../../../manifest.ts"
import {
  extractDispatchEvents,
  extractDispatchEventsWithoutAgent,
} from "../../../utils/config-commands.ts"
import type { CheckResult, DiagnosticCheck } from "../types.ts"

/** Get the set of canonical events the manifest expects to be dispatched via agent configs.
 *  Scheduled events (preCommit, commitMsg, prePush) are dispatched via lefthook,
 *  not agent settings — exclude them to match what `swiz install` actually writes. */
function getExpectedCanonicalEvents(): Set<string> {
  const events = new Set<string>()
  for (const group of manifest) {
    if (group.scheduled) continue
    if (group.hooks.length === 0) continue
    events.add(group.event)
  }
  return events
}

/** Outcome of reading and parsing an agent settings JSON file for config-sync checks. */
type AgentSettingsLoadResult =
  | { ok: true; settings: Record<string, unknown> }
  | { ok: false; diagnostic: CheckResult }

async function loadAgentSettings(agent: AgentDef): Promise<AgentSettingsLoadResult> {
  const file = Bun.file(agent.settingsPath)
  if (!(await file.exists())) {
    return {
      ok: false,
      diagnostic: {
        name: `${agent.name} config sync`,
        status: "warn",
        detail: "settings file not found — run: swiz install",
      },
    }
  }
  try {
    const parsed: unknown = await file.json()
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false,
        diagnostic: {
          name: `${agent.name} config sync`,
          status: "fail",
          detail: "settings file root must be a JSON object",
        },
      }
    }
    return { ok: true, settings: parsed as Record<string, unknown> }
  } catch {
    return {
      ok: false,
      diagnostic: {
        name: `${agent.name} config sync`,
        status: "fail",
        detail: "settings file is malformed JSON",
      },
    }
  }
}

function hooksFromSettings(
  agent: AgentDef,
  settings: Record<string, unknown>
): Record<string, unknown> {
  const raw = agent.wrapsHooks ? settings.hooks : settings[agent.hooksKey]
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
}

export async function checkAgentConfigSync(agent: AgentDef): Promise<CheckResult> {
  const loaded = await loadAgentSettings(agent)
  if (!loaded.ok) return loaded.diagnostic
  const { settings } = loaded

  const hooks = hooksFromSettings(agent, settings)

  const installed = extractDispatchEvents(hooks)
  const expected = getExpectedCanonicalEvents()
  const withoutAgent = extractDispatchEventsWithoutAgent(hooks)

  const { missing, outdated } = findConfigDrift(agent, expected, installed, withoutAgent)

  if (missing.length === 0 && outdated.length === 0) {
    return {
      name: `${agent.name} config sync`,
      status: "pass",
      detail: `${installed.size} dispatch entries in sync with manifest`,
    }
  }
  const parts: string[] = []
  if (missing.length > 0) parts.push(`${missing.length} missing: ${missing.join(", ")}`)
  if (outdated.length > 0)
    parts.push(`${outdated.length} outdated (no --agent): ${outdated.join(", ")}`)
  return {
    name: `${agent.name} config sync`,
    status: "warn",
    detail: `${parts.join("; ")} — run: swiz install`,
  }
}

function findConfigDrift(
  agent: AgentDef,
  expected: Set<string>,
  installed: Set<string>,
  withoutAgent: Set<string>
): { missing: string[]; outdated: string[] } {
  const missing: string[] = []
  const outdated: string[] = []
  for (const event of expected) {
    if (agent.unsupportedEvents?.includes(event)) continue
    const label = `${event} (${translateEvent(event, agent)})`
    if (!installed.has(event)) missing.push(label)
    else if (withoutAgent.has(event)) outdated.push(label)
  }
  return { missing, outdated }
}

export const agentConfigSyncCheck: DiagnosticCheck = {
  name: "agent-config-sync",
  async run() {
    const results: CheckResult[] = []
    for (const agent of CONFIGURABLE_AGENTS) {
      results.push(
        await checkAgentConfigSync({
          ...agent,
          settingsPath: getAgentSettingsPath(agent.id),
        })
      )
    }
    return results
  },
}
