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

export type DetectRepoOwnershipOptions = Pick<
  CollaborationDetectionDependencies,
  "getRepoSlug" | "gh"
>

export interface DetectProjectCollaborationOptions extends CollaborationDetectionDependencies {
  nowMs?: number
}

export interface RepoOwnershipDetectionResult {
  currentUser: string | null
  isPersonalRepo: boolean
  repoName: string | null
  repoOwner: string | null
  repoSlug: string | null
  resolved: boolean
}

export interface ProjectCollaborationDetectionResult extends CollaborationPolicyResult {
  currentUser: string | null
  isPersonalRepo: boolean
  repoName: string | null
  repoOwner: string | null
  repoSlug: string | null
  resolved: boolean
}

const BOT_OR_AUTOMATION_LOGIN_RE = /(?:\[bot\]|dependabot|^claude$|^cursoragent$)/i
const ONE_DAY_MS = 24 * 60 * 60 * 1000

function normalizeLogin(login: string): string {
  return login.trim()
}

function canonicalLogin(login: string): string {
  return normalizeLogin(login).toLowerCase()
}

function isNullLike(login: string): boolean {
  return canonicalLogin(login) === "null"
}

function getComparableLoginParts(
  login: string | null | undefined
): { normalized: string; key: string } | null {
  if (typeof login !== "string") return null
  const normalized = normalizeLogin(login)
  if (!normalized || isNullLike(normalized)) return null
  return { normalized, key: canonicalLogin(normalized) }
}

function getCurrentUserKey(currentUser: string | null): string | null {
  return currentUser ? canonicalLogin(currentUser) : null
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
  const currentUserKey = getCurrentUserKey(currentUser)

  return dedupeLogins(logins).filter((login) => {
    const parts = getComparableLoginParts(login)
    if (!parts) return false
    if (currentUserKey && parts.key === currentUserKey) return false
    return !isAutomationLogin(parts.normalized)
  })
}

export function filterHumanOpenPullRequests(
  prs: OpenPullRequest[],
  currentUser: string | null
): OpenPullRequest[] {
  const currentUserKey = getCurrentUserKey(currentUser)

  return prs.filter((pr) => {
    const parts = getComparableLoginParts(pr.author?.login)
    if (!parts) return false
    if (currentUserKey && parts.key === currentUserKey) return false
    return !isAutomationLogin(parts.normalized)
  })
}

function getRecentContributorLogins(
  commits: GitHubCommit[] | null,
  dayAgoMs: number
): Array<string | null | undefined> {
  if (!commits) return []
  return commits
    .filter((commit) => {
      const timestamp = Date.parse(commit.commit.author.date)
      return Number.isFinite(timestamp) && timestamp > dayAgoMs
    })
    .map((commit) => commit.author?.login ?? null)
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

export function isPersonalRepo(repoOwner: string | null, currentUser: string | null): boolean {
  if (!repoOwner || !currentUser) return false
  return !isOrgRepo(repoOwner, currentUser)
}

export async function detectRepoOwnership(
  cwd: string,
  options: DetectRepoOwnershipOptions = {}
): Promise<RepoOwnershipDetectionResult> {
  const ghRunner = options.gh ?? gh
  const repoSlugResolver = options.getRepoSlug ?? getRepoSlug

  const [repoSlug, currentUserRaw] = await Promise.all([
    repoSlugResolver(cwd),
    ghRunner(["api", "user", "--jq", ".login"], cwd),
  ])

  const currentUser = currentUserRaw || null
  const { owner: repoOwner, repoName } = splitRepoSlug(repoSlug)

  return {
    currentUser,
    isPersonalRepo: isPersonalRepo(repoOwner, currentUser),
    repoName,
    repoOwner,
    repoSlug,
    resolved: repoOwner !== null && currentUser !== null,
  }
}

export async function detectProjectCollaborationPolicy(
  cwd: string,
  options: DetectProjectCollaborationOptions = {}
): Promise<ProjectCollaborationDetectionResult> {
  const ownership = await detectRepoOwnership(cwd, options)
  const ghJsonRunner = options.ghJson ?? ghJson

  const [openPullRequestsResult, commitsResult] = await Promise.all([
    ghJsonRunner<OpenPullRequest[]>(
      ["pr", "list", "--state", "open", "--json", "number,author", "--limit", "10"],
      cwd
    ),
    ownership.repoSlug
      ? ghJsonRunner<GitHubCommit[]>(["api", `repos/${ownership.repoSlug}/commits`], cwd)
      : null,
  ])

  const dayAgoMs = (options.nowMs ?? Date.now()) - ONE_DAY_MS
  const recentContributorLogins = getRecentContributorLogins(commitsResult ?? null, dayAgoMs)

  const policy = evaluateCollaborationPolicy({
    currentUser: ownership.currentUser,
    openPullRequests: openPullRequestsResult ?? [],
    recentContributorLogins,
    repoOwner: ownership.repoOwner,
  })

  const resolved = ownership.resolved && openPullRequestsResult !== null && commitsResult !== null

  return {
    ...policy,
    currentUser: ownership.currentUser,
    isPersonalRepo: ownership.isPersonalRepo,
    repoName: ownership.repoName,
    repoOwner: ownership.repoOwner,
    repoSlug: ownership.repoSlug,
    resolved,
  }
}
