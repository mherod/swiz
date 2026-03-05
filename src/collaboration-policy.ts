export interface OpenPullRequest {
  author?: { login?: string | null } | null
}

export interface CollaborationPolicyInput {
  currentUser: string | null
  openPullRequests: OpenPullRequest[]
  recentContributorLogins: Array<string | null | undefined>
  repoOwner: string | null
}

export interface CollaborationPolicyResult {
  isCollaborative: boolean
  isOrgRepo: boolean
  openPullRequestCount: number
  otherContributors: string[]
  signals: string[]
}

const BOT_OR_AUTOMATION_LOGIN_RE = /(?:\[bot\]|dependabot|^claude$|^cursoragent$)/i

function normalizeLogin(login: string): string {
  return login.trim()
}

function canonicalLogin(login: string): string {
  return normalizeLogin(login).toLowerCase()
}

function isNullLike(login: string): boolean {
  return canonicalLogin(login) === "null"
}

function dedupeLogins(logins: Array<string | null | undefined>): string[] {
  const seen = new Set<string>()
  const unique: string[] = []

  for (const login of logins) {
    if (typeof login !== "string") continue
    const normalized = normalizeLogin(login)
    if (!normalized || isNullLike(normalized)) continue
    const key = canonicalLogin(normalized)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(normalized)
  }

  return unique
}

export function isAutomationLogin(login: string | null | undefined): boolean {
  if (typeof login !== "string") return false
  const normalized = normalizeLogin(login)
  if (!normalized) return false
  return BOT_OR_AUTOMATION_LOGIN_RE.test(normalized)
}

export function isOrgRepo(repoOwner: string | null, currentUser: string | null): boolean {
  if (!repoOwner || !currentUser) return false
  return canonicalLogin(repoOwner) !== canonicalLogin(currentUser)
}

export function filterHumanContributorLogins(
  logins: Array<string | null | undefined>,
  currentUser: string | null
): string[] {
  const currentUserKey = currentUser ? canonicalLogin(currentUser) : null

  return dedupeLogins(logins).filter((login) => {
    const key = canonicalLogin(login)
    if (currentUserKey && key === currentUserKey) return false
    return !isAutomationLogin(login)
  })
}

export function filterHumanOpenPullRequests(
  prs: OpenPullRequest[],
  currentUser: string | null
): OpenPullRequest[] {
  const currentUserKey = currentUser ? canonicalLogin(currentUser) : null

  return prs.filter((pr) => {
    const login = pr.author?.login
    if (typeof login !== "string") return false
    const normalized = normalizeLogin(login)
    if (!normalized || isNullLike(normalized)) return false
    const key = canonicalLogin(normalized)
    if (currentUserKey && key === currentUserKey) return false
    return !isAutomationLogin(normalized)
  })
}

export function evaluateCollaborationPolicy(
  input: CollaborationPolicyInput
): CollaborationPolicyResult {
  const orgRepo = isOrgRepo(input.repoOwner, input.currentUser)
  const otherContributors = filterHumanContributorLogins(
    input.recentContributorLogins,
    input.currentUser
  )
  const humanOpenPrs = filterHumanOpenPullRequests(input.openPullRequests, input.currentUser)

  const signals: string[] = []
  if (orgRepo) signals.push("Organization repository (not a personal repo)")
  if (humanOpenPrs.length > 0) {
    signals.push(`${humanOpenPrs.length} open pull request(s)`)
  }
  if (otherContributors.length > 0) {
    signals.push(`Other contributors active in last 24h: ${otherContributors.join(", ")}`)
  }

  return {
    isCollaborative: signals.length > 0,
    isOrgRepo: orgRepo,
    openPullRequestCount: humanOpenPrs.length,
    otherContributors,
    signals,
  }
}
