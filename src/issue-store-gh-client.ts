/**
 * Default `GitHubClient` implementation that delegates to `fetchGhJson`
 * (REST-primary with gh CLI fallback).
 *
 * Extracted from issue-store.ts (issue #423).
 */

import { acquireGhSlot } from "./gh-rate-limit.ts"
import type {
  GitHubBranchProtectionRecord,
  GitHubCiRunRecord,
  GitHubClient,
  GitHubCommentRecord,
  GitHubIssueEventRecord,
  GitHubIssueRecord,
  GitHubLabelRecord,
  GitHubMilestoneRecord,
  GitHubPullRequestRecord,
} from "./issue-store.ts"
import { fetchGhJson } from "./issue-store.ts"

export class GhCliGitHubClient implements GitHubClient {
  /**
   * List issues via `gh issue list`. When `state` is `"closed"`, only the
   * `number` field is populated (minimal fetch for stale-row purging in
   * `syncUpstreamState`). All other record fields will be `undefined`.
   */
  async listIssues(cwd: string, state: "open" | "closed"): Promise<GitHubIssueRecord[] | null> {
    const limit = state === "closed" ? "30" : "100"
    const fields =
      state === "closed" ? "number" : "number,title,state,labels,author,assignees,updatedAt"
    return fetchGhJson<GitHubIssueRecord[]>(
      ["issue", "list", "--state", state, "--json", fields, "--limit", limit],
      cwd
    )
  }

  /**
   * List PRs via `gh pr list`. When `state` is `"closed"`, only the
   * `number` field is populated (minimal fetch for stale-row purging in
   * `syncUpstreamState`). All other record fields will be `undefined`.
   */
  async listPullRequests(
    cwd: string,
    state: "open" | "closed"
  ): Promise<GitHubPullRequestRecord[] | null> {
    const limit = state === "closed" ? "30" : "100"
    const fields =
      state === "closed"
        ? "number"
        : "number,title,state,headRefName,author,reviewDecision,statusCheckRollup,mergeable,requestedReviewers,url,createdAt,updatedAt"
    return fetchGhJson<GitHubPullRequestRecord[]>(
      ["pr", "list", "--state", state, "--json", fields, "--limit", limit],
      cwd
    )
  }

  async listWorkflowRuns(cwd: string): Promise<GitHubCiRunRecord[] | null> {
    return fetchGhJson<GitHubCiRunRecord[]>(
      ["run", "list", "--json", "headSha,databaseId,status,conclusion,url", "--limit", "20"],
      cwd
    )
  }

  async listIssueComments(cwd: string, issueNumber: number): Promise<GitHubCommentRecord[] | null> {
    return fetchGhJson<GitHubCommentRecord[]>(
      ["issue", "view", String(issueNumber), "--json", "comments", "--jq", ".comments"],
      cwd
    )
  }

  async listLabels(cwd: string): Promise<GitHubLabelRecord[] | null> {
    return fetchGhJson<GitHubLabelRecord[]>(
      ["label", "list", "--json", "name,color,description", "--limit", "100"],
      cwd
    )
  }

  async listMilestones(cwd: string): Promise<GitHubMilestoneRecord[] | null> {
    return fetchGhJson<GitHubMilestoneRecord[]>(
      [
        "milestone",
        "list",
        "--json",
        "number,title,description,state,dueOn,openIssues,closedIssues",
        "--limit",
        "100",
      ],
      cwd
    )
  }

  async listBranchWorkflowRuns(cwd: string, branch: string): Promise<GitHubCiRunRecord[] | null> {
    return fetchGhJson<GitHubCiRunRecord[]>(
      [
        "run",
        "list",
        "--branch",
        branch,
        "--json",
        "headSha,databaseId,status,conclusion,url",
        "--limit",
        "10",
      ],
      cwd
    )
  }

  async getBranchProtection(
    cwd: string,
    branch: string
  ): Promise<GitHubBranchProtectionRecord | null> {
    await acquireGhSlot()
    const proc = Bun.spawn(
      ["gh", "api", `repos/{owner}/{repo}/branches/${encodeURIComponent(branch)}/protection`],
      { cwd, stdout: "pipe", stderr: "pipe" }
    )
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    if (proc.exitCode !== 0) {
      // 404 = no protection rules configured; 403 = insufficient permissions
      void stderr
      return null
    }
    try {
      const raw = JSON.parse(stdout) as Record<string, any>
      return normalizeBranchProtection(branch, raw)
    } catch {
      return null
    }
  }

  /**
   * Fetch repo-wide issue events via `gh api repos/{slug}/issues/events`.
   *
   * GitHub's `/issues/events` endpoint does not accept a `since` query param
   * (that lives on `/issues`), so this implementation fetches a single 100-row
   * page (newest first) and client-side filters by `created_at > sinceIso`.
   * That is sufficient for incremental append-only replay as long as sync
   * cadence keeps up — a future follow-up can add `--paginate` with a cutoff
   * loop when we start caring about deep historical backfill.
   *
   * `repo` is the full `owner/name` slug (not a cwd) because `gh api` takes
   * the slug directly and does not infer it from working directory.
   */
  async listIssueEventsSince(
    repo: string,
    sinceIso: string | null
  ): Promise<GitHubIssueEventRecord[] | null> {
    await acquireGhSlot()
    const proc = Bun.spawn(["gh", "api", `repos/${repo}/issues/events?per_page=100`], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    if (proc.exitCode !== 0) {
      void stderr
      return null
    }
    try {
      const events = JSON.parse(stdout) as GitHubIssueEventRecord[]
      if (!Array.isArray(events)) return null
      if (!sinceIso) return events
      return events.filter((e) => typeof e.created_at === "string" && e.created_at > sinceIso)
    } catch {
      return null
    }
  }
}

/** Extract the `enabled` boolean from a `{ enabled: boolean }` REST sub-object. */
function enabledFlag(value: unknown): boolean {
  return (value as { enabled?: boolean } | undefined)?.enabled ?? false
}

function normalizeRequiredReviews(
  raw: Record<string, any> | undefined
): GitHubBranchProtectionRecord["requiredReviews"] {
  if (!raw) return undefined
  return {
    requiredApprovingReviewCount: (raw.required_approving_review_count as number) ?? 0,
    dismissStaleReviews: (raw.dismiss_stale_reviews as boolean) ?? false,
    requireCodeOwnerReviews: (raw.require_code_owner_reviews as boolean) ?? false,
  }
}

function normalizeRequiredStatusChecks(
  raw: Record<string, any> | undefined
): GitHubBranchProtectionRecord["requiredStatusChecks"] {
  if (!raw) return undefined
  return {
    strict: (raw.strict as boolean) ?? false,
    contexts: (raw.contexts as string[]) ?? [],
  }
}

/** Normalize GitHub REST branch protection response to our record shape. */
function normalizeBranchProtection(
  branch: string,
  raw: Record<string, any>
): GitHubBranchProtectionRecord {
  return {
    branch,
    requiredReviews: normalizeRequiredReviews(
      raw.required_pull_request_reviews as Record<string, any> | undefined
    ),
    requiredStatusChecks: normalizeRequiredStatusChecks(
      raw.required_status_checks as Record<string, any> | undefined
    ),
    enforceAdmins: enabledFlag(raw.enforce_admins),
    requiredLinearHistory: enabledFlag(raw.required_linear_history),
    allowForcePushes: enabledFlag(raw.allow_force_pushes),
    allowDeletions: enabledFlag(raw.allow_deletions),
  }
}
