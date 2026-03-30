import { debugLog } from "./debug.ts"
import { acquireGhSlot } from "./gh-rate-limit.ts"
import type { MutationPayload } from "./issue-store.ts"

// ─── GraphQL rate-limit classifier ─────────────────────────────────────────

/** Detect GraphQL rate-limit errors in gh CLI stderr output. */
export function isGraphQLRateLimited(stderr: string): boolean {
  return stderr.includes("API rate limit") && stderr.includes("GraphQL")
}

// ─── List REST fallback (issue/pr/run list) ─────────────────────────────────

export interface RestFallbackMapping {
  endpoint: string
  /** Transforms the raw REST response body into the shape expected by the caller. */
  normalize?: (raw: unknown) => unknown
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null
}

function getGhFlagValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag)
  if (index === -1 || index + 1 >= args.length) return null
  return args[index + 1] ?? null
}

function getRestListState(args: string[]): "open" | "closed" | "all" {
  const state = getGhFlagValue(args, "--state")
  if (state === "closed" || state === "all" || state === "open") return state
  return "open"
}

function getRestPerPage(args: string[], fallback: number): number {
  const raw = Number.parseInt(getGhFlagValue(args, "--limit") ?? "", 10)
  if (!Number.isFinite(raw) || raw < 1) return fallback
  return Math.min(raw, 100)
}

function buildRepoListEndpoint(
  resource: "issues" | "pulls",
  args: string[],
  fallbackPerPage = 100
): string {
  const params = new URLSearchParams({
    state: getRestListState(args),
    per_page: String(getRestPerPage(args, fallbackPerPage)),
  })
  return `repos/{owner}/{repo}/${resource}?${params.toString()}`
}

function normalizeRestUser(user: unknown): { login: string } | null {
  const record = asRecord(user)
  const login = typeof record?.login === "string" ? record.login : null
  return login ? { login } : null
}

function normalizeRestLabels(
  labels: unknown
): Array<{ name: string; color: string; description: string }> {
  if (!Array.isArray(labels)) return []
  return labels
    .map((label) => {
      const record = asRecord(label)
      const name = typeof record?.name === "string" ? record.name : null
      if (!name) return null
      return {
        name,
        color: typeof record?.color === "string" ? record.color : "",
        description: typeof record?.description === "string" ? record.description : "",
      }
    })
    .filter(
      (label): label is { name: string; color: string; description: string } => label !== null
    )
}

function normalizeRestAssignees(assignees: unknown): Array<{ login: string }> {
  if (!Array.isArray(assignees)) return []
  return assignees
    .map((assignee) => normalizeRestUser(assignee))
    .filter((assignee): assignee is { login: string } => assignee !== null)
}

function normalizeRestIssues(raw: unknown): Array<{
  number: number
  title: string
  state: string
  labels: Array<{ name: string; color: string; description: string }>
  author: { login: string } | null
  assignees: Array<{ login: string }>
  updatedAt: string
}> {
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry) => asRecord(entry))
    .filter(
      (issue): issue is Record<string, unknown> => issue !== null && !("pull_request" in issue)
    )
    .map((issue) => {
      const number = typeof issue.number === "number" ? issue.number : null
      const title = typeof issue.title === "string" ? issue.title : null
      const state = typeof issue.state === "string" ? issue.state : "open"
      const updatedAt = typeof issue.updated_at === "string" ? issue.updated_at : null
      if (!number || !title || !updatedAt) return null
      return {
        number,
        title,
        state,
        labels: normalizeRestLabels(issue.labels),
        author: normalizeRestUser(issue.user),
        assignees: normalizeRestAssignees(issue.assignees),
        updatedAt,
      }
    })
    .filter(
      (
        issue
      ): issue is {
        number: number
        title: string
        state: string
        labels: Array<{ name: string; color: string; description: string }>
        author: { login: string } | null
        assignees: Array<{ login: string }>
        updatedAt: string
      } => issue !== null
    )
}

