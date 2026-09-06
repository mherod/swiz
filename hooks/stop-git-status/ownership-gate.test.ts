import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { join } from "node:path"
import * as actionPlan from "../../src/action-plan.ts"
import { normalizeStopDispatchResponseInPlace } from "../../src/dispatch/stop-response.ts"
import { hookOutputSchema, stopHookOutputSchema } from "../../src/schemas.ts"
import * as taskResolver from "../../src/tasks/task-resolver.ts"
import * as gitUtils from "../../src/utils/git-utils.ts"
import * as ownership from "../../src/utils/session-file-ownership.ts"
import * as taskIo from "../../src/utils/session-task-io.ts"
import { useTempDir } from "../../src/utils/test-utils.ts"
import * as ciWorkflow from "../stop-ship-checklist/ci-workflow.ts"
import * as shipContext from "../stop-ship-checklist/context.ts"
import {
  collectShipChecklistStopParsed,
  evaluateStopShipChecklist,
} from "../stop-ship-checklist/evaluate.ts"
import * as background from "./background-push-detector.ts"
import { collectGitWorkflowStop, evaluateStopGitStatus } from "./evaluate.ts"
import * as cooldown from "./push-cooldown-validator.ts"

const temp = useTempDir("swiz-peer-stop-")
const readStatus = gitUtils.getGitStatusV2
const status = spyOn(gitUtils, "getGitStatusV2")
const discover = spyOn(ownership, "resolveSessionFileOwnershipResult")
const backgroundPush = spyOn(background, "detectBackgroundPush")
const pushCooldown = spyOn(cooldown, "isPushCooldownActive")
spyOn(cooldown, "markPushPrompted").mockResolvedValue(undefined)
spyOn(taskIo, "createSessionTask").mockResolvedValue(undefined)
spyOn(taskIo, "completeSessionTask").mockResolvedValue(true)
spyOn(taskResolver, "getSessionIdsForProject").mockResolvedValue(new Set(["self"]))
spyOn(actionPlan, "mergeActionPlanIntoTasks").mockResolvedValue(0)
const checklistContext = spyOn(shipContext, "resolveShipChecklistContext")
const ci = spyOn(ciWorkflow, "collectCiWorkflow")

let cwd: string
let snapshot: gitUtils.GitStatusV2
const input = () => ({
  cwd,
  session_id: "self",
  _effectiveSettings: { collaborationMode: "solo", pushCooldownMinutes: 0, trunkMode: true },
})

async function git(args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (await proc.exited) throw new Error(err)
  return out.trim()
}

beforeEach(async () => {
  cwd = await temp.create()
  await git(["init", "-b", "main"])
  await git(["config", "user.email", "test@example.com"])
  await git(["config", "user.name", "Test User"])
  await git(["commit", "--allow-empty", "-m", "initial"])
  await Bun.write(join(cwd, "peer.ts"), "peer work\n")
  const current = await readStatus(cwd)
  if (!current) throw new Error("missing fixture status")
  snapshot = current
  status.mockReset().mockImplementation(() => Promise.resolve(snapshot))
  discover.mockReset().mockResolvedValue({
    known: true,
    ownership: { editedByUs: [], editedByOthers: ["peer.ts"], unattributed: [] },
  })
  backgroundPush.mockReset().mockResolvedValue(false)
  pushCooldown.mockReset().mockResolvedValue(false)
  checklistContext.mockReset().mockResolvedValue({
    cwd,
    sessionId: "self",
    gates: { git: true, ci: true, issues: false },
  })
  ci.mockReset().mockResolvedValue(null)
})
afterAll(() => mock.restore())

