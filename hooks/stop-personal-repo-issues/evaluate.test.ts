import { expect, test } from "bun:test"
import { withGitClient } from "../../src/git/client.ts"
import { MockGitClient } from "../../src/git/mock-client.ts"
import {
  collectPersonalRepoIssuesStopParsed,
  evaluateStopPersonalRepoIssues,
  type PersonalRepoIssuesCollect,
} from "./evaluate.ts"

test("issue continuation does not query repository state without opt-in", async () => {
  const git = new MockGitClient()
  const result = await withGitClient(git, () =>
    collectPersonalRepoIssuesStopParsed({
      cwd: "/fixture",
      session_id: "session",
      _effectiveSettings: { autoContinue: false },
    })
  )
  expect(result).toBeNull()
  expect(git.calls).toHaveLength(0)
})

test("a large issue backlog creates only the selected action's task", async () => {
  const collected: PersonalRepoIssuesCollect = {
    cwd: "/fixture",
    sessionId: "session",
    shouldMergeTasks: true,
    shouldUpdateCooldown: false,
    planSteps: ["67 open issues", ["Work on every issue"]],
    stopCtx: {
      cwd: "/fixture",
      sessionId: "session",
      isPersonalRepo: true,
      projectState: "developing",
      strictNoDirectMain: false,
      defaultBranch: "main",
      sortedRefinement: [],
      blockedIssues: [],
      sortedIssues: Array.from({ length: 67 }, (_, n) => ({
        number: 2733 + n,
        title: `Issue ${n}`,
        labels: [],
      })),
    },
  }
  const plans: unknown[] = []
  const output = await evaluateStopPersonalRepoIssues(
    { cwd: "/fixture", session_id: "session" },
    {
      collect: () => Promise.resolve(collected),
      mergeTasks: (plan) => {
        plans.push(plan)
        return Promise.resolve(1)
      },
    }
  )
  expect(plans).toHaveLength(1)
  expect(JSON.stringify(plans)).toContain("#2733")
  expect(JSON.stringify(plans)).not.toContain("every issue")
  expect(JSON.stringify(plans)).not.toContain("2734")
  expect(output).toMatchObject({
    decision: "block",
    _stopActions: [{ title: "Work on issue #2733" }],
  })
})