function normalizeMergeable(value: unknown): string {
  if (typeof value === "string") return value
  if (value === true) return "MERGEABLE"
  if (value === false) return "CONFLICTING"
  return "UNKNOWN"
}

function extractRequiredPRFields(pr: Record<string, unknown>): {
  number: number | null
  title: string | null
  url: string | null
  createdAt: string | null
  updatedAt: string | null
} {
  return {
    number: typeof pr.number === "number" ? pr.number : null,
    title: typeof pr.title === "string" ? pr.title : null,
    url: typeof pr.html_url === "string" ? pr.html_url : null,
    createdAt: typeof pr.created_at === "string" ? pr.created_at : null,
    updatedAt: typeof pr.updated_at === "string" ? pr.updated_at : null,
  }
}

function extractOptionalPRFields(pr: Record<string, unknown>): {
  state: string
  headRefName: string | null
} {
  const state = typeof pr.state === "string" ? pr.state : "open"
  const head = asRecord(pr.head)
  const headRefName = typeof head?.ref === "string" ? head.ref : null
  return { state, headRefName }
}

function validatePullRequestFields(pr: Record<string, unknown>): {
  number: number
  title: string
  state: string
  url: string
  createdAt: string
  updatedAt: string
  headRefName: string
} | null {
  const required = extractRequiredPRFields(pr)
  const optional = extractOptionalPRFields(pr)

  if (
    !required.number ||
    !required.title ||
    !required.url ||
    !required.createdAt ||
    !required.updatedAt ||
    !optional.headRefName
  ) {
    return null
  }

  return {
    number: required.number,
    title: required.title,
    state: optional.state,
    url: required.url,
    createdAt: required.createdAt,
    updatedAt: required.updatedAt,
    headRefName: optional.headRefName,
  }
}

function normalizePullRequest(pr: Record<string, unknown>) {
  const fields = validatePullRequestFields(pr)
  if (!fields) return null

  return {
    number: fields.number,
    title: fields.title,
    state: fields.state,
    headRefName: fields.headRefName,
    author: normalizeRestUser(pr.user),
    reviewDecision: "",
    statusCheckRollup: [] as unknown[],
    mergeable: normalizeMergeable(pr.mergeable),
    url: fields.url,
    createdAt: fields.createdAt,
    updatedAt: fields.updatedAt,
  }
}

function normalizeRestPullRequests(raw: unknown): Array<{
  number: number
  title: string
  state: string
  headRefName: string
  author: { login: string } | null
  reviewDecision: string
  statusCheckRollup: unknown[]
  mergeable: string
  url: string
  createdAt: string
  updatedAt: string
}> {
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry) => asRecord(entry))
    .filter((pr): pr is Record<string, unknown> => pr !== null)
    .map((pr) => normalizePullRequest(pr))
    .filter(
      (
        pr
      ): pr is {
        number: number
        title: string
        state: string
        headRefName: string
        author: { login: string } | null
        reviewDecision: string
        statusCheckRollup: unknown[]
        mergeable: string
        url: string
        createdAt: string
        updatedAt: string
      } => pr !== null
    )
}

/**
 * Lookup table mapping `gh <entity> list` commands to REST API fallbacks.
 * The `normalize` function adapts REST response shapes to match gh CLI output shapes.
 */
