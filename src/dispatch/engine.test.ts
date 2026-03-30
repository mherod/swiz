import { describe, expect, it } from "vitest"
import { hookIdentifier } from "../manifest.ts"
import {
  classifyHookOutput,
  flatSyncHooks,
  type HookEntry,
  type HookStatus,
  isAsyncFireAndForgetHook,
  logSlowHook,
  runsInSyncPipeline,
  toolMatchesToken,
} from "./engine.ts"

// ─── classifyHookOutput: pure status classification ─────────────────────────

describe("classifyHookOutput", () => {
  describe("timeout", () => {
    it("returns status=timeout when timedOut=true regardless of output", () => {
      expect(
        classifyHookOutput({ timedOut: true, trimmed: "", exitCode: null }).status
      ).toBe<HookStatus>("timeout")
      expect(
        classifyHookOutput({ timedOut: true, trimmed: "{}", exitCode: 0 }).status
      ).toBe<HookStatus>("timeout")
    })

    it("returns parsed=null on timeout", () => {
      expect(classifyHookOutput({ timedOut: true, trimmed: "{}", exitCode: 0 }).parsed).toBeNull()
    })
  })

  describe("no-output", () => {
    it("returns status=no-output for empty trimmed with exit 0", () => {
      expect(
        classifyHookOutput({ timedOut: false, trimmed: "", exitCode: 0 }).status
      ).toBe<HookStatus>("no-output")
    })
  })

  describe("error", () => {
    it("returns status=error for empty trimmed with non-zero exit", () => {
      expect(
        classifyHookOutput({ timedOut: false, trimmed: "", exitCode: 1 }).status
      ).toBe<HookStatus>("error")
      expect(
        classifyHookOutput({ timedOut: false, trimmed: "", exitCode: 127 }).status
      ).toBe<HookStatus>("error")
    })

    it("does NOT return error when there is output (even with non-zero exit)", () => {
      const result = classifyHookOutput({ timedOut: false, trimmed: '{"ok":true}', exitCode: 1 })
      expect(result.status).not.toBe<HookStatus>("error")
    })
  })

  describe("invalid-json", () => {
    it("returns status=invalid-json for non-JSON output", () => {
      expect(
        classifyHookOutput({ timedOut: false, trimmed: "not json", exitCode: 0 }).status
      ).toBe<HookStatus>("invalid-json")
    })

    it("returns parsed=null for invalid JSON", () => {
      expect(
        classifyHookOutput({ timedOut: false, trimmed: "oops", exitCode: 0 }).parsed
      ).toBeNull()
    })
  })

  describe("ok", () => {
    it("returns status=ok and parsed object for valid JSON", () => {
      const result = classifyHookOutput({
        timedOut: false,
        trimmed: '{"decision":"block","reason":"x"}',
        exitCode: 0,
      })
      expect(result.status).toBe<HookStatus>("ok")
      expect(result.parsed).toEqual({ decision: "block", reason: "x" })
    })

    it("returns status=ok for valid JSON with non-zero exit (exit code captured separately)", () => {
      const result = classifyHookOutput({ timedOut: false, trimmed: '{"ok":true}', exitCode: 1 })
      expect(result.status).toBe<HookStatus>("ok")
      expect(result.parsed).toEqual({ ok: true })
    })
  })

  describe("json extraction from polluted stdout", () => {
    it("extracts JSON after non-JSON prefix text", () => {
      const result = classifyHookOutput({
        timedOut: false,
        trimmed: 'some prefix log line\n{"decision":"block","reason":"test"}',
        exitCode: 0,
      })
      expect(result.status).toBe<HookStatus>("ok")
      expect(result.parsed).toEqual({ decision: "block", reason: "test" })
    })

    it("extracts JSON after multiple prefix lines", () => {
      const result = classifyHookOutput({
        timedOut: false,
        trimmed: 'line1\nline2\nline3\n{"ok":true}',
        exitCode: 0,
      })
      expect(result.status).toBe<HookStatus>("ok")
      expect(result.parsed).toEqual({ ok: true })
    })

    it("extracts JSON when non-JSON text follows (JSON-first stdout pollution)", () => {
      // Regression: lastBrace > 0 check failed when JSON appeared at position 0
      // (e.g. auth library writing "Loaded cached credentials." after the hook JSON)
      const result = classifyHookOutput({
        timedOut: false,
        trimmed: '{"decision":"block","reason":"test"}\nLoaded cached credentials.',
        exitCode: 0,
      })
      expect(result.status).toBe<HookStatus>("ok")
      expect(result.parsed).toEqual({ decision: "block", reason: "test" })
    })

    it("returns invalid-json when no valid JSON exists anywhere", () => {
      const result = classifyHookOutput({
        timedOut: false,
        trimmed: "just plain text with no braces",
        exitCode: 0,
      })
      expect(result.status).toBe<HookStatus>("invalid-json")
    })

    it("returns invalid-json when prefix has brace but no valid JSON follows", () => {
      const result = classifyHookOutput({
        timedOut: false,
        trimmed: "some text {not valid json",
        exitCode: 0,
      })
      expect(result.status).toBe<HookStatus>("invalid-json")
    })

    it("prefers full-string parse over extraction", () => {
      const result = classifyHookOutput({
        timedOut: false,
        trimmed: '{"full":"object"}',
        exitCode: 0,
      })
      expect(result.status).toBe<HookStatus>("ok")
      expect(result.parsed).toEqual({ full: "object" })
    })
  })

  describe("status taxonomy completeness", () => {
    const allClassifiable: HookStatus[] = ["ok", "no-output", "timeout", "invalid-json", "error"]
    it("classifyHookOutput can produce all raw statuses", () => {
      // timeout
      expect(classifyHookOutput({ timedOut: true, trimmed: "", exitCode: null }).status).toBe(
        "timeout"
      )
      // no-output
      expect(classifyHookOutput({ timedOut: false, trimmed: "", exitCode: 0 }).status).toBe(
        "no-output"
      )
      // error
      expect(classifyHookOutput({ timedOut: false, trimmed: "", exitCode: 1 }).status).toBe("error")
      // invalid-json
      expect(classifyHookOutput({ timedOut: false, trimmed: "not-json", exitCode: 0 }).status).toBe(
        "invalid-json"
      )
      // ok
      expect(classifyHookOutput({ timedOut: false, trimmed: "{}", exitCode: 0 }).status).toBe("ok")
      // All 5 raw statuses are covered
      expect(allClassifiable).toHaveLength(5)
    })
  })
})

