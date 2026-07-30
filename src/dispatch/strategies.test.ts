import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  BlockingStrategy,
  keepSideEffectPostToolGroups,
  processAggregatedStopResults,
  processBlockingResults,
  shouldSkipPostToolUseHooks,
} from "./blockingStrategy.ts"
import { orderHookContexts } from "./context-order.ts"
import type { HookExecution } from "./engine.ts"
import { writeResponse } from "./engine.ts"
import {
  applyPreToolHumanisedContext,
  collectPreToolResults,
  isSkillGateHook,
  normalizePreToolDenyReason,
  preparePreToolHints,
  resolveFileEditDenyDowngrade,
  shouldDowngradeFileEditDenies,
} from "./preToolUseStrategy.ts"

describe("normalizePreToolDenyReason", () => {
  it.each([
    { decision: "deny" },
    { decision: "block" },
    { continue: false },
    { hookSpecificOutput: { decision: "deny" } },
    { hookSpecificOutput: { decision: "block" } },
    {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
      },
    },
  ])("adds a hook-naming fallback for a reasonless deny shape", (response) => {
    const output: Record<string, any> = response
    const reason = normalizePreToolDenyReason(output, "pretooluse-example.ts")
    expect(reason).toContain("pretooluse-example.ts")
    expect(reason).toContain("resolve this hook's requirement before retrying")
    expect(output.reason).toBe(reason)
  })

  it("promotes systemMessage retry guidance without rewriting it", () => {
    const response: Record<string, any> = {
      decision: "block",
      systemMessage: "Retry after TaskList has refreshed the task state.",
    }
    expect(normalizePreToolDenyReason(response, "pretooluse-task-state.ts")).toBe(
      response.systemMessage
    )
    expect(response.reason).toBe(response.systemMessage)
  })

  it("leaves canonical builder output unchanged", () => {
    const response = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Run the required skill.",
      },
    }
    const before = structuredClone(response)
    expect(normalizePreToolDenyReason(response, "pretooluse-skill-gate.ts")).toBe(
      "Run the required skill."
    )
    expect(response).toEqual(before)
  })

  it("ignores non-deny responses", () => {
    const response = { decision: "allow" }
    expect(normalizePreToolDenyReason(response, "pretooluse-example.ts")).toBeNull()
    expect(response).toEqual({ decision: "allow" })
  })
})

describe("collectPreToolResults denial handling", () => {
  it("normalizes and short-circuits on the first surviving generic deny", () => {
    const first = makeHookExecution("pretooluse-first.ts")
    const second = makeHookExecution("pretooluse-second.ts")
    const executions: HookExecution[] = []
    const finalResponse: Record<string, any> = {}

    collectPreToolResults(
      [
        { execution: first, parsed: { continue: false } },
        { execution: second, parsed: { decision: "block", reason: "later deny" } },
      ],
      executions,
      { hints: [], contexts: [], downgradeMode: null, finalResponse }
    )

    expect(executions).toEqual([first])
    expect(first.status).toBe("deny")
    expect(finalResponse.reason).toContain("pretooluse-first.ts")
    expect(finalResponse.reason).not.toContain("later deny")
  })

  it("turns a reasonless deny into named advisory context when downgraded", () => {
    const denied = makeHookExecution("pretooluse-edit-guard.ts")
    const passing = makeHookExecution("pretooluse-pass.ts")
    const executions: HookExecution[] = []
    const contexts: string[] = []
    const finalResponse: Record<string, any> = {}

    collectPreToolResults(
      [
        { execution: denied, parsed: { decision: "deny" } },
        { execution: passing, parsed: {} },
      ],
      executions,
      { hints: [], contexts, downgradeMode: "skill-active", finalResponse }
    )

    expect(executions).toEqual([denied, passing])
    expect(denied.status).toBe("allow-with-reason")
    expect(contexts[0]).toContain("pretooluse-edit-guard.ts")
    expect(finalResponse).toEqual({})
  })

  it("collects later hints and passes after downgrading a deny", () => {
    const denied = makeHookExecution("pretooluse-edit-guard.ts")
    const hinted = makeHookExecution("pretooluse-hint.ts")
    const passing = makeHookExecution("pretooluse-pass.ts")
    const executions: HookExecution[] = []
    const hints: string[] = []
    const contexts: string[] = []
    const finalResponse: Record<string, any> = {}

    collectPreToolResults(
      [
        {
          execution: denied,
          parsed: { decision: "deny", reason: "Create a task before editing." },
        },
        {
          execution: hinted,
          parsed: {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "allow",
              permissionDecisionReason: "Keep the change focused.",
            },
          },
        },
        { execution: passing, parsed: null },
      ],
      executions,
      { hints, contexts, downgradeMode: "skill-active", finalResponse }
    )

    expect(executions).toEqual([denied, hinted, passing])
    expect(executions.map((execution) => execution.status)).toEqual([
      "allow-with-reason",
      "allow-with-reason",
      "ok",
    ])
    expect(contexts).toEqual(["Create a task before editing."])
    expect(hints).toEqual(["Keep the change focused."])
    expect(finalResponse).toEqual({})
  })
})

