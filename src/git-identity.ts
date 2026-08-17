import { debugLog } from "./debug.ts"
import { git, gitAttempt } from "./git-helpers.ts"
import { type GitRepoResolver, isGitRepoForHookPayload } from "./repository-capability.ts"

interface GitIdentity {
  name: string
  email: string
}

interface GitIdentityCheck {
  ok: boolean
  isGitRepo: boolean
  identity: GitIdentity
  problems: string[]
  /** False when git config could not be read at all, making the result inconclusive. */
  readable?: boolean
}

interface HeadCommitIdentityCheck extends GitIdentityCheck {
  head?: {
    author: GitIdentity
    committer: GitIdentity
  }
}

const PLACEHOLDER_NAMES = new Set([
  "test",
  "test user",
  "example",
  "example user",
  "fake",
  "fake user",
  "dummy",
  "dummy user",
  "unknown",
  "your name",
])

const PLACEHOLDER_EMAIL_RE = [
  /^test@/i,
  /@test\./i,
  /@example\./i,
  /\.invalid$/i,
  /^you@example\./i,
  /^user@example\./i,
  /^dummy@/i,
  /^fake@/i,
]

function normalize(value: string): string {
  return value.trim()
}

function normalizeEmail(value: string): string {
  return normalize(value).toLowerCase()
}

function isPlaceholderName(name: string): boolean {
  return PLACEHOLDER_NAMES.has(normalize(name).toLowerCase())
}

function isPlaceholderEmail(email: string): boolean {
  const normalized = normalizeEmail(email)
  return PLACEHOLDER_EMAIL_RE.some((pattern) => pattern.test(normalized))
}

function validateGitIdentity(identity: GitIdentity, label = "git config"): string[] {
  const problems: string[] = []
  const name = normalize(identity.name)
  const email = normalize(identity.email)

  if (!name) problems.push(`${label} user.name is missing`)
  else if (isPlaceholderName(name)) problems.push(`${label} user.name is a placeholder`)

  if (!email) problems.push(`${label} user.email is missing`)
  else if (!email.includes("@")) problems.push(`${label} user.email is not an email address`)
  else if (isPlaceholderEmail(email)) problems.push(`${label} user.email is a placeholder`)

  return problems
}

async function readGitIdentity(cwd: string): Promise<{ identity: GitIdentity; readable: boolean }> {
  const [name, email] = await Promise.all([
    gitAttempt(["config", "--get", "user.name"], cwd),
    gitAttempt(["config", "--get", "user.email"], cwd),
  ])
  return {
    identity: { name: normalize(name.stdout), email: normalize(email.stdout) },
    readable: name.ran && email.ran,
  }
}

export async function checkGitIdentity(
  cwd: string,
  input: object = {},
  resolveGitRepo?: GitRepoResolver
): Promise<GitIdentityCheck> {
  const repo = await isGitRepoForHookPayload(input, cwd, resolveGitRepo)
  if (!repo) {
    return { ok: true, isGitRepo: false, identity: { name: "", email: "" }, problems: [] }
  }

  const { identity, readable } = await readGitIdentity(cwd)
  if (!readable) {
    // git could not run here — an unusable cwd or a failed spawn, not absent configuration.
    // Reporting "user.name is missing" would block the caller over a condition it cannot fix
    // and that no config change resolves, so treat an unreadable config as inconclusive.
    debugLog("[git-identity] git config unreadable; skipping identity validation for", cwd)
    return { ok: true, isGitRepo: true, identity, problems: [], readable: false }
  }

  const problems = validateGitIdentity(identity)
  return { ok: problems.length === 0, isGitRepo: true, identity, problems, readable: true }
}

function identitiesMatch(left: GitIdentity, right: GitIdentity): boolean {
  return (
    normalize(left.name) === normalize(right.name) &&
    normalizeEmail(left.email) === normalizeEmail(right.email)
  )
}

function parseHeadIdentity(raw: string): HeadCommitIdentityCheck["head"] | null {
  const [authorName, authorEmail, committerName, committerEmail] = raw.split("\0")
  if (!authorName || !authorEmail || !committerName || !committerEmail) return null
  return {
    author: { name: normalize(authorName), email: normalize(authorEmail) },
    committer: { name: normalize(committerName), email: normalize(committerEmail) },
  }
}

export async function checkHeadCommitIdentity(
  cwd: string,
  input: object = {},
  resolveGitRepo?: GitRepoResolver
): Promise<HeadCommitIdentityCheck> {
  const config = await checkGitIdentity(cwd, input, resolveGitRepo)
  if (!config.isGitRepo) return { ...config, ok: true }

  const raw = await git(["log", "-1", "--format=%an%x00%ae%x00%cn%x00%ce", "HEAD"], cwd)
  const head = parseHeadIdentity(raw)
  if (!head) return { ...config, ok: false, problems: ["HEAD commit identity could not be read"] }

  const problems = [
    ...config.problems,
    ...validateGitIdentity(head.author, "HEAD author"),
    ...validateGitIdentity(head.committer, "HEAD committer"),
  ]

  if (!identitiesMatch(head.author, config.identity)) {
    problems.push("HEAD author does not match git config user.name/user.email")
  }
  if (!identitiesMatch(head.committer, config.identity)) {
    problems.push("HEAD committer does not match git config user.name/user.email")
  }

  return { ...config, head, ok: problems.length === 0, problems }
}
