import { describe, expect, test } from "bun:test"
import { hookSpecificOutputSchema } from "../schemas.ts"
import {
  extractPreToolSurfaceDecision,
  getHookSpecificOutput,
  hsoPreToolUseAllow,
  hsoPreToolUseDenyTaskFile,
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

describe("hsoPreToolUseDenyTaskFile", () => {
  test("sets denialCategory to task-file-access", () => {
    const hso = hsoPreToolUseDenyTaskFile("blocked reason") as Record<string, any>
    expect(hso.denialCategory).toBe("task-file-access")
    expect(hso.permissionDecision).toBe("deny")
    expect(hso.hookEventName).toBe("PreToolUse")
  })

  test("includes toolName and blockedPath when provided", () => {
    const hso = hsoPreToolUseDenyTaskFile("blocked", {
      toolName: "Bash",
      blockedPath: "~/.claude/tasks/1.json",
      sessionId: "sess-123",
    }) as Record<string, any>
    expect(hso.toolName).toBe("Bash")
    expect(hso.blockedPath).toBe("~/.claude/tasks/1.json")
    expect(hso.sessionId).toBe("sess-123")
  })

  test("omits optional meta fields when not provided", () => {
    const hso = hsoPreToolUseDenyTaskFile("blocked") as Record<string, any>
    expect(hso.toolName).toBeUndefined()
    expect(hso.blockedPath).toBeUndefined()
    expect(hso.sessionId).toBeUndefined()
  })

  test("passes permissionDecisionReason through", () => {
    const hso = hsoPreToolUseDenyTaskFile("my reason") as Record<string, any>
    expect(typeof hso.permissionDecisionReason).toBe("string")
    expect((hso.permissionDecisionReason as string).length).toBeGreaterThan(0)
  })
})