/** Capture everything written to stdout while an in-process callback runs. */
async function captureStdout<T>(
  callback: () => T | Promise<T>
): Promise<{ output: string; value: T }> {
  const stdout = process.stdout as { write: (chunk: string | Uint8Array) => boolean }
  const original = stdout.write.bind(process.stdout)
  let captured = ""
  stdout.write = (chunk: string | Uint8Array) => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    return true
  }
  try {
    const value = await callback()
    return { output: captured, value }
  } finally {
    process.stdout.write = original
  }
}

/** Capture everything writeResponse emits to stdout for a single call. */
async function captureWriteResponse(response: Record<string, any>): Promise<string> {
  const { output } = await captureStdout(() => writeResponse(response))
  return output
}

const recentSkillUsage = (skill: string) => ({
  toolNames: ["Skill"],
  skillInvocations: [skill],
  events: [
    { kind: "skill", value: skill, turnIndex: 5, timestamp: new Date().toISOString() },
    { kind: "tool", value: "Skill", turnIndex: 5, timestamp: new Date().toISOString() },
  ],
})

describe("shouldDowngradeFileEditDenies", () => {
  it("downgrades denies for a file edit when a skill is recently active", async () => {
    const payload = {
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/example.ts" },
      _currentSessionToolUsage: recentSkillUsage("commit"),
    }
    expect(await shouldDowngradeFileEditDenies(payload, process.cwd())).toBe(true)
  })

  it("does not downgrade for a file edit with no recent skill", async () => {
    const payload = {
      tool_name: "Write",
      tool_input: { file_path: "/tmp/example.ts" },
      _currentSessionToolUsage: { toolNames: ["Bash"], skillInvocations: [], events: [] },
    }
    expect(await shouldDowngradeFileEditDenies(payload, process.cwd())).toBe(false)
  })

  it("does not downgrade for non-edit tools even when a skill is recently active", async () => {
    const payload = {
      tool_name: "Bash",
      tool_input: { command: "bun test" },
      _currentSessionToolUsage: recentSkillUsage("commit"),
    }
    expect(await shouldDowngradeFileEditDenies(payload, process.cwd())).toBe(false)
  })

  it("does not downgrade when the skill invocation is outside the recency window", async () => {
    const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const payload = {
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/example.ts" },
      _currentSessionToolUsage: {
        toolNames: ["Skill"],
        skillInvocations: ["commit"],
        events: [
          { kind: "skill", value: "commit", turnIndex: 1, timestamp: stale },
          { kind: "tool", value: "Read", turnIndex: 90, timestamp: new Date().toISOString() },
        ],
      },
    }
    expect(await shouldDowngradeFileEditDenies(payload, process.cwd())).toBe(false)
  })
})

