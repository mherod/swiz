/**
 * Safe construction of task-record file paths.
 *
 * Both maintenance passes — pruning and duplicate merging — delete task files
 * chosen by reading records, then rebuild the filename from the record's own
 * `id` field. That field is file *content*, not the filename it was read from,
 * so nothing guarantees it stays inside the store: an id of `../../settings`
 * turns a routine cleanup into a delete of `settings.json` two directories up.
 *
 * Leaf module: node:path only, so every task module can import it.
 */

import { isAbsolute, join, relative, resolve } from "node:path"

/**
 * Resolve `<dir>/<id>.json`, or null when the id does not name a plain file
 * directly inside `dir`. Callers treat null as "refuse to touch this record"
 * rather than as an error — a malformed id is a corrupt record, and skipping it
 * leaves strictly less damage than acting on it.
 */
export function resolveTaskFilePath(dir: string, id: string): string | null {
  if (!id || id.includes("/") || id.includes("\\") || id.includes("\0")) return null
  // `.` and `..` survive the separator check but still escape or self-target.
  if (id === "." || id === "..") return null

  const candidate = join(dir, `${id}.json`)
  const rel = relative(resolve(dir), resolve(candidate))
  // Must stay one level down: no traversal, no absolute re-root.
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null
  return candidate
}