describe("toolMatchesToken", () => {
  describe("exact match", () => {
    it("matches identical names", () => {
      expect(toolMatchesToken("TaskCreate", "TaskCreate")).toBe(true)
      expect(toolMatchesToken("Bash", "Bash")).toBe(true)
    })
  })

  describe("shell family", () => {
    it("matches cross-agent shell tools", () => {
      expect(toolMatchesToken("Bash", "Shell")).toBe(true)
      expect(toolMatchesToken("Shell", "run_shell_command")).toBe(true)
    })
  })

  describe("edit family", () => {
    it("matches cross-agent edit tools", () => {
      expect(toolMatchesToken("Edit", "StrReplace")).toBe(true)
      expect(toolMatchesToken("StrReplace", "Edit")).toBe(true)
    })

    it("does not match write tools", () => {
      expect(toolMatchesToken("Edit", "Write")).toBe(false)
    })
  })

  describe("task tools — specific families (issue #97)", () => {
    it("TaskCreate does NOT match TaskUpdate", () => {
      expect(toolMatchesToken("TaskCreate", "TaskUpdate")).toBe(false)
    })

    it("TaskCreate does NOT match TaskList", () => {
      expect(toolMatchesToken("TaskCreate", "TaskList")).toBe(false)
    })

    it("TaskCreate does NOT match TaskGet", () => {
      expect(toolMatchesToken("TaskCreate", "TaskGet")).toBe(false)
    })

    it("TaskUpdate does NOT match TaskCreate", () => {
      expect(toolMatchesToken("TaskUpdate", "TaskCreate")).toBe(false)
    })

    it("TaskUpdate does NOT match TaskList", () => {
      expect(toolMatchesToken("TaskUpdate", "TaskList")).toBe(false)
    })

    it("TaskList does NOT match TaskGet", () => {
      expect(toolMatchesToken("TaskList", "TaskGet")).toBe(false)
    })

    it("TaskGet does NOT match TaskUpdate", () => {
      expect(toolMatchesToken("TaskGet", "TaskUpdate")).toBe(false)
    })

    it("TaskCreate matches cross-agent equivalents", () => {
      expect(toolMatchesToken("TaskCreate", "TodoWrite")).toBe(true)
      expect(toolMatchesToken("TodoWrite", "TaskCreate")).toBe(true)
      expect(toolMatchesToken("TaskCreate", "write_todos")).toBe(true)
      expect(toolMatchesToken("TaskCreate", "update_plan")).toBe(true)
    })

    it("cross-agent create tools do NOT match TaskUpdate (except update_plan)", () => {
      expect(toolMatchesToken("TodoWrite", "TaskUpdate")).toBe(false)
      expect(toolMatchesToken("write_todos", "TaskUpdate")).toBe(false)
      // update_plan is in both TASK_CREATE_TOOLS and TASK_UPDATE_TOOLS
      // because Codex uses it for both creating and updating tasks
      expect(toolMatchesToken("update_plan", "TaskUpdate")).toBe(true)
    })
  })

  describe("task tools — broad 'Task' family", () => {
    it("'Task' token matches all task tools", () => {
      expect(toolMatchesToken("TaskCreate", "Task")).toBe(true)
      expect(toolMatchesToken("TaskUpdate", "Task")).toBe(true)
      expect(toolMatchesToken("TaskList", "Task")).toBe(true)
      expect(toolMatchesToken("TaskGet", "Task")).toBe(true)
      expect(toolMatchesToken("TodoWrite", "Task")).toBe(true)
    })

    it("'Task' toolName matches all task tokens", () => {
      expect(toolMatchesToken("Task", "TaskCreate")).toBe(true)
      expect(toolMatchesToken("Task", "TaskUpdate")).toBe(true)
      expect(toolMatchesToken("Task", "TaskList")).toBe(true)
      expect(toolMatchesToken("Task", "TaskGet")).toBe(true)
    })
  })

  describe("no cross-family matches", () => {
    it("task tools do not match shell tools", () => {
      expect(toolMatchesToken("TaskCreate", "Bash")).toBe(false)
      expect(toolMatchesToken("Bash", "TaskUpdate")).toBe(false)
    })

    it("task tools do not match edit tools", () => {
      expect(toolMatchesToken("TaskCreate", "Edit")).toBe(false)
    })

    it("unknown tools only match exact", () => {
      expect(toolMatchesToken("TaskOutput", "TaskUpdate")).toBe(false)
      expect(toolMatchesToken("TaskOutput", "TaskOutput")).toBe(true)
    })
  })
})

