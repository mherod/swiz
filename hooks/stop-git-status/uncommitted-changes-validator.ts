/**
 * Uncommitted changes detection.
 *
 * Analyzes git status to identify modified, added, deleted, and untracked files.
 */

import type { GitStatus } from "./types.ts"

/**
 * Build a summary description of uncommitted changes.
 */
export function buildUncommittedReason(
  status: GitStatus,
  upstream: string,
  behind: number
): string {
  const { total, modified, added, deleted, untracked, lines, branch } = status

  const summary = [
    modified > 0 ? `${modified} modified` : "",
    added > 0 ? `${added} added` : "",
    deleted > 0 ? `${deleted} deleted` : "",
    untracked > 0 ? `${untracked} untracked` : "",
  ]
    .filter(Boolean)
    .join(", ")

  let reason = `Uncommitted changes detected: ${summary} (${total} file(s))\n\n`
  reason += "Files with changes:\n"
  reason += lines
    .slice(0, 20)
    .map((l) => `  ${l}`)
    .join("\n")
  if (total > 20) reason += `\n  ... and ${total - 20} more file(s)`
  reason += "\n\n"

  if (behind > 0) {
    reason += `Note: branch '${branch}' is also ${behind} commit(s) behind '${upstream}' — after committing you will need to pull before pushing.\n\n`
  }

  return reason
}
