/**
 * Async issue store backed by the swiz daemon HTTP API.
 * Reads issues, PRs, and CI status via the daemon's /gh-query endpoint.
 *
 * Extracted from issue-store.ts (issue #423).
 */

import { getDaemonPort } from "./commands/daemon/daemon-admin.ts"
import type { IssueStoreReader } from "./issue-store.ts"
import {
  type GhPrBranchDetailSource,
  mapGhPrBranchDetail,
  type PrBranchDetail,
} from "./pr-branch-detail.ts"

const DAEMON_FALLBACK_PORT = getDaemonPort()
const DAEMON_FALLBACK_TIMEOUT_MS = 2_000
const DEFAULT_DAEMON_QUERY_TTL_MS = 300_000

/** `gh ... --json` for `issue view` / `pr view` returns a one-element array; normalize to a single object. */
function unwrapGhViewJson<T>(value: T | T[] | null | undefined): T | null {
  if (value == null) return null
  if (Array.isArray(value)) return (value[0] ?? null) as T | null
  return value as T
}

export class DaemonBackedIssueStore implements IssueStoreReader {
  private daemonAvailable: boolean | null = null

  constructor(
    /** @internal Override for tests — avoids mutating `globalThis.fetch` under concurrent test runs. */
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)
  ) {}

  /**
   * Query the daemon using the caller's cache window without capping it.
   * The five-minute default matches IssueStore, while explicit shorter fresh
   * reads and longer stale-serve reads retain their requested semantics.
   */
  private async query<T>(args: string[], ttlMs = DEFAULT_DAEMON_QUERY_TTL_MS): Promise<T | null> {
    if (this.daemonAvailable === false) return null
    try {
      const resp = await this.fetchImpl(`http://127.0.0.1:${DAEMON_FALLBACK_PORT}/gh-query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args, cwd: ".", ttlMs }),
        signal: AbortSignal.timeout(DAEMON_FALLBACK_TIMEOUT_MS),
      })
      if (!resp.ok) {
        this.daemonAvailable = false
        return null
      }
      this.daemonAvailable = true
      const data = (await resp.json()) as { value: T | null }
      return data.value
    } catch {
      this.daemonAvailable = false
      return null
    }
  }

  async listIssues<T = unknown>(repo: string, ttlMs = DEFAULT_DAEMON_QUERY_TTL_MS): Promise<T[]> {
    const result = await this.query<T[]>(
      [
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        "--json",
        "number,title,labels,author,assignees",
      ],
      ttlMs
    )
    return result ?? []
  }

  async listPullRequests<T = unknown>(
    repo: string,
    ttlMs = DEFAULT_DAEMON_QUERY_TTL_MS
  ): Promise<T[]> {
    const result = await this.query<T[]>(
      [
        "pr",
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        "--json",
        "number,title,state,headRefName,baseRefName,author,reviewDecision,statusCheckRollup,mergeable,requestedReviewers,url,createdAt,updatedAt",
      ],
      ttlMs
    )
    return result ?? []
  }

  async getIssue<T = unknown>(repo: string, number: number): Promise<T | null> {
    const result = await this.query<T | T[]>([
      "issue",
      "view",
      "--repo",
      repo,
      String(number),
      "--json",
      "number,title,labels,author,assignees,body,state",
    ])
    return unwrapGhViewJson(result) as T | null
  }

  async getPullRequest<T = unknown>(repo: string, number: number): Promise<T | null> {
    const result = await this.query<T | T[]>([
      "pr",
      "view",
      String(number),
      "--repo",
      repo,
      "--json",
      "number,title,state,headRefName,baseRefName,author,reviewDecision,statusCheckRollup,mergeable,url,createdAt,updatedAt,body",
    ])
    return unwrapGhViewJson(result) as T | null
  }

  async getCiStatus<T = unknown>(repo: string, sha: string): Promise<T | null> {
    const runs = await this.query<
      {
        databaseId: number
        status: string
        conclusion: string
        url: string
        headSha?: string
      }[]
    >([
      "run",
      "list",
      "--repo",
      repo,
      "--commit",
      sha,
      "--json",
      "databaseId,status,conclusion,url,headSha",
      "--limit",
      "5",
    ])
    if (!runs?.length) return null
    const r = runs[0]!
    const mapped = {
      sha: r.headSha ?? sha,
      run_id: r.databaseId,
      status: r.status,
      conclusion: r.conclusion,
      url: r.url,
    }
    return mapped as T
  }

  async getCiBranchRuns<T = unknown>(repo: string, branch: string): Promise<T[] | null> {
    const runs = await this.query<T[]>([
      "run",
      "list",
      "--repo",
      repo,
      "--branch",
      branch,
      "--limit",
      "10",
      "--json",
      "databaseId,status,conclusion,workflowName,createdAt,event",
    ])
    return runs ?? null
  }

  async getPrBranchDetail<T = PrBranchDetail>(repo: string, branch: string): Promise<T | null> {
    const raw = await this.query<GhPrBranchDetailSource | null>([
      "pr",
      "view",
      branch,
      "--repo",
      repo,
      "--json",
      "reviewDecision,requestedReviewers,comments,reviews,mergeable",
    ])
    const fresh = unwrapGhViewJson(raw)
    if (!fresh) return null
    return mapGhPrBranchDetail(fresh) as T
  }

  async listIssueComments<T = unknown>(repo: string, issueNumber: number): Promise<T[] | null> {
    const comments = await this.query<T[]>([
      "issue",
      "view",
      "--repo",
      repo,
      String(issueNumber),
      "--json",
      "comments",
      "--jq",
      ".comments",
    ])
    return comments ?? null
  }

  async getLatestCommentAt(repo: string, issueNumber: number): Promise<number | null> {
    const comments = await this.listIssueComments<{
      createdAt?: string
      updatedAt?: string
    }>(repo, issueNumber)
    if (!comments?.length) return null
    const last = comments[comments.length - 1]
    const ts = last?.updatedAt ?? last?.createdAt ?? null
    return ts ? new Date(ts).getTime() : null
  }

  async listLabels<T = unknown>(repo: string, ttlMs = DEFAULT_DAEMON_QUERY_TTL_MS): Promise<T[]> {
    const result = await this.query<T[]>(
      ["label", "list", "--repo", repo, "--json", "name,color,description", "--limit", "100"],
      ttlMs
    )
    return result ?? []
  }

  async listMilestones<T = unknown>(
    repo: string,
    ttlMs = DEFAULT_DAEMON_QUERY_TTL_MS
  ): Promise<T[]> {
    const result = await this.query<T[]>(
      ["api", `repos/${repo}/milestones?state=open&per_page=100`],
      ttlMs
    )
    return result ?? []
  }

  async getBranchProtection<T = unknown>(repo: string, branch: string): Promise<T | null> {
    const result = await this.query<T>([
      "api",
      `repos/${repo}/branches/${encodeURIComponent(branch)}/protection`,
    ])
    return result ?? null
  }

  async listSessionEdits<T = unknown>(projectKey: string, sessionId: string): Promise<T[]> {
    if (this.daemonAvailable === false) return [] as T[]
    try {
      const resp = await this.fetchImpl(
        `http://127.0.0.1:${DAEMON_FALLBACK_PORT}/session-edits/list`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectKey, sessionId }),
          signal: AbortSignal.timeout(DAEMON_FALLBACK_TIMEOUT_MS),
        }
      )
      if (!resp.ok) {
        return [] as T[]
      }
      const data = (await resp.json()) as { edits: T[] }
      return (data.edits ?? []) as T[]
    } catch {
      return [] as T[]
    }
  }

  get isDaemonAvailable(): boolean | null {
    return this.daemonAvailable
  }
}

let sharedDaemonStore: DaemonBackedIssueStore | null = null

/** Get a shared DaemonBackedIssueStore instance for async reads via daemon HTTP API. */
export function getDaemonBackedStore(): DaemonBackedIssueStore {
  if (!sharedDaemonStore) {
    sharedDaemonStore = new DaemonBackedIssueStore()
  }
  return sharedDaemonStore
}

/** Reset the shared daemon store (for testing). */
export function resetDaemonBackedStore(): void {
  sharedDaemonStore = null
}
