import { join } from "node:path"
import { getHomeDir } from "./home.ts"
import { getProviderTaskRoots } from "./provider-adapters.ts"

export interface TaskRoots {
  tasksDir: string
  projectsDir: string
}

/**
 * Provider-neutral task store boundary.
 * Callers receive a `TaskStore` and pass it to task operations;
 * provider selection (Claude, etc.) is isolated inside `createDefaultTaskStore`.
 */
export type TaskStore = TaskRoots

/**
 * Create the default task store for the current environment.
 * This is the single canonical factory for resolving storage roots —
 * task-repository and task-resolver depend on this type, not on any
 * Claude-specific path logic.
 *
 * Usage: `const store = createDefaultTaskStore()`
 */
export function createDefaultTaskStore(homeDir = getHomeDir()): TaskStore {
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

/**
 * @deprecated Use `createDefaultTaskStore()` instead.
 */
export function getDefaultTaskRoots(homeDir?: string): TaskRoots {
  return createDefaultTaskStore(homeDir)
}
