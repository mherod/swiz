/**
 * Dashboard data types and normalizers for issue/PR records.
 * Extracted from web-server.ts to keep routing code focused.
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value
  }
  return null
}

function parseAssignees(raw: unknown): DashboardIssueActor[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry) => pickString(asObject(entry)?.login))
    .filter((login): login is string => login !== null)
    .map((login) => ({ login }))
}

function parseLabels(raw: unknown): DashboardIssueLabel[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry) => {
      const label = asObject(entry)
      const name = pickString(label?.name)
      if (!name) return null
      return { name, color: pickString(label?.color) }
    })
    .filter((label): label is DashboardIssueLabel => label !== null)
}

// ─── Issue types ─────────────────────────────────────────────────────────────

export interface DashboardIssueLabel {
  name: string
  color: string | null
}

export interface DashboardIssueActor {
  login: string
}

export interface DashboardIssueRecord {
  number: number
  title: string
  updatedAt: string | null
  state: string | null
  author: DashboardIssueActor | null
  assignees: DashboardIssueActor[]
  labels: DashboardIssueLabel[]
}

export function normalizeDashboardIssue(raw: unknown): DashboardIssueRecord | null {
  const issue = asObject(raw)
  if (!issue) return null
  if ("pull_request" in issue || "pullRequest" in issue) return null

  const number = typeof issue.number === "number" ? issue.number : null
  const title = pickString(issue.title)
  if (!number || !title) return null

  const authorObject = asObject(issue.author) ?? asObject(issue.user)
  const authorLogin = pickString(authorObject?.login)

  const assignees = parseAssignees(issue.assignees)
  const labels = parseLabels(issue.labels)

  return {
    number,
    title,
    updatedAt: pickString(issue.updatedAt, issue.updated_at),
    state: pickString(issue.state),
    author: authorLogin ? { login: authorLogin } : null,
    assignees,
    labels,
  }
}

export function issueUpdatedAtMs(updatedAt: string | null): number {
  if (!updatedAt) return 0
  const parsed = Date.parse(updatedAt)
  return Number.isFinite(parsed) ? parsed : 0
}

// ─── PR types ────────────────────────────────────────────────────────────────

export interface DashboardPrRecord {
  number: number
  title: string
  state: string | null
  headRefName: string | null
  url: string | null
  createdAt: string | null
  updatedAt: string | null
  author: DashboardIssueActor | null
  reviewDecision: string | null
  mergeable: string | null
}

export function normalizeDashboardPr(raw: unknown): DashboardPrRecord | null {
  const pr = asObject(raw)
  if (!pr) return null
  const number = typeof pr.number === "number" ? pr.number : null
  const title = pickString(pr.title)
  if (!number || !title) return null
  const authorObject = asObject(pr.author) ?? asObject(pr.user)
  const authorLogin = pickString(authorObject?.login)
  return {
    number,
    title,
    state: pickString(pr.state),
    headRefName: pickString(pr.headRefName),
    url: pickString(pr.url),
    createdAt: pickString(pr.createdAt),
    updatedAt: pickString(pr.updatedAt, pr.updated_at),
    author: authorLogin ? { login: authorLogin } : null,
    reviewDecision: pickString(pr.reviewDecision),
    mergeable: pickString(pr.mergeable),
  }
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const STALE_ISSUES_TTL_MS = 60 * 60 * 1000
