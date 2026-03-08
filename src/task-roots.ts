import { join } from "node:path"
import { getHomeDir } from "./home.ts"
import { getProviderTaskRoots } from "./provider-adapters.ts"

export interface TaskRoots {
  tasksDir: string
  projectsDir: string
}

/**
 * Resolve task/projects roots for the Claude-compatible task store.
 *
 * Usage:
 * `const { projectsDir } = getDefaultTaskRoots();`
 */
export function getDefaultTaskRoots(homeDir = getHomeDir()): TaskRoots {
  const defaultHome = getHomeDir()
  if (homeDir === defaultHome) {
    const roots = getProviderTaskRoots("claude")
    if (roots) return roots
  }
  return {
    tasksDir: join(homeDir, ".claude", "tasks"),
    projectsDir: join(homeDir, ".claude", "projects"),
  }
}
