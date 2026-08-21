/**
 * Probe the on-disk task store for the topology signal the daemon web view drops.
 *
 * The tasks view renders flat status lists, so the question is whether the underlying
 * records actually carry dependency edges, durations, and descriptions worth surfacing —
 * or whether the store itself is flat and a topology view would render nothing.
 *
 * Usage: bun scripts/debug-task-topology.ts [cwd]
 */

import { getProjectTasks, getSessionTasks } from "../src/commands/daemon/session-data.ts"
import { getProviderTaskRoots } from "../src/provider-adapters.ts"
import { findDependencyCycle, summarizeTasks } from "../src/tasks/task-mcp-view.ts"
import { readTasks } from "../src/tasks/task-repository.ts"
import { projectKeyFromCwd } from "../src/transcript-utils.ts"

const cwd = process.argv[2] ?? process.cwd()
console.log("--- inputs ---")
console.log("cwd:", cwd)
console.log("projectKey:", projectKeyFromCwd(cwd))
console.log("taskRoots:", getProviderTaskRoots("claude"))

console.log("\n--- raw store: project-keyed tasks ---")
const projectKeyed = await readTasks(projectKeyFromCwd(cwd))
console.log("count:", projectKeyed.length)
console.log("summary:", summarizeTasks(projectKeyed))

const withEdges = projectKeyed.filter((t) => t.blockedBy.length > 0 || t.blocks.length > 0)
console.log("tasks carrying blockedBy/blocks edges:", withEdges.length, " <-- topology signal")
for (const task of withEdges.slice(0, 10)) {
  console.log(
    `  #${task.id} ${task.status} blockedBy=${JSON.stringify(task.blockedBy)} blocks=${JSON.stringify(task.blocks)}`
  )
}

const withDescription = projectKeyed.filter((t) => t.description.trim().length > 0)
console.log("tasks with a non-empty description:", withDescription.length)
const withElapsed = projectKeyed.filter((t) => (t.elapsedMs ?? 0) > 0)
console.log("tasks with elapsedMs > 0:", withElapsed.length)
const withStartedAt = projectKeyed.filter((t) => t.startedAt != null)
console.log("tasks with startedAt:", withStartedAt.length)
console.log("dependency cycle among open tasks:", findDependencyCycle(projectKeyed))

console.log("\n--- one full record (shape check) ---")
console.dir(projectKeyed.at(-1), { depth: null })

console.log("\n--- what the daemon web API actually returns ---")
const projectView = await getProjectTasks(cwd, 100)
console.log("projectView.summary:", projectView.summary)
console.log("projectView.tasks[0] keys:", Object.keys(projectView.tasks[0] ?? {}))
console.dir(projectView.tasks[0], { depth: null })

const firstSession = projectView.tasks[0]?.sessionId
if (firstSession) {
  const sessionView = await getSessionTasks(firstSession, 20)
  console.log("\nsessionView.summary:", sessionView.summary)
  console.log("sessionView.tasks[0] keys:", Object.keys(sessionView.tasks[0] ?? {}))
}

console.log("\n--- session spread across the project (cross-session topology) ---")
const bySession = new Map<string, number>()
for (const task of projectView.tasks) {
  bySession.set(task.sessionId, (bySession.get(task.sessionId) ?? 0) + 1)
}
console.log("distinct sessions in the loaded project page:", bySession.size)
for (const [sid, count] of bySession) console.log(`  ${sid.slice(0, 8)}… ${count} task(s)`)
