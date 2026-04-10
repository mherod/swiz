import { describe, expect, test } from "bun:test"
import { hookSpecificOutputSchema } from "../schemas.ts"
import {
  extractPreToolSurfaceDecision,
  getHookSpecificOutput,
  hsoPreToolUseAllow,
  mergeHookSpecificOutputClone,
} from "./hook-specific-output.ts"

describe("getHookSpecificOutput", () => {
  test("returns plain objects, rejects arrays and primitives", () => {
    expect(getHookSpecificOutput({ hookSpecificOutput: { a: 1 } })?.a).toBe(1)
    expect(getHookSpecificOutput({ hookSpecificOutput: [1, 2] })).toBeUndefined()
    expect(getHookSpecificOutput({ hookSpecificOutput: "x" as unknown as object })).toBeUndefined()
    expect(getHookSpecificOutput({})).toBeUndefined()
  })
})

describe("extractPreToolSurfaceDecision", () => {
  test("prefers hookSpecificOutput permission fields over top-level", () => {
    expect(
      extractPreToolSurfaceDecision({
        decision: "block",
        hookSpecificOutput: { permissionDecision: "allow", permissionDecisionReason: "ok" },
      })
    ).toEqual({ decision: "allow", reason: "ok" })
  })
})

describe("mergeHookSpecificOutputClone", () => {
  test("fills hookEventName when missing", () => {
    const out = mergeHookSpecificOutputClone({}, "Stop")
    expect(out.hookEventName).toBe("Stop")
  })

  test("trims existing hookEventName and preserves other keys", () => {
    const out = mergeHookSpecificOutputClone(
      { hookSpecificOutput: { hookEventName: "  PostToolUse  ", foo: 1 } },
      "Fallback"
    )
    expect(out.hookEventName).toBe("PostToolUse")
    expect(out.foo).toBe(1)
  })
})

describe("builders", () => {
  test("hsoPreToolUseAllow", () => {
    expect(hsoPreToolUseAllow("r")).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "r",
    })
  })

  test("hsoContextEvent", () => {
    expect(
      hookSpecificOutputSchema.parse({ hookEventName: "notification", additionalContext: "x" })
    ).toEqual({
      hookEventName: "notification",
      additionalContext: "x",
    })
  })
})
