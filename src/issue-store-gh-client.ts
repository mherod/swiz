/**
 * Default `GitHubClient` implementation that delegates to `fetchGhJson`
 * (REST-primary with gh CLI fallback).
 *
 * Extracted from issue-store.ts (issue #423).
 */

import type {
  GitHubCiRunRecord,
  GitHubClient,
  GitHubCommentRecord,
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
        : "number,title,state,headRefName,author,reviewDecision,statusCheckRollup,mergeable,url,createdAt,updatedAt"
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
}
