/** Preview namespaced project stores; --apply folds them into the flat layout, preserving collisions. */
import type { AgentSettingsId } from "../src/agent-paths.ts"
import { createDefaultTaskStore, createTaskStoreForProvider } from "../src/task-roots.ts"
import { migrateLegacyProjectStores } from "../src/tasks/task-store-layout.ts"

const args = process.argv.slice(2)
const providerIndex = args.indexOf("--provider")
const provider = providerIndex < 0 ? undefined : args[providerIndex + 1]
if (provider && !["claude", "codex", "cursor", "gemini"].includes(provider))
  throw new Error("Unsupported task provider")
const store = provider
  ? createTaskStoreForProvider(provider as AgentSettingsId)
  : createDefaultTaskStore()
const apply = args.includes("--apply")
const results = await migrateLegacyProjectStores(store.tasksDir, apply)
console.log(JSON.stringify({ tasksDir: store.tasksDir, apply, results }, null, 2))
if (results.some((result) => result.status === "held")) process.exitCode = 2