const REST_FALLBACK_MAP: Record<string, RestFallbackMapping> = {
  "run:list": {
    endpoint: "repos/{owner}/{repo}/actions/runs?per_page=20",
    normalize: (raw) => {
      const data = raw as {
        workflow_runs?: Array<{
          head_sha: string
          id: number
          status: string
          conclusion: string | null
          html_url: string
        }>
      }
      return (data.workflow_runs ?? []).map((r) => ({
        headSha: r.head_sha,
        databaseId: r.id,
        status: r.status,
        conclusion: r.conclusion ?? "",
        url: r.html_url,
      }))
    },
  },
  "release:list": {
    endpoint: "repos/{owner}/{repo}/releases?per_page=30",
    normalize: (raw) => {
      const releases = raw as Array<{
        tag_name: string
        name: string
        draft: boolean
        prerelease: boolean
        published_at: string | null
        created_at: string
      }>
      return releases.map((r) => ({
        tagName: r.tag_name,
        name: r.name,
        isDraft: r.draft,
        isPrerelease: r.prerelease,
        publishedAt: r.published_at ?? r.created_at,
        createdAt: r.created_at,
      }))
    },
  },
  "label:list": { endpoint: "repos/{owner}/{repo}/labels?per_page=100" },
  "milestone:list": {
    endpoint: "repos/{owner}/{repo}/milestones?state=open&per_page=100",
    normalize: (raw) => {
      const milestones = raw as Array<{
        number: number
        title: string
        description: string | null
        state: string
        due_on: string | null
        open_issues: number
        closed_issues: number
      }>
      return milestones.map((m) => ({
        number: m.number,
        title: m.title,
        description: m.description ?? "",
        state: m.state,
        dueOn: m.due_on,
        openIssues: m.open_issues,
        closedIssues: m.closed_issues,
      }))
    },
  },
  "repo:list": {
    endpoint: "user/repos?per_page=100",
    normalize: (raw) => {
      const repos = raw as Array<{
        name: string
        full_name: string
        description: string | null
        private: boolean
        html_url: string
      }>
      return repos.map((r) => ({
        name: r.name,
        nameWithOwner: r.full_name,
        description: r.description ?? "",
        isPrivate: r.private,
        url: r.html_url,
      }))
    },
  },
  "workflow:list": {
    endpoint: "repos/{owner}/{repo}/actions/workflows?per_page=100",
    normalize: (raw) => {
      const data = raw as {
        workflows?: Array<{
          id: number
          name: string
          path: string
          state: string
        }>
      }
      return (data.workflows ?? []).map((w) => ({
        id: w.id,
        name: w.name,
        path: w.path,
        state: w.state,
      }))
    },
  },
  "secret:list": {
    endpoint: "repos/{owner}/{repo}/actions/secrets?per_page=100",
    normalize: (raw) => {
      const data = raw as {
        secrets?: Array<{
          name: string
          created_at: string
          updated_at: string
        }>
      }
      return (data.secrets ?? []).map((s) => ({
        name: s.name,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
      }))
    },
  },
  "variable:list": {
    endpoint: "repos/{owner}/{repo}/actions/variables?per_page=100",
    normalize: (raw) => {
      const data = raw as {
        variables?: Array<{
          name: string
          value: string
          created_at: string
          updated_at: string
        }>
      }
      return (data.variables ?? []).map((v) => ({
        name: v.name,
        value: v.value,
        createdAt: v.created_at,
        updatedAt: v.updated_at,
      }))
    },
  },
  "environment:list": {
    endpoint: "repos/{owner}/{repo}/environments?per_page=100",
    normalize: (raw) => {
      const data = raw as {
        environments?: Array<{
          id: number
          name: string
          created_at: string
          updated_at: string
        }>
      }
      return (data.environments ?? []).map((e) => ({
        id: e.id,
        name: e.name,
        createdAt: e.created_at,
        updatedAt: e.updated_at,
      }))
    },
  },
}

/**
 * Map a `gh <entity> list` command to its REST API fallback.
 * Returns null if the command has no REST equivalent.
 *
 * Exported for unit testing.
 */
export function ghListToRestFallback(args: string[]): RestFallbackMapping | null {
  if (args[0] === "issue" && args[1] === "list") {
    return {
      endpoint: buildRepoListEndpoint("issues", args),
      normalize: normalizeRestIssues,
    }
  }
  if (args[0] === "pr" && args[1] === "list") {
    return {
      endpoint: buildRepoListEndpoint("pulls", args),
      normalize: normalizeRestPullRequests,
    }
  }
  return REST_FALLBACK_MAP[`${args[0]}:${args[1]}`] ?? null
}

