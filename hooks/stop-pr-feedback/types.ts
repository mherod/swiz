export interface PR {
  number: number
  title: string
  url: string
  reviewDecision: string
  mergeable: string
  createdAt?: string
  closingIssuesReferences?: Array<{ number: number }>
  author?: { login: string }
}

export interface RepoContext {
  cwd: string
  sessionId: string | null
  rawSessionId: string | undefined
  currentUser: string
  isPersonalRepo: boolean
}

export interface StopContext {
  cwd: string
  sessionId: string | null
  isPersonalRepo: boolean
  changesRequestedPRs: PR[]
  reviewRequiredPRs: PR[]
  conflictingPRs: PR[]
}
