/**
 * Shared issue-hint fetcher used by both PreToolUse and PostToolUse hooks
 * to suggest open GitHub issues when the task planning buffer is thin.
 *
 * Reads exclusively from the local SQLite cache — no network calls — so it
 * is safe to call from blocking PreToolUse hooks. Falls back silently on
 * any error so governance messages are never blocked by hint failures.
 */

import { getRepoSlug } from "../git-helpers.ts"
import { getIssueStore } from "../issue-store.ts"

/** Labels that indicate an issue is not actionable for the current session. */
export const SKIP_LABELS_LOWER = new Set([
  "blocked",
  "upstream",
  "wontfix",
  "wont-fix",
  "duplicate",
  "on-hold",
  "waiting",
  "stale",
  "icebox",
  "invalid",
  "needs-info",
])

type IssueHintRecord = {
  number: number
  title: string
  labels: Array<{ name: string }>
}

function filterAndFormat(issues: IssueHintRecord[], limit: number): string[] {
  const hints: string[] = []
  for (const issue of issues) {
    if (hints.length >= limit) break
    const skip = (issue.labels ?? []).some((l) => SKIP_LABELS_LOWER.has(l.name.toLowerCase()))
    if (skip) continue
    hints.push(`#${issue.number} ${issue.title}`)
  }
  return hints
}

/**
 * Return up to `limit` open issue titles from the SQLite cache.
 * Uses a 24-hour TTL so hints survive between daemon sync cycles.
 * Returns [] on any error (fail-open).
 */
export async function fetchIssueHints(cwd: string | undefined, limit = 3): Promise<string[]> {
  if (!cwd) return []
  try {
    const slug = await getRepoSlug(cwd)
    if (!slug) return []

    const store = getIssueStore()
    const HINT_TTL_MS = 24 * 60 * 60 * 1000
    const issues = store.listIssues<IssueHintRecord>(slug, HINT_TTL_MS)
    return filterAndFormat(issues, limit)
  } catch {
    return []
  }
}