/** Fetch via REST API for a mapped gh list command. */
async function fetchViaRest(endpoint: string, cwd: string): Promise<unknown> {
  await acquireGhSlot()
  const proc = Bun.spawn(["gh", "api", endpoint], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  if (proc.exitCode !== 0) return null
  try {
    return JSON.parse(stdout)
  } catch {
    return null
  }
}

/**
 * Fetch a mapped gh list command via REST API.
 * Returns null if no REST mapping exists for the command or if REST fails.
 *
 * Exported for unit testing.
 */
export async function tryRestFallback<T>(args: string[], cwd: string): Promise<T | null> {
  const mapping = ghListToRestFallback(args)
  if (!mapping) {
    debugLog(`[swiz] NO_REST_FALLBACK for ${args.join(" ")} — no REST endpoint mapping registered`)
    return null
  }
  debugLog(`[swiz] REST_QUERY for ${args.join(" ")}`)
  const raw = await fetchViaRest(mapping.endpoint, cwd)
  if (raw === null) return null
  return (mapping.normalize ? mapping.normalize(raw) : raw) as T
}

// ─── Mutation REST fallback (used when GraphQL is rate-limited) ───────────

async function executeMutationCommand(
  args: string[],
  cwd: string,
  stdin?: Response
): Promise<boolean> {
  await acquireGhSlot()
  const proc = Bun.spawn(["gh", "api", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    ...(stdin && { stdin }),
  })
  await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  return proc.exitCode === 0
}

function buildCreateMutationArgs(
  mutation: MutationPayload,
  repo: string
): { args: string[]; stdin: Response } | null {
  if (!mutation.title) return null
  const payload: Record<string, unknown> = { title: mutation.title }
  if (mutation.body) payload.body = mutation.body
  if (mutation.labels?.length) payload.labels = mutation.labels
  return {
    args: [`repos/${repo}/issues`, "-X", "POST", "--input", "-"],
    stdin: new Response(JSON.stringify(payload)),
  }
}

function buildCommentMutationArgs(
  mutation: MutationPayload,
  repo: string,
  num: string
): { args: string[] } | null {
  if (!mutation.body) return null
  return { args: [`repos/${repo}/issues/${num}/comments`, "-f", `body=${mutation.body}`] }
}

function buildMutationArgs(
  mutation: MutationPayload,
  repo: string,
  num: string
): { args: string[]; stdin?: Response } | null {
  switch (mutation.type) {
    case "close":
      return { args: [`repos/${repo}/issues/${num}`, "-X", "PATCH", "-f", "state=closed"] }
    case "comment": {
      return buildCommentMutationArgs(mutation, repo, num)
    }
    case "label_add":
      if (!mutation.labels?.length) return null
      return {
        args: [`repos/${repo}/issues/${num}/labels`, "-X", "POST", "--input", "-"],
        stdin: new Response(JSON.stringify({ labels: mutation.labels })),
      }
    case "milestone_set":
      if (mutation.milestone == null) return null
      return {
        args: [
          `repos/${repo}/issues/${num}`,
          "-X",
          "PATCH",
          "-f",
          `milestone=${String(mutation.milestone)}`,
        ],
      }
    case "create":
      return buildCreateMutationArgs(mutation, repo)
    default:
      return null
  }
}

/** Attempt REST API fallback for a mutation when GraphQL is rate-limited. */
export async function tryMutationRestFallback(
  mutation: MutationPayload,
  cwd: string,
  repo: string
): Promise<boolean> {
  const num = String(mutation.number)
  debugLog(`[swiz] REST_FALLBACK_MUTATION repo=${repo} issue=#${num} type=${mutation.type}`)

  const cmd = buildMutationArgs(mutation, repo, num)
  if (!cmd) return mutation.type !== "create"

  return executeMutationCommand(cmd.args, cwd, cmd.stdin)
}
