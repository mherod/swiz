// noinspection JSUnusedGlobalSymbols

import { join } from "node:path"
import { detectCurrentAgent } from "./agent-paths.ts"
import { getHomeDir } from "./home.ts"
import { getProviderTaskRoots, type ProviderTaskRoots } from "./provider-adapters.ts"

export type { ProviderTaskRoots as TaskRoots }

/**
 * Provider-neutral task store boundary.
 * Callers receive a `TaskStore` and pass it to task operations;
 * provider selection (Claude, etc.) is isolated inside `createDefaultTaskStore`.
 */
export type TaskStore = ProviderTaskRoots

/**
 * Create the default task store for the current environment.
 * Detects the current agent and returns its task storage roots.
 * Falls back to Claude paths when no agent is detected.
 *
 * Usage: `const store = createDefaultTaskStore()`
 */
export function createDefaultTaskStore(homeDir = getHomeDir()): ProviderTaskRoots {
  const defaultHome = getHomeDir()
  if (homeDir === defaultHome) {
    // Try detected agent first, then fall back to Claude
    const agent = detectCurrentAgent()
    if (agent) {
      const roots = getProviderTaskRoots(agent)
      if (roots) return roots
    }
    const claudeRoots = getProviderTaskRoots("claude")
    if (claudeRoots) return claudeRoots
  }
  return {
    tasksDir: join(homeDir, ".claude", "tasks"),
    projectsDir: join(homeDir, ".claude", "projects"),
  }
}
