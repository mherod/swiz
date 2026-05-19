import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import {
  type AgentSettingsId,
  detectCurrentAgent,
  detectCurrentAgentFromHookPayload,
} from "./agent-paths.ts"
import { getHomeDir } from "./home.ts"
import { getProviderTaskRoots, type ProviderTaskRoots } from "./provider-adapters.ts"

export type { ProviderTaskRoots as TaskRoots }

const PROVIDER_ORDER: AgentSettingsId[] = ["claude", "codex", "cursor", "gemini"]
type HookPayloadInput = NonNullable<Parameters<typeof detectCurrentAgentFromHookPayload>[0]>

/**
 * Provider-neutral task store boundary.
 * Callers receive a `TaskStore` and pass it to task operations;
 * provider selection (Claude, etc.) is isolated inside `createDefaultTaskStore`.
 */
export type TaskStore = ProviderTaskRoots

export function createTaskStoreForProvider(
  agentId: AgentSettingsId,
  homeDir = getHomeDir()
): ProviderTaskRoots {
  switch (agentId) {
    case "claude":
      return {
        tasksDir: join(homeDir, ".claude", "tasks"),
        projectsDir: join(homeDir, ".claude", "projects"),
      }
    case "codex":
      return {
        tasksDir: join(homeDir, ".codex", "tasks"),
        projectsDir: join(homeDir, ".codex", "projects"),
      }
    case "cursor":
      return {
        tasksDir: join(homeDir, ".cursor", "tasks"),
        projectsDir: join(homeDir, ".cursor", "chats"),
      }
    case "gemini":
      return {
        tasksDir: join(homeDir, ".gemini", "tasks"),
        projectsDir: join(homeDir, ".gemini", "projects"),
      }
  }
}

function taskSessionDirHasFiles(tasksDir: string, sessionId: string): boolean {
  const sessionDir = join(tasksDir, sessionId)
  if (!existsSync(sessionDir)) return false
  try {
    return readdirSync(sessionDir).some((file) => file.endsWith(".json"))
  } catch {
    return false
  }
}

export function createTaskStoreForHookPayload(
  payload: HookPayloadInput | null | undefined,
  homeDir = getHomeDir()
): ProviderTaskRoots {
  const agent = detectCurrentAgentFromHookPayload(payload ?? undefined)
  return agent
    ? createTaskStoreForProvider(agent.id as AgentSettingsId, homeDir)
    : createDefaultTaskStore(homeDir)
}

export function findTaskStoreForSession(
  sessionId: string,
  homeDir = getHomeDir()
): ProviderTaskRoots {
  for (const provider of PROVIDER_ORDER) {
    const roots = createTaskStoreForProvider(provider, homeDir)
    if (taskSessionDirHasFiles(roots.tasksDir, sessionId)) return roots
  }
  return createDefaultTaskStore(homeDir)
}

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
