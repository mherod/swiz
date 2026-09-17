/**
 * Compare actual MCP, CLI and hook projections without invoking retention.
 * Run: bun scripts/debug-task-store-scope.ts [sessionId] [--provider claude|codex|cursor|gemini]
 * Raw stores may legitimately differ; consumer divergence gates namespace rollout.
 */
import type { AgentSettingsId } from "../src/agent-paths.ts"
import { readDefaultProjectTasks } from "../src/commands/tasks.ts"
import { readMcpTaskQueue } from "../src/mcp-tool-core.ts"
import { createDefaultTaskStore, createTaskStoreForProvider } from "../src/task-roots.ts"
import {
  projectStoreKey,
  readTasks,
  readTasksAcrossStores,
  type Task,
} from "../src/tasks/task-repository.ts"
import { getSessions } from "../src/tasks/task-resolver.ts"

const args = process.argv.slice(2)
const providerIndex = args.indexOf("--provider")
const provider = providerIndex < 0 ? undefined : args[providerIndex + 1]
if (provider && !["claude", "codex", "cursor", "gemini"].includes(provider))
  throw new Error("Unsupported task provider")
const cwd = process.cwd()
const store = provider
  ? createTaskStoreForProvider(provider as AgentSettingsId)
  : createDefaultTaskStore()
const projectKey = projectStoreKey(cwd).key
const sessions = await getSessions(cwd, store.tasksDir, store.projectsDir)
const sessionId = args[0]?.startsWith("--") ? "" : (args[0] ?? "")
const [records, cli, hooks, rawProject, rawSession] = await Promise.all([
  readMcpTaskQueue(projectKey, store.tasksDir),
  readDefaultProjectTasks(cwd, store.tasksDir),
  readTasksAcrossStores(sessionId, projectKey, store.tasksDir),
  readTasks(projectKey, store.tasksDir),
  readTasks(sessionId, store.tasksDir),
])
const mcp = records.map(({ task }) => task)
const projection = (tasks: Task[]) => new Map(tasks.map((task) => [task.id, task.status]))
function compare(tasks: Task[]) {
  const expected = projection(mcp)
  const actual = projection(tasks)
  return {
    onlyInMcp: [...expected.keys()].filter((id) => !actual.has(id)),
    onlyInConsumer: [...actual.keys()].filter((id) => !expected.has(id)),
    statusConflicts: [...expected]
      .filter(([id, status]) => actual.has(id) && actual.get(id) !== status)
      .map(([id]) => id),
  }
}
const comparisons = { cli: compare(cli), hooks: compare(hooks) }
const divergence = Object.values(comparisons).reduce(
  (sum, result) =>
    sum + result.onlyInMcp.length + result.onlyInConsumer.length + result.statusConflicts.length,
  0
)
console.log(
  JSON.stringify(
    {
      cwd,
      provider: provider ?? "environment default",
      ...store,
      projectKey,
      sessionId,
      rawInventory: { project: rawProject.length, session: rawSession.length },
      consumers: { mcp: mcp.length, cli: cli.length, hooks: hooks.length },
      comparisons,
      divergence,
      sessionCandidates: sessions,
    },
    null,
    2
  )
)
if (divergence) process.exitCode = 1
