/**
 * Compare the three readers of the task store, which key it differently.
 *
 * `mcp__swiz__TaskList` reads `readTasks(projectKeyFromCwd(cwd))`, `swiz tasks list` reads
 * `readTasks(sessionId)`, and `hooks/pretooluse-task-governance.ts` reads the merged
 * `readTasksAcrossStores(sessionId, projectKey)`.
 *
 * Finding: these do NOT diverge in practice, contrary to the obvious reading of the code. The
 * project-key directory sits inside `tasksDir` alongside real session directories, so
 * `getSessions(cwd)` returns it as a *session candidate* — and being the most recently written,
 * `resolveSession()` picks it. The CLI therefore lands on the same directory the MCP tool reads.
 *
 * What that leaves is a selection hazard rather than a scope split: the CLI shows whichever
 * candidate was written last (see `reportSessionSelection`, #826). Run the candidate table below
 * before concluding the two views disagree — a stray directory in the store can win that race.
 *
 * Run: bun scripts/debug-task-store-scope.ts [sessionId]
 *
 * Imports the real readers rather than reimplementing them, so the output reflects what each
 * caller actually sees. Reads only — never writes to the store.
 */
import { summarizeTasks } from "../src/commands/mcp.ts"
import { createDefaultTaskStore } from "../src/task-roots.ts"
import { readTasks, readTasksAcrossStores, type Task } from "../src/tasks/task-repository.ts"
import { getSessions } from "../src/tasks/task-resolver.ts"
import { projectKeyFromCwd } from "../src/transcript-utils.ts"

const cwd = process.cwd()
const tasksDir = createDefaultTaskStore().tasksDir
const projectKey = projectKeyFromCwd(cwd)

console.log("--- coordinates ---")
console.log("cwd:         ", cwd)
console.log("tasksDir:    ", tasksDir)
console.log("projectKey:  ", projectKey, " <-- MCP TaskList reads this directory")

// Mirror `resolveSession()` with no --session: most recently modified session for this cwd.
const sessions = await getSessions(cwd)
const sessionId = process.argv[2] ?? sessions[0]
console.log("sessions for cwd:", sessions.length, sessions.slice(0, 5))
console.log("sessionId:   ", sessionId, " <-- swiz tasks list reads this directory")
console.log("same directory?", projectKey === sessionId)

if (!sessionId) {
  console.log("\nNo session resolved — nothing to compare.")
  process.exit(0)
}

function summarize(label: string, tasks: Task[]): void {
  const counts: Record<string, number> = {}
  for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1
  // Use the real MCP summary builder, so this stays a regression check rather than a copy that
  // drifts. Before the `cancelled` bucket existed these summed to one short of `total`.
  const summary = summarizeTasks(tasks)
  const bucketed = summary.pending + summary.inProgress + summary.completed + summary.cancelled
  console.log(`\n--- ${label} ---`)
  console.log("count:  ", tasks.length)
  console.log("byStatus:", JSON.stringify(counts))
  console.log(
    "MCP summary buckets:",
    bucketed,
    bucketed === summary.total
      ? "== total ✓"
      : `  <-- expected ${summary.total}, unbucketed: ${summary.total - bucketed}`
  )
  const incomplete = tasks.filter((t) => t.status === "pending" || t.status === "in_progress")
  console.log(
    "incomplete ids:",
    incomplete.map((t) => `${t.id}:${t.status}`).join(", ") || "(none)"
  )
}

const [projectScoped, sessionScoped, merged] = await Promise.all([
  readTasks(projectKey, tasksDir),
  readTasks(sessionId, tasksDir),
  readTasksAcrossStores(sessionId, projectKey, tasksDir),
])

summarize("readTasks(projectKey)  — what MCP TaskList returns", projectScoped)
summarize("readTasks(sessionId)   — what swiz tasks list renders", sessionScoped)
summarize("readTasksAcrossStores  — what the governance hook gates on", merged)

// `resolveSession()` picks sessions[0] = most recently modified. The project-key directory is
// itself a candidate, so whether the CLI agrees with MCP depends on write order, not on design.
console.log("\n--- every candidate the CLI could have picked ---")
for (const candidate of sessions) {
  const tasks = await readTasks(candidate, tasksDir)
  const open = tasks.filter((t) => t.status === "pending" || t.status === "in_progress").length
  const marker = candidate === projectKey ? "  <-- project-keyed (what MCP reads)" : ""
  console.log(
    `  ${candidate.padEnd(40)} tasks=${String(tasks.length).padStart(3)} open=${String(open).padStart(3)}${marker}`
  )
}

console.log("\n--- divergence ---")
const ids = (tasks: Task[]) => new Set(tasks.map((t) => t.id))
const projectIds = ids(projectScoped)
const sessionIds = ids(sessionScoped)
const mergedIds = ids(merged)

const onlyProject = [...projectIds].filter((id) => !sessionIds.has(id))
const onlySession = [...sessionIds].filter((id) => !projectIds.has(id))
console.log("only in project store:", onlyProject.length, onlyProject.slice(0, 10))
console.log("only in session store:", onlySession.length, onlySession.slice(0, 10))
console.log(
  "merged total:",
  mergedIds.size,
  " <-- expected union:",
  new Set([...projectIds, ...sessionIds]).size
)

// Same id, different status between stores: the merged reader resolves these by statusChangedAt,
// so a stale duplicate can make the hook and the MCP tool disagree about what is still open.
const sessionById = new Map(sessionScoped.map((t) => [t.id, t]))
const conflicts = projectScoped
  .filter((t) => sessionById.has(t.id) && sessionById.get(t.id)!.status !== t.status)
  .map((t) => `${t.id}: project=${t.status} session=${sessionById.get(t.id)!.status}`)
console.log("status conflicts:", conflicts.length, conflicts.slice(0, 10))
