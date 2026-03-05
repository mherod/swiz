import { getRepoSlug, gh, ghJson } from "./git-helpers.ts"

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

interface GitHubCommit {
  author?: { login?: string | null } | null
  commit: {
    author: {
      date: string
    }
  }
}

interface CollaborationDetectionDependencies {
  getRepoSlug?: (cwd: string) => Promise<string | null>
  gh?: (args: string[], cwd: string) => Promise<string>
  ghJson?: <T>(args: string[], cwd: string) => Promise<T | null>
}

export interface DetectProjectCollaborationOptions extends CollaborationDetectionDependencies {
  nowMs?: number
}

export interface ProjectCollaborationDetectionResult extends CollaborationPolicyResult {
  currentUser: string | null
  repoName: string | null
  repoOwner: string | null
  repoSlug: string | null
  resolved: boolean
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

function splitRepoSlug(repoSlug: string | null): { owner: string | null; repoName: string | null } {
  if (!repoSlug) return { owner: null, repoName: null }
  const [owner, repoName] = repoSlug.split("/", 2)
  if (!owner || !repoName) return { owner: null, repoName: null }
  return { owner, repoName }
}

export async function detectProjectCollaborationPolicy(
  cwd: string,
  options: DetectProjectCollaborationOptions = {}
): Promise<ProjectCollaborationDetectionResult> {
  const ghRunner = options.gh ?? gh
  const ghJsonRunner = options.ghJson ?? ghJson
  const repoSlugResolver = options.getRepoSlug ?? getRepoSlug

  const [repoSlug, currentUserRaw] = await Promise.all([
    repoSlugResolver(cwd),
    ghRunner(["api", "user", "--jq", ".login"], cwd),
  ])

  const currentUser = currentUserRaw || null
  const { owner: repoOwner, repoName } = splitRepoSlug(repoSlug)

  const [openPullRequestsResult, commitsResult] = await Promise.all([
    ghJsonRunner<OpenPullRequest[]>(
      ["pr", "list", "--state", "open", "--json", "number,author", "--limit", "10"],
      cwd
    ),
    repoSlug ? ghJsonRunner<GitHubCommit[]>(["api", `repos/${repoSlug}/commits`], cwd) : null,
  ])

  const dayAgoMs = (options.nowMs ?? Date.now()) - 24 * 60 * 60 * 1000
  const recentContributorLogins =
    commitsResult
      ?.filter((commit) => {
        const timestamp = Date.parse(commit.commit.author.date)
        return Number.isFinite(timestamp) && timestamp > dayAgoMs
      })
      .map((commit) => commit.author?.login ?? null) ?? []

  const policy = evaluateCollaborationPolicy({
    currentUser,
    openPullRequests: openPullRequestsResult ?? [],
    recentContributorLogins,
    repoOwner,
  })

  const resolved = currentUser !== null && openPullRequestsResult !== null && commitsResult !== null

  return {
    ...policy,
    currentUser,
    repoName,
    repoOwner,
    repoSlug,
    resolved,
  }
}