describe("resolveFileEditDenyDowngrade", () => {
  it("returns skill-active when a skill is recently active", async () => {
    const payload = {
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/example.ts" },
      _currentSessionToolUsage: {
        toolNames: ["Skill"],
        skillInvocations: ["commit"],
        events: [
          { kind: "skill", value: "commit", turnIndex: 5, timestamp: new Date().toISOString() },
          { kind: "tool", value: "Skill", turnIndex: 5, timestamp: new Date().toISOString() },
        ],
      },
    }
    expect(await resolveFileEditDenyDowngrade(payload, process.cwd())).toBe("skill-active")
  })

  it("returns edit-protected for a file edit with no recent skill", async () => {
    const payload = {
      tool_name: "Write",
      tool_input: { file_path: "/tmp/example.ts" },
      _currentSessionToolUsage: { toolNames: ["Bash"], skillInvocations: [], events: [] },
    }
    expect(await resolveFileEditDenyDowngrade(payload, process.cwd())).toBe("edit-protected")
  })

  it("returns null for non-edit tools", async () => {
    const payload = { tool_name: "Bash", tool_input: { command: "bun test" } }
    expect(await resolveFileEditDenyDowngrade(payload, process.cwd())).toBe(null)
  })
})

describe("isSkillGateHook", () => {
  it("keeps skill-enforcement gates blocking in edit-protected mode", () => {
    expect(isSkillGateHook("pretooluse-skill-invocation-gate.ts")).toBe(true)
    expect(isSkillGateHook("pretooluse-claude-md-update-memory-gate.ts")).toBe(true)
    expect(isSkillGateHook("pretooluse-update-memory-enforcement.ts")).toBe(true)
    expect(isSkillGateHook("pretooluse-commit-skill-gate.ts")).toBe(true)
  })

  it("does not spare non-skill gates", () => {
    expect(isSkillGateHook("pretooluse-require-tasks.ts")).toBe(false)
    expect(isSkillGateHook("pretooluse-todo-tracker.ts")).toBe(false)
    expect(isSkillGateHook("pretooluse-task-governance.ts")).toBe(false)
  })
})

describe("shouldSkipPostToolUseHooks", () => {
  it("skips postToolUse hooks when a skill is recently active", async () => {
    const payload = {
      tool_name: "Bash",
      tool_input: { command: "git commit -m 'x'" },
      _currentSessionToolUsage: recentSkillUsage("commit"),
    }
    expect(await shouldSkipPostToolUseHooks(payload, process.cwd())).toBe(true)
  })

  it("runs postToolUse hooks when no skill is recently active", async () => {
    const payload = {
      tool_name: "Bash",
      tool_input: { command: "bun test" },
      _currentSessionToolUsage: { toolNames: ["Bash"], skillInvocations: [], events: [] },
    }
    expect(await shouldSkipPostToolUseHooks(payload, process.cwd())).toBe(false)
  })

  it("runs postToolUse hooks when the skill invocation is outside the recency window", async () => {
    const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const payload = {
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/example.ts" },
      _currentSessionToolUsage: {
        toolNames: ["Skill"],
        skillInvocations: ["commit"],
        events: [
          { kind: "skill", value: "commit", turnIndex: 1, timestamp: stale },
          { kind: "tool", value: "Read", turnIndex: 90, timestamp: new Date().toISOString() },
        ],
      },
    }
    expect(await shouldSkipPostToolUseHooks(payload, process.cwd())).toBe(false)
  })
})

