import { projectKeyFromCwd } from "../project-key.ts"
import { canonicalWords, normalizeSubject } from "../subject-fingerprint.ts"
import { createDefaultTaskStore, type TaskStore } from "../task-roots.ts"
import { COMPLETED_TASK_PRUNE_AGE_MS } from "./task-governance-constants.ts"
import { truncateForLine } from "./task-mcp-view.ts"
import { mergeTaskStoresByRecency, readTasksAcrossStores, type Task } from "./task-repository.ts"
import { getSessionIdsByCwdScan, getSessions } from "./task-resolver.ts"

const GENERIC_TERMS = canonicalWords(
  normalizeSubject(
    "add build create implement fix update remove verify run test check review inspect investigate complete perform task work change"
  )
)

function discoveryTerms(subject: string): Set<string> {
  return new Set(
    [...canonicalWords(normalizeSubject(subject))].filter((term) => !GENERIC_TERMS.has(term))
  )
}

/** Read-only advice uses relevance, never the duplicate-rejection threshold. */
export function selectRelatedTasks(
  subject: string,
  excludedId: string,
  tasks: Task[],
  now: number
): Task[] {
  const terms = discoveryTerms(subject)
  return tasks
    .map((task) => {
      const age = now - Date.parse(task.statusChangedAt ?? "")
      const completedAge = now - (task.completedAt ?? NaN)
      const eligible =
        task.status === "pending" ||
        task.status === "in_progress" ||
        (task.status === "completed" &&
          completedAge >= 0 &&
          completedAge <= COMPLETED_TASK_PRUNE_AGE_MS)
      const score = [...discoveryTerms(task.subject)].filter((term) => terms.has(term)).length
      return { task, score, age: Number.isFinite(age) ? Math.max(0, age) : Infinity, eligible }
    })
    .filter((item) => item.eligible && item.task.id !== excludedId && item.score > 0)
    .sort((a, b) => b.score - a.score || a.age - b.age || a.task.id.localeCompare(b.task.id))
    .slice(0, 5)
    .map((item) => item.task)
}

/** Failure is advisory-only: a successful TaskCreate must remain successful. */
export async function discoverRelatedTaskAdvice(
  cwd: string,
  task: Pick<Task, "id" | "subject">,
  options: { store?: TaskStore; now?: number; read?: typeof readTasksAcrossStores } = {}
): Promise<string> {
  try {
    const store = options.store ?? createDefaultTaskStore()
    const projectKey = projectKeyFromCwd(cwd)
    const candidates = await getSessions(cwd, store.tasksDir, store.projectsDir)
    // getSessions also admits unattributed orphans for recovery; advice must not.
    const owned = await getSessionIdsByCwdScan(cwd, candidates, store.projectsDir, store.tasksDir)
    const keys = new Set([projectKey, ...owned])
    const read = options.read ?? readTasksAcrossStores
    const groups = await Promise.all([...keys].map((key) => read(key, undefined, store.tasksDir)))
    const now = options.now ?? Date.now()
    const related = selectRelatedTasks(
      task.subject,
      task.id,
      mergeTaskStoresByRecency(...groups),
      now
    )
    if (related.length === 0) return ""
    const lines = related.map((item) => {
      const age = now - Date.parse(item.statusChangedAt ?? "")
      const ageLabel = Number.isFinite(age)
        ? `${Math.max(0, Math.floor(age / 60_000))}m ago`
        : "age unknown"
      return `- #${truncateForLine(item.id, 40)} ${truncateForLine(item.subject, 100)} [${item.status}; ${ageLabel}]`
    })
    return `\n\nRelated project work (advisory):\n${lines.join("\n")}`
  } catch {
    return ""
  }
}