describe("flatSyncHooks", () => {
  it("excludes fire-and-forget async hooks", () => {
    const groups = [
      {
        event: "preToolUse",
        hooks: [
          { file: "sync-hook.ts", async: false },
          { file: "async-hook.ts", async: true },
        ],
      },
    ]
    const entries = flatSyncHooks(groups)
    expect(entries.map((e: HookEntry) => hookIdentifier(e.hook))).toEqual(["sync-hook.ts"])
  })

  it("includes async hooks with asyncMode block-until-complete", () => {
    const groups = [
      {
        event: "postToolUse",
        hooks: [
          { file: "ff.ts", async: true },
          {
            file: "block.ts",
            async: true,
            asyncMode: "block-until-complete" as const,
          },
        ],
      },
    ]
    const entries = flatSyncHooks(groups)
    expect(entries.map((e: HookEntry) => hookIdentifier(e.hook))).toEqual(["block.ts"])
  })

  it("preserves declaration order across groups", () => {
    const groups = [
      {
        event: "preToolUse",
        hooks: [{ file: "a.ts" }, { file: "b.ts" }],
      },
      {
        event: "preToolUse",
        matcher: "Bash",
        hooks: [{ file: "c.ts" }, { file: "d.ts" }],
      },
    ]
    const entries = flatSyncHooks(groups)
    expect(entries.map((e: HookEntry) => hookIdentifier(e.hook))).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
      "d.ts",
    ])
  })

  it("propagates matcher from group to entry", () => {
    const groups = [
      { event: "preToolUse", hooks: [{ file: "no-matcher.ts" }] },
      { event: "preToolUse", matcher: "Edit|Write", hooks: [{ file: "with-matcher.ts" }] },
    ]
    const entries = flatSyncHooks(groups)
    expect(entries[0]?.matcher).toBeUndefined()
    expect(entries[1]?.matcher).toBe("Edit|Write")
  })

  it("returns empty array for empty groups", () => {
    expect(flatSyncHooks([])).toEqual([])
  })

  it("returns empty array when all hooks are async fire-and-forget", () => {
    const groups = [{ event: "stop", hooks: [{ file: "async.ts", async: true }] }]
    expect(flatSyncHooks(groups)).toEqual([])
  })
})

describe("runsInSyncPipeline / isAsyncFireAndForgetHook", () => {
  it("non-async file hook runs in sync pipeline and is not fire-and-forget async", () => {
    const h = { file: "x.ts" }
    expect(runsInSyncPipeline(h)).toBe(true)
    expect(isAsyncFireAndForgetHook(h)).toBe(false)
  })

  it("async without asyncMode is fire-and-forget, not sync pipeline", () => {
    const h = { file: "x.ts", async: true }
    expect(runsInSyncPipeline(h)).toBe(false)
    expect(isAsyncFireAndForgetHook(h)).toBe(true)
  })

  it("async block-until-complete is sync pipeline, not fire-and-forget", () => {
    const h = { file: "x.ts", async: true, asyncMode: "block-until-complete" as const }
    expect(runsInSyncPipeline(h)).toBe(true)
    expect(isAsyncFireAndForgetHook(h)).toBe(false)
  })
})

describe("logSlowHook", () => {
  it("returns true when duration strictly exceeds threshold", () => {
    expect(logSlowHook("test-hook.ts", 5000, 3000)).toBe(true)
  })

  it("returns false when duration is below threshold", () => {
    expect(logSlowHook("test-hook.ts", 1000, 3000)).toBe(false)
  })

  it("returns false when duration equals threshold (not strictly over)", () => {
    expect(logSlowHook("test-hook.ts", 3000, 3000)).toBe(false)
  })
})