describe("BlockingStrategy postToolUse skill-recency dispatch", () => {
  function makeContext(payload: Record<string, any>, run: () => Record<string, never>) {
    return {
      filteredGroups: [
        {
          event: "postToolUse",
          matcher: "Bash",
          hooks: [
            {
              hook: {
                name: "posttooluse-sentinel.ts",
                event: "postToolUse",
                run,
              },
            },
          ],
        },
      ],
      enrichedPayloadStr: JSON.stringify(payload),
      canonicalEvent: "postToolUse",
      hookEventName: "PostToolUse",
      cwd: process.cwd(),
      agentId: "claude",
    }
  }

  it("short-circuits before running an advisory inline hook while a skill is active", async () => {
    let runs = 0
    const context = makeContext(
      {
        tool_name: "Bash",
        tool_input: { command: "git commit -m 'x'" },
        _currentSessionToolUsage: recentSkillUsage("commit"),
      },
      () => {
        runs++
        return {}
      }
    )

    const { output, value: response } = await captureStdout(() =>
      new BlockingStrategy().execute(context)
    )

    expect(runs).toBe(0)
    expect(response).toEqual({})
    expect(output).toBe("{}\n")
  })

  it("runs the advisory inline hook when no skill is recently active", async () => {
    let runs = 0
    const context = makeContext(
      {
        tool_name: "Bash",
        tool_input: { command: "bun test" },
        _currentSessionToolUsage: { toolNames: ["Bash"], skillInvocations: [], events: [] },
      },
      () => {
        runs++
        return {}
      }
    )

    const { output, value: response } = await captureStdout(() =>
      new BlockingStrategy().execute(context)
    )

    expect(runs).toBe(1)
    expect(response.hookExecutions).toHaveLength(1)
    expect(response.hookExecutions[0]).toMatchObject({
      file: "posttooluse-sentinel.ts",
      status: "no-output",
    })
    expect(output).toBe("{}\n")
  })
})

describe("keepSideEffectPostToolGroups", () => {
  it("keeps only side-effect hooks and drops advisory-only groups", () => {
    const groups = [
      {
        event: "postToolUse",
        matcher: "Bash",
        hooks: [
          { file: "posttooluse-upstream-sync-on-push.ts" },
          { file: "posttooluse-task-count-context.ts" },
        ],
      },
      {
        event: "postToolUse",
        matcher: "Edit|Write",
        hooks: [{ file: "posttooluse-pr-context.ts" }],
      },
    ]
    const kept = keepSideEffectPostToolGroups(groups)
    expect(kept).toHaveLength(1)
    expect(kept[0]?.matcher).toBe("Bash")
    expect(kept[0]?.hooks).toEqual([{ file: "posttooluse-upstream-sync-on-push.ts" }])
  })

  it("returns empty when no side-effect hooks are present", () => {
    const groups = [
      {
        event: "postToolUse",
        hooks: [{ file: "posttooluse-task-count-context.ts" }],
      },
    ]
    expect(keepSideEffectPostToolGroups(groups)).toEqual([])
  })
})

describe("writeResponse JSON validity", () => {
  // Regression: the agent rejects PreToolUse stdout with "hook returned invalid
  // pre-tool-use JSON output" if any byte breaks JSON.parse. Reason/context
  // strings carry untrusted content (em-dash hints, multi-line tips, AI-humanised
  // text, subprocess snippets), so writeResponse must always emit parseable JSON.
  it("emits JSON.parse-valid output for adversarial reason characters", async () => {
    const reason =
      "Tip: prefer `fd` or the Glob tool over `find` — faster and respects .gitignore." +
      "\n  fd 'pattern'\twith tab\r and CR and lone surrogate \uD800 end"
    const out = await captureWriteResponse({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: reason,
      },
    })
    // Must parse with the same JSON parser the agent uses — never throw.
    const parsed = JSON.parse(out)
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe(reason)
    // Control characters must be escaped, not emitted raw, so the line stays single.
    expect(out.endsWith("\n")).toBe(true)
    expect(out.trimEnd().includes("\n")).toBe(false)
  })

  it("strips internal dispatch fields and stays valid with raw subprocess snippets", async () => {
    const out = await captureWriteResponse({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
      hookExecutions: [{ stdoutSnippet: "junk\uD834ctl" }],
    })
    const parsed = JSON.parse(out)
    expect("hookExecutions" in parsed).toBe(false)
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("allow")
  })
})