describe("peer-only stop exemption", () => {
  test("allows collector and standalone stop while naming and preserving peer files", async () => {
    const before = await git(["status", "--porcelain=v2"])
    const collected = await collectGitWorkflowStop(input())
    const output = hookOutputSchema.parse(await evaluateStopGitStatus(input()))
    expect(collected.kind).toBe("ok")
    expect(output.decision).toBeUndefined()
    expect(output.systemMessage).toContain("peer.ts")
    normalizeStopDispatchResponseInPlace(output, "Stop")
    expect(stopHookOutputSchema.parse(output).decision).toBeUndefined()
    expect(output.reason).toContain("peer.ts")
    expect(await git(["status", "--porcelain=v2"])).toBe(before)
    expect(await Bun.file(join(cwd, "peer.ts")).text()).toBe("peer work\n")
  })

  for (const [name, result] of [
    [
      "own",
      { known: true, ownership: { editedByUs: ["peer.ts"], editedByOthers: [], unattributed: [] } },
    ],
    [
      "unattributed",
      { known: true, ownership: { editedByUs: [], editedByOthers: [], unattributed: ["peer.ts"] } },
    ],
    [
      "mixed",
      {
        known: true,
        ownership: { editedByUs: ["mine.ts"], editedByOthers: ["peer.ts"], unattributed: [] },
      },
    ],
    [
      "incomplete coverage",
      {
        known: true,
        ownership: { editedByUs: [], editedByOthers: ["another.ts"], unattributed: [] },
      },
    ],
    ["missing session", { known: false, reason: "missing-session" }],
    ["failed query", { known: false, reason: "query-failed" }],
  ] as const) {
    test(`${name} remains blocking`, async () => {
      if (name === "mixed") {
        await Bun.write(join(cwd, "mine.ts"), "my work\n")
        const mixed = await readStatus(cwd)
        if (!mixed) throw new Error("missing mixed fixture status")
        snapshot = mixed
      }
      discover.mockResolvedValue(structuredClone(result) as ownership.SessionFileOwnershipResult)
      expect((await collectGitWorkflowStop(input())).kind).toBe("block")
      const output = hookOutputSchema.parse(await evaluateStopGitStatus(input()))
      expect(output.decision).toBe("block")
      expect((await collectShipChecklistStopParsed(input()))?.blocked).toBe(true)
    })
  }

  for (const counts of [
    { ahead: 1, behind: 0 },
    { ahead: 0, behind: 1 },
    { ahead: 1, behind: 1 },
  ]) {
    test(`preserves remote obligation ${JSON.stringify(counts)}`, async () => {
      snapshot = { ...snapshot, ...counts, upstream: "origin/main" }
      expect((await collectGitWorkflowStop(input())).kind).toBe("block")
      const output = hookOutputSchema.parse(await evaluateStopGitStatus(input()))
      expect(output.decision).toBe("block")
      expect(output.reason).not.toContain("Commit your changes")
      expect(output.reason).not.toContain("git add")
    })
  }

  for (const upstreamGone of [false, true]) {
    test(`preserves unresolved upstream (gone=${upstreamGone})`, async () => {
      await git(["remote", "add", "origin", "https://example.com/test/repo.git"])
      snapshot = { ...snapshot, upstream: upstreamGone ? "origin/main" : null, upstreamGone }
      const result = await collectGitWorkflowStop(input())
      expect(result.kind).toBe("block")
      expect(JSON.stringify(result)).toContain("upstream")
      expect(JSON.stringify(result)).not.toContain("git add")
    })
  }

  test("an in-flight push blocks even during the prompt cooldown", async () => {
    snapshot = { ...snapshot, ahead: 1, upstream: "origin/main" }
    backgroundPush.mockResolvedValue(true)
    pushCooldown.mockResolvedValue(true)
    const output = hookOutputSchema.parse(await evaluateStopGitStatus(input()))
    expect(output.decision).toBe("block")
    expect(output.reason).toContain("currently running in the background")
  })

  test("peer dirt uses the existing cooldown when no push is running", async () => {
    snapshot = { ...snapshot, ahead: 1, upstream: "origin/main" }
    pushCooldown.mockResolvedValue(true)
    const output = hookOutputSchema.parse(await evaluateStopGitStatus(input()))
    expect(output.decision).toBeUndefined()
    expect(pushCooldown).toHaveBeenCalled()
  })

  test("a missing upstream still blocks during the push cooldown", async () => {
    snapshot = { ...snapshot, ahead: 1, upstream: "origin/main", upstreamGone: true }
    pushCooldown.mockResolvedValue(true)
    const output = hookOutputSchema.parse(await evaluateStopGitStatus(input()))
    expect(output.decision).toBe("block")
    expect(output.reason).toContain("upstream")
  })

  test("detached main worktree still blocks peer-only dirt", async () => {
    await git(["switch", "--detach", "HEAD"])
    const output = hookOutputSchema.parse(await evaluateStopGitStatus(input()))
    expect(output.decision).toBe("block")
    expect(output.reason).toContain("detached HEAD")
  })

  test("a composed checklist allows peer-only dirt and preserves its context", async () => {
    const collected = await collectShipChecklistStopParsed(input())
    const output = hookOutputSchema.parse(await evaluateStopShipChecklist(input()))
    expect(collected?.blocked).toBe(false)
    expect(output.decision).toBeUndefined()
    expect(output.systemMessage).toContain("peer.ts")
  })

  test("a composed checklist preserves the missing-cwd ownership hold", async () => {
    const payload = { ...input(), cwd: undefined }
    const result = await collectShipChecklistStopParsed(payload)
    expect(result?.blocked).toBe(true)
    expect(result?.steps.map((step) => step.kind)).toEqual(["git"])
    const output = hookOutputSchema.parse(await evaluateStopShipChecklist(payload))
    expect(output.decision).toBe("block")
    expect(output.reason).toContain("ownership")
  })

  test("a composed CI obligation remains blocking after the peer exemption", async () => {
    ci.mockResolvedValue({
      kind: "ci",
      summary: "CI still running.",
      planSteps: ["Wait for CI completion."],
    })
    const result = await collectShipChecklistStopParsed(input())
    expect(result?.blocked).toBe(true)
    expect(result?.steps.map((step) => step.kind)).toEqual(["ci"])
    const output = hookOutputSchema.parse(await evaluateStopShipChecklist(input()))
    expect(output.decision).toBe("block")
    expect(output.reason).toContain("CI still running")
    expect(output.reason).toContain("peer.ts")
  })
})
