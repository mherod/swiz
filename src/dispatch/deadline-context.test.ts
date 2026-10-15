import { expect, test } from "bun:test"
import { join } from "node:path"
import { DeadlineStore } from "../deadlines/store.ts"
import { useTempDir } from "../utils/test-utils.ts"
import { injectDeadlineContext } from "./deadline-context.ts"

const tmp = useTempDir("swiz-deadline-context-")
const now = Date.parse("2026-10-15T13:00:00Z")

async function fixture() {
  const cwd = await tmp.create()
  const path = join(cwd, "deadlines.db")
  const store = (await DeadlineStore.open(path, true))!
  store.mutate(
    {
      action: "set",
      sessionId: "agent",
      requestId: "set",
      label: "Ship",
      completionCriteria: "Verified deployment",
      durationMinutes: 1,
    },
    cwd,
    now
  )
  store.close()
  return {
    cwd,
    path,
    payload: { cwd, session_id: "agent", tool_name: "wait", tool_input: { duration_ms: 120000 } },
  }
}

test("refreshes silent pre/post/failure responses across a deadline without altering tools", async () => {
  const { path, payload } = await fixture()
  const pre: Record<string, any> = {}
  await injectDeadlineContext(pre, "preToolUse", "PreToolUse", payload, { path, now })
  expect(pre.hookSpecificOutput.additionalContext).toContain("1m 0s remaining")
  expect(pre.systemMessage).toContain("requested wait allowance exceeds")
  expect(pre.hookSpecificOutput.permissionDecision).toBeUndefined()
  expect(pre.hookSpecificOutput.updatedInput).toBeUndefined()
  for (const event of ["postToolUse", "postToolUseFailure"]) {
    const post: Record<string, any> = {}
    await injectDeadlineContext(post, event, event, payload, { path, now: now + 61000 })
    expect(post.systemMessage).toContain("0m 1s overdue")
    expect(post.systemMessage).toContain("Deadline missed")
    expect(post.systemMessage).not.toContain("requested wait")
    expect(post.decision).toBeUndefined()
  }
})

test("preserves existing denials and never attaches unrelated sessions implicitly", async () => {
  const { path, payload } = await fixture()
  const denied = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Required check",
    },
    systemMessage: "Existing guidance",
  }
  await injectDeadlineContext(denied, "preToolUse", "PreToolUse", payload, { path, now })
  expect(denied.hookSpecificOutput.permissionDecision).toBe("deny")
  expect(denied.hookSpecificOutput.permissionDecisionReason).toBe("Required check")
  expect(denied.systemMessage).toContain("Existing guidance")
  for (const changed of [{ session_id: "other" }, { agent_id: "subagent" }]) {
    const unrelated = {}
    await injectDeadlineContext(
      unrelated,
      "preToolUse",
      "PreToolUse",
      { ...payload, ...changed },
      { path, now }
    )
    expect(unrelated).toEqual({})
  }
})

test("fails open with honest state-unavailable context for a corrupt store", async () => {
  const { path, payload } = await fixture()
  const corrupt = join(await tmp.create(), "corrupt.db")
  await Bun.write(corrupt, "invalid database")
  const response: Record<string, any> = {}
  await injectDeadlineContext(response, "preToolUse", "PreToolUse", payload, { path: corrupt, now })
  expect(response.systemMessage).toContain("state unavailable")
  expect(response.decision).toBeUndefined()
  const stop = {}
  await injectDeadlineContext(stop, "stop", "Stop", payload, { path, now })
  expect(stop).toEqual({})
})
