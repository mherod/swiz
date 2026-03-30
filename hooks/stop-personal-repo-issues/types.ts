import type { ProjectState } from "../../src/settings.ts"

/** Ordered stop-hook sections; `conflict` embeds its own mini action plan in the reason text. */
export type StopSection = "feedbackPr" | "conflict" | "refinement" | "readyIssues" | "blocked"

export interface Issue {
  number: number
  title: string
  labels: Array<{ name: string }>
  author?: { login: string }
  assignees?: Array<{ login: string }>
  updatedAt?: string
}

export interface PR {
  number: number
  title: string
  url: string
  reviewDecision: string
  mergeable: string
  createdAt?: string
  closingIssuesReferences?: Array<{ number: number }>
}

export interface StopContext {
  cwd: string
  sessionId: string | null
  isPersonalRepo: boolean
  /** From `.swiz/state.json`; `null` when unset or unreadable — use legacy section order. */
  projectState: ProjectState | null
  changesRequestedPRs: PR[]
  reviewRequiredPRs: PR[]
  conflictingPRs: PR[]
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
