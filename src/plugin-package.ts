import { AGENTS } from "./agents.ts"
import { mergeConfig } from "./commands/install/config-helpers.ts"

export const PLUGIN_AGENTS = ["claude", "codex"] as const
export type PluginAgent = (typeof PLUGIN_AGENTS)[number]

interface PluginHookGroup {
  hooks: Array<{ type: string; command: string; timeout: number; statusMessage: string }>
}

/** Keep packaged hooks on the same event, timeout and dispatch contract as install. */
export function buildPluginHooks(agentId: PluginAgent): {
  hooks: Record<string, PluginHookGroup[]>
} {
  const agent = AGENTS.find((candidate) => candidate.id === agentId)!
  const hooks = mergeConfig(agent, {}) as Record<string, PluginHookGroup[]>
  for (const groups of Object.values(hooks)) {
    for (const group of groups) {
      for (const handler of group.hooks) {
        const dispatch = handler.command.slice(handler.command.indexOf("swiz dispatch "))
        handler.command =
          "command -v swiz >/dev/null 2>&1 || { printf '%s\\n' 'swiz-core: swiz is not on PATH. Install Bun and run bun install --frozen-lockfile && bun link in the swiz checkout; restart the agent.' >&2; exit 1; }; " +
          `SWIZ_PLUGIN=1 ${dispatch}`
      }
    }
  }
  return { hooks }
}
