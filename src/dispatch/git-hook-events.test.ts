import { describe, expect, test } from "bun:test"
import { GIT_HOOK_EVENTS, gitHookBlockReason } from "./git-hook-events.ts"

const block = { decision: "block", continue: true, reason: "Merge conflict markers found" }

describe("gitHookBlockReason", () => {
  test("a block on every git-hook event fails the hook with its reason", () => {
    for (const event of GIT_HOOK_EVENTS) {
      expect(gitHookBlockReason(event, block)).toBe("Merge conflict markers found")
    }
  })

  test("control: the same block on an agent event never changes the exit status", () => {
    // Agents act on the JSON; a non-zero exit there would turn a block into a hook error.
    for (const event of ["preToolUse", "postToolUse", "stop", "userPromptSubmit"]) {
      expect(gitHookBlockReason(event, block)).toBeNull()
    }
  })

  test("a git-hook dispatch that does not block lets git proceed", () => {
    expect(gitHookBlockReason("preCommit", {})).toBeNull()
    expect(gitHookBlockReason("preCommit", { decision: "approve" })).toBeNull()
    expect(gitHookBlockReason("preCommit", { systemMessage: "advice only" })).toBeNull()
    expect(gitHookBlockReason("prePush", null)).toBeNull()
    expect(gitHookBlockReason("prePush", undefined)).toBeNull()
  })

  test("a block without a reason still fails and says so", () => {
    expect(gitHookBlockReason("commitMsg", { decision: "block" })).toBe(
      "blocked without a stated reason"
    )
    expect(gitHookBlockReason("commitMsg", { decision: "block", reason: "  " })).toBe(
      "blocked without a stated reason"
    )
  })
})
