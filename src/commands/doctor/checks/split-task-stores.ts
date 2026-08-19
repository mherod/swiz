import { getHomeDirWithFallback } from "../../../home.ts"
import { projectKeyFromCwd } from "../../../project-key.ts"
import { readSessionTasks } from "../../../tasks/task-recovery.ts"
import { isIncompleteTaskStatus } from "../../../tasks/task-repository.ts"
import type { CheckResult, DiagnosticCheck } from "../types.ts"

/**
 * Surface open work held in the project-keyed task store.
 *
 * The MCP task tools key the store by `projectKeyFromCwd(cwd)`; the native tools key it by session
 * id. Readers that consult only the session directory report an empty queue for tasks written
 * through MCP, which is how a governance gate came to stand down over a full backlog (#823).
 * `readTasksAcrossStores` / `readSessionTasksUnioned` close that gap wherever they are wired in, so
 * this check exists to make the split visible in the surfaces that still read one store.
 */
export async function checkSplitTaskStores(
  cwd: string = process.cwd(),
  home: string = getHomeDirWithFallback("")
): Promise<CheckResult> {
  const name = "split-task-stores"
  const projectKey = projectKeyFromCwd(cwd)
  if (!home || !projectKey) {
    return { name, status: "pass", detail: "No task store to inspect" }
  }

  const projectTasks = await readSessionTasks(projectKey, home).catch(() => [])
  const openTasks = projectTasks.filter((task) => isIncompleteTaskStatus(task.status))
  if (openTasks.length === 0) {
    return { name, status: "pass", detail: "No open tasks in the project-keyed store" }
  }

  const ids = openTasks
    .slice(0, 5)
    .map((task) => `#${task.id}`)
    .join(", ")
  const overflow = openTasks.length > 5 ? `, +${openTasks.length - 5} more` : ""
  return {
    name,
    status: "warn",
    detail:
      `${openTasks.length} open task(s) live under the project key "${projectKey}" (${ids}${overflow}). ` +
      "Surfaces reading only the session store will not see them — union with readTasksAcrossStores.",
  }
}

export const splitTaskStoresCheck: DiagnosticCheck = {
  name: "split-task-stores",
  async run() {
    return checkSplitTaskStores()
  },
}
