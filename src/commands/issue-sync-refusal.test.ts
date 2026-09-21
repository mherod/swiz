import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import * as gitHelpers from "../git-helpers.ts"
import {
  GhCliGitHubClient,
  getIssueStore,
  type IssueStore,
  resetIssueStore,
} from "../issue-store.ts"
import { syncUpstreamState } from "../issue-store-sync.ts"
import * as gitUtils from "../utils/git-utils.ts"
import { runCommandInProcess } from "../utils/test-utils.ts"
import { issueCommand } from "./issue.ts"

const targetRepo = "owner/target"
const cwdRepo = "owner/checkout"
const lastSynced = "2024-01-01T00:00:00.000Z"

describe("cross-repository issue sync refusal (#939)", () => {
  let store: IssueStore
  let fetches: ReturnType<typeof mock>[]

  beforeEach(() => {
    resetIssueStore()
    store = getIssueStore(":memory:")
    store.upsertIssues(targetRepo, [{ number: 42, title: "Cached issue", state: "OPEN" }])
    store.upsertPullRequests(targetRepo, [{ number: 84, title: "Cached PR", state: "OPEN" }])
    store.setSyncCursor(targetRepo, "last_synced", lastSynced)
    spyOn(gitHelpers, "getRepoSlug").mockResolvedValue(cwdRepo)
    spyOn(gitUtils, "getDefaultBranch").mockResolvedValue("main")

    // A real sync with authoritative empty responses would purge the seeded rows.
    // Mock every network boundary so a broken invariant cannot reach GitHub.
    const client = GhCliGitHubClient.prototype
    fetches = [
      spyOn(client, "listIssues").mockResolvedValue([]),
      spyOn(client, "listPullRequests").mockResolvedValue([]),
      spyOn(client, "listWorkflowRuns").mockResolvedValue([]),
      spyOn(client, "listIssueComments").mockResolvedValue([]),
      spyOn(client, "listIssueDiscussion").mockResolvedValue([]),
      spyOn(client, "listPullRequestReviews").mockResolvedValue([]),
      spyOn(client, "listLabels").mockResolvedValue([]),
      spyOn(client, "listMilestones").mockResolvedValue([]),
      spyOn(client, "listBranchWorkflowRuns").mockResolvedValue([]),
      spyOn(client, "getBranchProtection").mockResolvedValue(null),
      spyOn(client, "listIssueEventsSince").mockResolvedValue([]),
    ]
  })

  afterEach(() => {
    mock.restore()
    resetIssueStore()
  })

  function expectUntouchedCache(): void {
    expect(store.getIssueRaw(targetRepo, 42)).toBe(
      JSON.stringify({ number: 42, title: "Cached issue", state: "OPEN" })
    )
    expect(store.getPullRequestRaw(targetRepo, 84)).toBe(
      JSON.stringify({ number: 84, title: "Cached PR", state: "OPEN" })
    )
    expect(store.getSyncCursor(targetRepo, "last_synced")).toBe(lastSynced)
    for (const fetch of fetches) expect(fetch).not.toHaveBeenCalled()
  }

  test("returns both repository identities without fetching or changing cached data", async () => {
    const result = await syncUpstreamState(targetRepo, process.cwd(), { store })
    expect(result).toMatchObject({
      refused: { cwdRepo, targetRepo },
      fetchOk: false,
      issues: { upserted: 0, removed: 0 },
      pullRequests: { upserted: 0, removed: 0 },
    })
    expectUntouchedCache()
  })

  test.each(["sync", "list"])("reports %s refusal as a command error", async (command) => {
    // Force the list's existing one-hour cache policy to request a refresh.
    if (command === "list") spyOn(Date, "now").mockReturnValue(Date.now() + 7_200_000)
    const args = command === "sync" ? [command, targetRepo, "--force"] : [command, targetRepo]
    const result = await runCommandInProcess(issueCommand, args)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(targetRepo)
    expect(result.stderr).toContain(cwdRepo)
    expect(result.stderr).toContain("Run from the target repository's checkout")
    expect(result.stdout).not.toContain("✅")
    expect(result.stdout).not.toContain("Open Issues")
    expectUntouchedCache()
  })

  test("reports refusal when the target has no cached rows", async () => {
    store.clearCachedData(targetRepo)
    const result = await runCommandInProcess(issueCommand, ["list", targetRepo])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(targetRepo)
    expect(result.stderr).toContain(cwdRepo)
    expect(result.stdout).not.toContain("Open Issues")
    for (const fetch of fetches) expect(fetch).not.toHaveBeenCalled()
  })

  test.each([
    "sync",
    "list",
  ])("reuses fresh cached data for %s from another checkout", async (command) => {
    store.setSyncCursor(targetRepo, "last_synced", new Date().toISOString())
    const result = await runCommandInProcess(issueCommand, [command, targetRepo])
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("Cached issue")
    expect(result.stdout).toContain("Cached PR")
    for (const fetch of fetches) expect(fetch).not.toHaveBeenCalled()
  })

  test.each([
    "matching origin",
    "targeted client",
    "unknown origin",
  ])("preserves successful empty-sync behavior with %s", async (mode) => {
    if (mode === "matching origin") spyOn(gitHelpers, "getRepoSlug").mockResolvedValue(targetRepo)
    if (mode === "unknown origin") spyOn(gitHelpers, "getRepoSlug").mockResolvedValue(null)
    const client = mode === "targeted client" ? new GhCliGitHubClient() : undefined
    const result = await syncUpstreamState(targetRepo, process.cwd(), { store, client })
    expect(result.fetchOk).toBe(true)
    expect(result).not.toHaveProperty("refused")
    expect(result.issues.removed).toBe(1)
    expect(result.pullRequests.removed).toBe(1)
    expect(store.listIssues(targetRepo)).toEqual([])
    expect(store.listPullRequests(targetRepo)).toEqual([])
    expect(store.getSyncCursor(targetRepo, "last_synced")).not.toBe(lastSynced)
    expect(fetches[0]).toHaveBeenCalled()
  })
})