describe("applyPreToolHumanisedContext", () => {
  // Regression: humanised PreToolUse context must land in `additionalContext`, the
  // agent-recognized field. Writing any other key (e.g. the old `contextsJoined`)
  // leaks an unknown key into hookSpecificOutput, which the agent rejects as
  // "hook returned invalid pre-tool-use JSON output" (schemas are looseObject and
  // don't strip it at the wire boundary).
  it("writes humanised text to additionalContext and never an unknown key", () => {
    const response: Record<string, any> = {
      systemMessage: "raw context",
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "raw hints",
        additionalContext: "raw context",
      },
    }
    applyPreToolHumanisedContext(response, "humanised paragraph")

    expect(response.systemMessage).toBe("humanised paragraph")
    expect(response.hookSpecificOutput.additionalContext).toBe("humanised paragraph")
    // The legacy bug set `contextsJoined`; it must never appear.
    expect("contextsJoined" in response.hookSpecificOutput).toBe(false)
    // permissionDecisionReason (hints) is left untouched.
    expect(response.hookSpecificOutput.permissionDecisionReason).toBe("raw hints")
  })

  it("is a no-op on hookSpecificOutput when none is present", () => {
    const response: Record<string, any> = { systemMessage: "raw" }
    applyPreToolHumanisedContext(response, "humanised")
    expect(response.systemMessage).toBe("humanised")
    expect(response.hookSpecificOutput).toBeUndefined()
  })
})

function makeHookExecution(file: string, status: HookExecution["status"] = "ok"): HookExecution {
  return {
    file,
    startTime: 0,
    endTime: 1,
    durationMs: 1,
    configuredTimeoutSec: 5,
    status,
    exitCode: 0,
    stdoutSnippet: "",
    stderrSnippet: "",
    ...(status === "skipped" ? { skipReason: "condition-false" as const } : {}),
  }
}

