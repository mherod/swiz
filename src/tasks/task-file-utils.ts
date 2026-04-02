/**
 * Filename rules for per-session task JSON files under ~/.claude/tasks/<sessionId>/.
 * Keeps doctor diagnostics and task-repository scans aligned.
 */

const SESSION_TASK_JSON_EXCLUDE = "compact-snapshot.json" as const

/**
 * True when `name` is a basename that should be read as a task record JSON file.
 * Excludes dotfiles, the compaction snapshot, and non-`.json` names.
 */
export function isSessionTaskJsonFile(name: string): boolean {
  return name.endsWith(".json") && !name.startsWith(".") && name !== SESSION_TASK_JSON_EXCLUDE
}
