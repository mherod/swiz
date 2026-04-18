import { type AgentDef, CONFIGURABLE_AGENTS, translateEvent } from "../../../agents.ts"
import { manifest } from "../../../manifest.ts"
import { extractDispatchEvents } from "../../../utils/config-commands.ts"
import type { CheckResult, DiagnosticCheck } from "../types.ts"

/** Get the set of canonical events the manifest expects to be dispatched via agent configs.
 *  Scheduled events (preCommit, commitMsg, prePush) are dispatched via lefthook,
 *  not agent settings — exclude them to match what `swiz install` actually writes. */
function getExpectedCanonicalEvents(): Set<string> {
  const events = new Set<string>()
  for (const group of manifest) {
    if (group.scheduled) continue
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

export async function checkAgentConfigSync(agent: AgentDef): Promise<CheckResult> {
  const loaded = await loadAgentSettings(agent)
  if (!loaded.ok) return loaded.diagnostic
  const { settings } = loaded

  const hooksRaw = agent.wrapsHooks
    ? ((settings.hooks as Record<string, unknown> | undefined) ?? {})
    : ((settings[agent.hooksKey] as Record<string, unknown> | undefined) ?? {})
  const hooks = typeof hooksRaw === "object" && !Array.isArray(hooksRaw) ? hooksRaw : {}

  const installed = extractDispatchEvents(hooks)
  const expected = getExpectedCanonicalEvents()

  const missing: string[] = []
  for (const event of expected) {
    if (!installed.has(event)) {
      const agentEvent = translateEvent(event, agent)
      missing.push(`${event} (${agentEvent})`)
    }
  }

  if (missing.length === 0) {
    return {
      name: `${agent.name} config sync`,
      status: "pass",
      detail: `${installed.size} dispatch entries in sync with manifest`,
    }
  }
  return {
    name: `${agent.name} config sync`,
    status: "warn",
    detail: `${missing.length} missing dispatch: ${missing.join(", ")} — run: swiz install`,
  }
}

export const agentConfigSyncCheck: DiagnosticCheck = {
  name: "agent-config-sync",
  async run() {
    const results: CheckResult[] = []
    for (const agent of CONFIGURABLE_AGENTS) {
      results.push(await checkAgentConfigSync(agent))
    }
    return results
  },
}