describe("processBlockingResults", () => {
  it("does not duplicate an existing systemMessage when merged context already contains it", () => {
    const results = [
      {
        execution: makeHookExecution("first.ts"),
        parsed: {
          decision: "block",
          reason: "first",
          systemMessage: "Task state needs attention.",
          hookSpecificOutput: {
            decision: "block",
            additionalContext: "Task state needs attention.",
          },
        },
      },
    ]

    const finalResponse: Record<string, any> = {}
    const executions: HookExecution[] = []
    processBlockingResults(results, executions, finalResponse, "PreToolUse")
    expect(finalResponse.systemMessage).toBe("Task state needs attention.")
  })

  it("merges first block additionalContext into systemMessage", () => {
    const results = [
      {
        execution: makeHookExecution("first.ts"),
        parsed: {
          decision: "block",
          reason: "first",
          stopReason: "blocked",
          hookSpecificOutput: {
            decision: "block",
            additionalContext: "first-block-only-context",
          },
        },
      },
    ]

    const finalResponse: Record<string, any> = {}
    const executions: HookExecution[] = []
    processBlockingResults(results, executions, finalResponse, "Stop")
    expect(finalResponse.systemMessage).toContain("first-block-only-context")
    expect(finalResponse.decision).toBe("block")
    expect(finalResponse.reason).toBe("first")
  })

  it("merges first and second block additionalContext into systemMessage", () => {
    const results = [
      {
        execution: makeHookExecution("a.ts"),
        parsed: {
          decision: "block",
          reason: "a",
          stopReason: "blocked",
          hookSpecificOutput: {
            decision: "block",
            additionalContext: "from-first",
          },
        },
      },
      {
        execution: makeHookExecution("b.ts"),
        parsed: {
          decision: "block",
          reason: "b",
          stopReason: "blocked",
          hookSpecificOutput: {
            decision: "block",
            additionalContext: "from-second",
          },
        },
      },
    ]

    const finalResponse: Record<string, any> = {}
    const executions: HookExecution[] = []
    processBlockingResults(results, executions, finalResponse, "Stop")
    expect(finalResponse.systemMessage).toContain("from-first")
    expect(finalResponse.systemMessage).toContain("from-second")
    expect(finalResponse.reason).toBe("a")
  })

  it("appends first block additionalContext after existing systemMessage", () => {
    const results = [
      {
        execution: makeHookExecution("one.ts"),
        parsed: {
          decision: "block",
          reason: "r",
          stopReason: "blocked",
          systemMessage: "top-level-msg",
          hookSpecificOutput: {
            decision: "block",
            additionalContext: "nested-extra",
          },
        },
      },
    ]

    const finalResponse: Record<string, any> = {}
    const executions: HookExecution[] = []
    processBlockingResults(results, executions, finalResponse, "Stop")
    const msg = finalResponse.systemMessage as string
    expect(msg).toContain("top-level-msg")
    expect(msg).toContain("nested-extra")
    expect(msg.indexOf("top-level-msg")).toBeLessThan(msg.indexOf("nested-extra"))
  })

  it("leaves finalResponse empty when there are no results", () => {
    const finalResponse: Record<string, any> = {}
    const executions: HookExecution[] = []
    processBlockingResults([], executions, finalResponse, "Stop")
    expect(finalResponse).toEqual({})
    expect(executions).toEqual([])
  })

  it("records skipped hooks without treating them as blocks", () => {
    const skip = makeHookExecution("skip.ts", "skipped")
    const blockExec = makeHookExecution("block.ts")
    const results = [
      { execution: skip, parsed: null },
      {
        execution: blockExec,
        parsed: {
          decision: "block",
          reason: "stop",
          stopReason: "blocked",
          hookSpecificOutput: { decision: "block", additionalContext: "ctx" },
        },
      },
    ]
    const finalResponse: Record<string, any> = {}
    const executions: HookExecution[] = []
    processBlockingResults(results, executions, finalResponse, "Stop")
    expect(executions).toHaveLength(2)
    expect(executions[0]?.status).toBe("skipped")
    expect(executions[1]?.status).toBe("block")
    expect(finalResponse.reason).toBe("stop")
    expect(finalResponse.systemMessage).toContain("ctx")
  })

  it("does not set systemMessage when first block has no extractable context", () => {
    const results = [
      {
        execution: makeHookExecution("b.ts"),
        parsed: {
          decision: "block",
          reason: "only-reason",
          stopReason: "blocked",
          hookSpecificOutput: { decision: "block" },
        },
      },
    ]
    const finalResponse: Record<string, any> = {}
    processBlockingResults(results, [], finalResponse, "Stop")
    expect(finalResponse.systemMessage).toBeUndefined()
    expect(finalResponse.reason).toBe("only-reason")
  })

  it("ignores whitespace-only additionalContext for merge", () => {
    const results = [
      {
        execution: makeHookExecution("b.ts"),
        parsed: {
          decision: "block",
          reason: "r",
          stopReason: "blocked",
          systemMessage: "top",
          hookSpecificOutput: { decision: "block", additionalContext: "  \t  " },
        },
      },
    ]
    const finalResponse: Record<string, any> = {}
    processBlockingResults(results, [], finalResponse, "Stop")
    expect(finalResponse.systemMessage).toBe("top")
  })

  it("treats continue false as a block and still merges nested context", () => {
    const results = [
      {
        execution: makeHookExecution("c.ts"),
        parsed: {
          continue: false,
          reason: "nope",
          hookSpecificOutput: {
            additionalContext: "from-continue-false",
          },
        },
      },
    ]
    const finalResponse: Record<string, any> = {}
    processBlockingResults(results, [], finalResponse, "Stop")
    expect(finalResponse.systemMessage).toContain("from-continue-false")
    expect(finalResponse.continue).toBe(false)
  })

  it("detects block from hookSpecificOutput.decision only", () => {
    const results = [
      {
        execution: makeHookExecution("nested.ts"),
        parsed: {
          hookSpecificOutput: {
            decision: "block",
            reason: "inner",
            additionalContext: "nested-block-ctx",
          },
        },
      },
    ]
    const finalResponse: Record<string, any> = {}
    const executions: HookExecution[] = []
    processBlockingResults(results, executions, finalResponse, "Stop")
    expect(executions[0]?.status).toBe("block")
    expect(finalResponse.systemMessage).toContain("nested-block-ctx")
  })

  it("orders non-block context before first block context in systemMessage", () => {
    const results = [
      {
        execution: makeHookExecution("allow.ts"),
        parsed: {
          hookSpecificOutput: { additionalContext: "pre-block" },
        },
      },
      {
        execution: makeHookExecution("block.ts"),
        parsed: {
          decision: "block",
          reason: "first",
          stopReason: "blocked",
          hookSpecificOutput: {
            decision: "block",
            additionalContext: "from-block",
          },
        },
      },
    ]
    const finalResponse: Record<string, any> = {}
    processBlockingResults(results, [], finalResponse, "Stop")
    const msg = finalResponse.systemMessage as string
    expect(msg.indexOf("pre-block")).toBeLessThan(msg.indexOf("from-block"))
  })

  it("stably shuffles three merged contexts in a time window", () => {
    const originalNow = Date.now
    Date.now = () => 1_710_000_000_000
    try {
      const results = [
        {
          execution: makeHookExecution("a.ts"),
          parsed: {
            hookSpecificOutput: { additionalContext: "alpha" },
          },
        },
        {
          execution: makeHookExecution("b.ts"),
          parsed: {
            hookSpecificOutput: { additionalContext: "beta" },
          },
        },
        {
          execution: makeHookExecution("c.ts"),
          parsed: {
            hookSpecificOutput: { additionalContext: "gamma" },
          },
        },
      ]
      const finalResponse: Record<string, any> = {}
      processBlockingResults(results, [], finalResponse, "Stop")
      expect(finalResponse.systemMessage).toBe(
        orderHookContexts(["alpha", "beta", "gamma"], "Stop").join("\n\n")
      )
    } finally {
      Date.now = originalNow
    }
  })

  it("records aborted hooks without merging their parsed output", () => {
    const aborted = makeHookExecution("gone.ts", "aborted")
    const results = [
      { execution: aborted, parsed: { decision: "block", reason: "ignored" } },
      {
        execution: makeHookExecution("real.ts"),
        parsed: {
          decision: "block",
          reason: "winner",
          stopReason: "blocked",
          hookSpecificOutput: { decision: "block", additionalContext: "ac" },
        },
      },
    ]
    const finalResponse: Record<string, any> = {}
    const executions: HookExecution[] = []
    processBlockingResults(results, executions, finalResponse, "Stop")
    expect(executions[0]?.status).toBe("aborted")
    expect(finalResponse.reason).toBe("winner")
    expect(finalResponse.systemMessage).toContain("ac")
  })

  it("handles null parsed after a passing hook with no output", () => {
    const results = [
      { execution: makeHookExecution("empty.ts"), parsed: null },
      {
        execution: makeHookExecution("block.ts"),
        parsed: {
          decision: "block",
          reason: "x",
          stopReason: "blocked",
          hookSpecificOutput: { decision: "block", additionalContext: "c" },
        },
      },
    ]
    const finalResponse: Record<string, any> = {}
    const executions: HookExecution[] = []
    processBlockingResults(results, executions, finalResponse, "Stop")
    expect(executions).toHaveLength(2)
    expect(executions[0]?.status).toBe("ok")
    expect(finalResponse.systemMessage).toBe("c")
  })

  it("sets hookSpecificOutput for PostToolUse-style context-only aggregation", () => {
    const results = [
      {
        execution: makeHookExecution("posttooluse-git-context.ts"),
        parsed: {
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: "On branch main tracking origin/main. The working tree is clean.",
          },
          systemMessage: "On branch main tracking origin/main. The working tree is clean.",
          suppressOutput: true,
        },
      },
    ]
    const finalResponse: Record<string, any> = {}
    processBlockingResults(results, [], finalResponse, "PostToolUse")
    const hso = finalResponse.hookSpecificOutput as Record<string, any>
    expect(hso?.hookEventName).toBe("PostToolUse")
    expect(hso?.additionalContext).toBe(
      "On branch main tracking origin/main. The working tree is clean."
    )
    expect(finalResponse.systemMessage).toContain("On branch main")
  })
})

