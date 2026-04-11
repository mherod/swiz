import type { ProjectState } from "../../src/settings.ts"

/** Ordered stop-hook sections for issue-focused flow. */
export type StopSection = "refinement" | "readyIssues" | "blocked"

export interface Issue {
  number: number
  title: string
  labels: Array<{ name: string }>
  author?: { login: string }
  assignees?: Array<{ login: string }>
  updatedAt?: string
  /**
   * Upstream issue state (`"open"` | `"closed"`). Optional only because
   * legacy cached rows pre-date this field; new fetches always include it
   * and `readCachedIssues` filters out anything not equal to `"open"`.
   */
  state?: string
}

export interface StopContext {
  cwd: string
  sessionId: string | null
  isPersonalRepo: boolean
  /** From `.swiz/state.json`; `null` when unset or unreadable — use legacy section order. */
  projectState: ProjectState | null
  sortedRefinement: Issue[]
  sortedIssues: Issue[]
  blockedIssues: Issue[]
  firstRefinementNum?: number
  firstIssueNum?: number
  /** When true, omit "merge existing PR" guidance from issue-pickup steps. */
  strictNoDirectMain: boolean
}

export interface RepoContext {
  cwd: string
  sessionId: string | null
  rawSessionId: string | undefined
  currentUser: string
  isPersonalRepo: boolean
}
