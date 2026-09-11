import { describe, expect, test } from "bun:test"
import { buildGitStopAction } from "../hooks/stop-git-status/next-action.ts"
import type { GitContext } from "../hooks/stop-git-status/types.ts"
import { buildIssueStopAction } from "../hooks/stop-personal-repo-issues/action-plan.ts"
import type { StopContext } from "../hooks/stop-personal-repo-issues/types.ts"
import { processAggregatedStopResults } from "./dispatch/blockingStrategy.ts"
import { stripInternalDispatchFields } from "./dispatch/dispatch-wire.ts"
import type { HookExecution } from "./dispatch/engine.ts"
import {
  readStopActions,
  renderStopAction,
  type StopAction,
  selectStopAction,
} from "./stop-actions.ts"

const gitContext: GitContext = {
  cwd: "/fixture",
  sessionId: "session",
  summary: "Four commits ahead",
  hasUncommitted: false,
  hasRemote: true,
  upstream: "origin/main",
  collabMode: "solo",
  pushCooldownMinutes: 0,
  defaultBranch: "main",
  trunkMode: true,
  ownership: { known: true, ownership: { editedByUs: [], editedByOthers: [], unattributed: [] } },
  gitStatus: {
    branch: "main",
    total: 0,
    modified: 0,
    added: 0,
    deleted: 0,
    untracked: 0,
    lines: [],
    ahead: 4,
    behind: 0,
    upstream: "origin/main",
    upstreamGone: false,
  },
}
const issues: StopContext = {
  cwd: "/fixture",
  sessionId: "session",
  isPersonalRepo: true,
  projectState: "developing",
  sortedRefinement: [],
  blockedIssues: [],
  strictNoDirectMain: false,
  defaultBranch: "main",
  sortedIssues: Array.from({ length: 67 }, (_, n) => ({
    number: 2733 + n,
    title: `Issue ${n}`,
    labels: [],
  })),
}
const push = buildGitStopAction(gitContext)!
const issue = buildIssueStopAction(issues)!
const handoff: StopAction = {
  ...push,
  id: "handoff",
  kind: "handoff",
  title: "Complete handoff",
  instruction: "Run /end-of-day.",
}

function finding(action: StopAction) {
  return { file: "test.ts", reason: "Full diagnostic", actions: [action] }
}

describe("focused stop actions", () => {
  test("reduces the four-check sample to one push, regardless of hook completion order", () => {
    const findings = [finding(issue), finding(push), finding(handoff), finding(push)]
    const selected = selectStopAction(findings)!
    expect(selectStopAction(findings.toReversed())).toEqual(selected)
    expect(selected.reason).toBe(renderStopAction(push))
    expect(selected.reason).toContain("Next: Publish 4 local commits")
    expect(selected.reason).toContain("configured trunk workflow on main")
    expect(selected.reason).toContain("Done when: Remote parity")
    expect(selected.reason.trim().split(/\s+/).length).toBeLessThanOrEqual(120)
    expect(selected.reason.match(/Run \/push/g)).toHaveLength(1)
    expect(selected.reason).not.toContain("2733")
    expect(selected.reason).not.toContain("end-of-day")
  })

  test("reassesses after the push and selects only one issue from the backlog", () => {
    expect(selectStopAction([finding(issue)])?.reason).toContain("#2733")
    expect(selectStopAction([finding(issue)])?.reason).not.toContain("#2734")
    expect(selectStopAction([])).toBeNull()
  })

  test("preserves recovery and human-required instructions ahead of routine work", () => {
    const reason = "A git push is already running. Wait for task 42 and verify its result."
    expect(selectStopAction([finding(push), { file: "git.ts", reason, actions: [] }])?.reason).toBe(
      reason
    )
    expect(
      selectStopAction([
        finding(push),
        { file: "approval.ts", reason, actions: [issue], humanRequired: true },
      ])
    ).toEqual({ reason, humanRequired: true })
  })

  test("rejects malformed or partial metadata without suppressing the original finding", () => {
    for (const value of [undefined, {}, [], [push, {}], [{ ...push, doneWhen: "" }]]) {
      expect(readStopActions(value)).toEqual([])
    }
    expect(readStopActions([push])).toEqual([push])
  })

  test("does not compact Git states that need recovery or ownership decisions", () => {
    for (const overrides of [
      { ahead: 0 },
      { behind: 1 },
      { upstreamGone: true },
      { upstream: null },
      { branch: "(detached)" },
    ]) {
      expect(
        buildGitStopAction({ ...gitContext, gitStatus: { ...gitContext.gitStatus, ...overrides } })
      ).toBeUndefined()
    }
    expect(buildGitStopAction({ ...gitContext, hasUncommitted: true })).toBeUndefined()
    expect(buildGitStopAction({ ...gitContext, hasRemote: false })).toBeUndefined()
    expect(buildGitStopAction({ ...gitContext, strictNoDirectMain: true })).toBeUndefined()
    expect(
      buildGitStopAction({
        ...gitContext,
        gitStatus: { ...gitContext.gitStatus, branch: "feature" },
      })
    ).toBeUndefined()
  })

  test("keeps all diagnostic details outside the agent envelope", () => {
    const fullReason = `Diagnostics: ${"details ".repeat(300)}last issue #2799`
    const results = [push, issue, push].map((action, index) => ({
      execution: { file: `stop-${index}.ts`, status: "ok", durationMs: 1 } as HookExecution,
      parsed: { decision: "block", reason: fullReason, _stopActions: [action] },
    }))
    const executions: HookExecution[] = []
    const response: Record<string, unknown> = {}
    processAggregatedStopResults(results, executions, response, "Stop")
    expect(response.reason).toBe(renderStopAction(push))
    expect(executions).toHaveLength(3)
    for (const execution of executions)
      expect(JSON.parse(execution.stdoutSnippet!).reason).toBe(fullReason)
    expect(
      stripInternalDispatchFields({ ...response, hookExecutions: executions, _stopActions: [push] })
    ).toEqual({
      decision: "block",
      reason: renderStopAction(push),
      systemMessage: renderStopAction(push),
    })
  })
})