describe("preparePreToolHints", () => {
  it("drops hints already present as context", () => {
    expect(
      preparePreToolHints(["No open task yet.", "Keep going."], ["No open task yet."])
    ).toEqual(["Keep going."])
  })

  it("collapses repetitive continue-mode hints into a guardrail summary", () => {
    const hints = preparePreToolHints(
      [
        "Proceed in diagnostic-ownership mode: fix or prove diagnostic claims.",
        "Remain in direct-tool-invocation mode.",
        "Stay in ditto-preferred copy mode.",
        "Carry on in commit-backed issue-closure mode.",
      ],
      []
    )
    const expectedSummary = [
      "Active guardrails: diagnostic-ownership; direct-tool-invocation; ditto-preferred copy; ",
      "commit-backed issue-closure.",
    ].join("")
    expect(hints).toEqual([expectedSummary])
  })
})

describe("BlockingStrategy stop aggregation", () => {
  it("formats aggregated stop blocks with one footer and named sections", () => {
    const footer =
      "You must act on this now. Do not try to stop again without completing the required action."
    const results = [
      {
        execution: makeHookExecution("hooks/stop-ship-checklist.ts"),
        parsed: {
          decision: "block",
          reason: [
            "You cannot stop until everything below is resolved. Follow the single action plan in order.",
            "",
            "### Repository",
            "Commit and push work.",
            "",
            footer,
          ].join("\n"),
        },
      },
      {
        execution: makeHookExecution("hooks/stop-quality-checks.ts"),
        parsed: {
          decision: "block",
          reason: `Quality checks failed.\n\n${footer}`,
        },
      },
    ]

    const finalResponse: Record<string, any> = {}
    const executions: HookExecution[] = []
    processAggregatedStopResults(results, executions, finalResponse, "Stop")

    const reason = finalResponse.reason as string
    expect(finalResponse.decision).toBe("block")
    expect(reason).toContain("Stop is blocked by 2 checks.")
    expect(reason).toContain("### ship checklist")
    expect(reason).toContain("### quality checks")
    expect(reason).not.toContain(
      "You cannot stop until everything below is resolved. Follow the single action plan in order.\n\n### Repository"
    )
    expect(reason.match(/You must act on this now/g)).toHaveLength(1)
  })

  it("stop events must NOT abort on first block — they aggregate all responses", () => {
    // Stop events use a collection window (STOP_COLLECTION_TIMEOUT_MS) to let all
    // hooks race fairly. Slower hooks like stop-personal-repo-issues (GitHub API)
    // were previously starved by fast file-based checks that blocked first.
    //
    // The onResult for stop events must be undefined (no early abort).
    // Non-stop events still abort on first block.
    // BlockingStrategy was extracted to blockingStrategy.ts — read that file.
    const source = readFileSync(join(import.meta.dir, "blockingStrategy.ts"), "utf-8")

    // The BlockingStrategy must use processAggregatedStopResults for stop events
    expect(source).toContain("processAggregatedStopResults")

    // Non-stop events must still abort on first block
    const nonStopAbort = source.match(
      /onResult:\s*isStop\s*\?\s*undefined\s*:\s*\(result,\s*abort\)\s*=>/
    )
    expect(nonStopAbort).not.toBeNull()

    // Stop events must use a collection timeout
    expect(source).toContain("STOP_COLLECTION_TIMEOUT_MS")
    expect(source).toContain("collectionTimeoutMs: isStop ? STOP_COLLECTION_TIMEOUT_MS")
  })
})
