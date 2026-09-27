import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import tsQuality from "../../hooks/pretooluse-ts-quality.ts"
import { getAgent, inferAgentFromToolNames } from "../agents.ts"
import { preToolUseDeny } from "../SwizHook.ts"
import { fileEditHookInputSchema } from "../schemas.ts"
import { extractFileEditTargetPaths, isFileEditTool } from "../tool-matchers.ts"
import { computeProjectedContent } from "../utils/edit-projection.ts"
import { useTempDir } from "../utils/test-utils.ts"
import {
  assertNormalizedDispatchPayload,
  parseValidatedAgentDispatchWireJson,
} from "./dispatch-zod-surfaces.ts"
import { groupMatches } from "./engine.ts"
import { executeDispatch } from "./execute.ts"
import { normalizeAgentHookPayload } from "./payload-normalize.ts"

const { create } = useTempDir("swiz-antigravity-")
const replacement = {
  TargetContent: "const value = 1",
  ReplacementContent: "// @ts-nocheck\nconst value = 2",
  StartLine: 1,
  EndLine: 1,
  AllowMultiple: false,
}
const edits = [
  ["replace_file_content", { ...replacement }],
  ["multi_replace_file_content", { ReplacementChunks: [replacement] }],
  ["write_to_file", { CodeContent: replacement.ReplacementContent, Overwrite: true }],
] as const

function payloadFor(name: string, args: Record<string, unknown>): Record<string, any> {
  return {
    conversationId: "antigravity-test-session",
    workspacePaths: ["/workspace"],
    transcriptPath: "/workspace/transcript.json",
    modelName: "test-model",
    stepIdx: 3,
    toolCall: {
      name,
      args: { TargetFile: "/workspace/file.ts", Description: "Edit file", ...args },
    },
  }
}

describe("Antigravity file hooks", () => {
  test.each(edits)("normalizes %s without mutating the native arguments", async (name, args) => {
    const payload = payloadFor(name, args)
    const originalCall = structuredClone(payload.toolCall)
    normalizeAgentHookPayload(payload)
    const normalized = structuredClone(payload)
    normalizeAgentHookPayload(payload)
    expect(payload).toEqual(normalized)
    expect(payload.toolCall).toEqual(originalCall)
    expect(payload).toMatchObject({
      session_id: "antigravity-test-session",
      cwd: "/workspace",
      transcript_path: "/workspace/transcript.json",
      model: "test-model",
      tool_name: name,
      tool_input: { file_path: "/workspace/file.ts", Description: "Edit file" },
    })
    for (const event of ["preToolUse", "postToolUse"]) {
      expect(assertNormalizedDispatchPayload(event, payload).tool_name).toBe(name)
    }
    expect(isFileEditTool(name)).toBe(true)
    expect(
      groupMatches({ event: "preToolUse", matcher: "Edit|Write", hooks: [] }, name, undefined)
    ).toBe(true)
    expect(extractFileEditTargetPaths(payload.tool_input)).toEqual(["/workspace/file.ts"])
    expect(inferAgentFromToolNames([name])?.id).toBe("antigravity")
    const response = await tsQuality.run(fileEditHookInputSchema.parse(payload))
    expect(
      parseValidatedAgentDispatchWireJson(response, "preToolUse", "PreToolUse", "antigravity")
    ).toMatchObject({ decision: "deny" })
  })

  test("preserves canonical envelopes and tolerates malformed native tool calls", () => {
    const payload = {
      ...payloadFor("write_to_file", {}),
      tool_name: "Read",
      tool_input: { file_path: "/other" },
    }
    normalizeAgentHookPayload(payload)
    expect(payload.tool_name).toBe("Read")
    expect(payload.tool_input).toEqual({ file_path: "/other" })
    for (const toolCall of [null, [], { name: 4 }, { name: "write_to_file", args: "bad" }]) {
      const malformed: Record<string, any> = { toolCall }
      expect(() => normalizeAgentHookPayload(malformed)).not.toThrow()
      expect(malformed.tool_name).toBeUndefined()
    }
  })

  test("keeps every replacement chunk visible to content guards", async () => {
    const payload = payloadFor("multi_replace_file_content", {
      ReplacementChunks: [
        { ...replacement, ReplacementContent: "const value = 2" },
        { ...replacement, StartLine: 3, EndLine: 3 },
      ],
    })
    normalizeAgentHookPayload(payload)
    expect(payload.tool_input.new_string).toBe(`const value = 2\n${replacement.ReplacementContent}`)
    const result = await tsQuality.run(fileEditHookInputSchema.parse(payload))
    expect(result).toHaveProperty("hookSpecificOutput.permissionDecision", "deny")
  })

  test.each([
    false,
    true,
  ])("preserves file-edit advice and skill denials (skill gate: %s)", async (skillGate) => {
    const cwd = await create()
    const payload = payloadFor("write_to_file", { CodeContent: replacement.ReplacementContent })
    payload.workspacePaths = [cwd]
    payload._agent = "antigravity"
    const { response } = await executeDispatch({
      canonicalEvent: "preToolUse",
      hookEventName: "PreToolUse",
      daemonContext: true,
      payloadStr: JSON.stringify(payload),
      settingsHomeOverride: await create(),
      manifestProvider: async () => [
        {
          event: "preToolUse",
          matcher: "Edit|Write",
          hooks: [
            {
              hook: skillGate
                ? {
                    name: "pretooluse-synthetic-skill-gate",
                    event: "preToolUse",
                    run: () => preToolUseDeny("Use the required skill before adding ts-nocheck"),
                  }
                : tsQuality,
            },
          ],
        },
      ],
      repositoryCapabilityProvider: async () => ({
        canonicalRoot: cwd,
        repoKey: cwd,
        isRepo: true,
        repoSlug: null,
        hasGhCli: false,
        resolvedAt: Date.now(),
      }),
      replayPendingMutations: async () => {},
    })
    expect(response.hookExecutions).toHaveLength(1)
    const wire = parseValidatedAgentDispatchWireJson(
      response,
      "preToolUse",
      "PreToolUse",
      "antigravity"
    )
    expect(wire.decision).toBe(skillGate ? "deny" : undefined)
    expect(wire.reason).toContain("ts-nocheck")
    expect(wire).not.toHaveProperty("hookSpecificOutput")
  })
})

describe("Antigravity edit projection", () => {
  test("restricts replacement to the requested original lines and preserves literal dollars", async () => {
    const path = join(await create(), "file.ts")
    await Bun.write(path, "same\nsame same\ntail\n")
    const payload = payloadFor("replace_file_content", {
      ...replacement,
      TargetFile: path,
      TargetContent: "same",
      ReplacementContent: "$&",
      StartLine: 2,
      EndLine: 2,
      AllowMultiple: true,
    })
    normalizeAgentHookPayload(payload)
    expect(await computeProjectedContent(payload.tool_name, path, payload.tool_input)).toBe(
      "same\n$& $&\ntail\n"
    )
  })

  test("projects multiple chunks against original line numbers", async () => {
    const path = join(await create(), "file.ts")
    await Bun.write(path, "first\nmiddle\nlast\n")
    const payload = payloadFor("multi_replace_file_content", {
      TargetFile: path,
      ReplacementChunks: [
        { ...replacement, TargetContent: "first", ReplacementContent: "one\ntwo" },
        {
          ...replacement,
          TargetContent: "last",
          ReplacementContent: "end",
          StartLine: 3,
          EndLine: 3,
        },
      ],
    })
    normalizeAgentHookPayload(payload)
    expect(await computeProjectedContent(payload.tool_name, path, payload.tool_input)).toBe(
      "one\ntwo\nmiddle\nend\n"
    )
  })

  test("declines ambiguous, missing, overlapping, and invalid-range projections", async () => {
    const path = join(await create(), "file.ts")
    await Bun.write(path, "same same\n")
    for (const chunk of [
      { ...replacement, TargetContent: "same" },
      { ...replacement, TargetContent: "missing" },
      { ...replacement, StartLine: 0 },
      { ...replacement, EndLine: 100 },
    ]) {
      const payload = payloadFor("replace_file_content", { TargetFile: path, ...chunk })
      normalizeAgentHookPayload(payload)
      expect(await computeProjectedContent(payload.tool_name, path, payload.tool_input)).toBeNull()
    }
    const chunk = { ...replacement, TargetContent: "same same" }
    const payload = payloadFor("multi_replace_file_content", {
      TargetFile: path,
      ReplacementChunks: [chunk, chunk],
    })
    normalizeAgentHookPayload(payload)
    expect(await computeProjectedContent(payload.tool_name, path, payload.tool_input)).toBeNull()
  })

  test("projects empty writes and append operations", async () => {
    const path = join(await create(), "file.ts")
    await Bun.write(path, "existing\n")
    for (const [CodeContent, Append, expected] of [
      ["", false, ""],
      ["next\n", true, "existing\nnext\n"],
    ] as const) {
      const payload = payloadFor("write_to_file", { TargetFile: path, CodeContent, Append })
      normalizeAgentHookPayload(payload)
      expect(await computeProjectedContent(payload.tool_name, path, payload.tool_input)).toBe(
        expected
      )
    }
  })
})

test("Antigravity output preserves permission defaults and keeps post-tool output empty", () => {
  const wire = (response: Record<string, unknown>, event = "preToolUse") =>
    parseValidatedAgentDispatchWireJson(
      response,
      event,
      getAgent("antigravity")!.eventMap[event]!,
      "antigravity"
    )
  expect(wire({})).toEqual({})
  expect(wire({ systemMessage: "Advice" })).toEqual({ reason: "Advice" })
  expect(wire({ decision: "block", reason: "Blocked" })).toEqual({
    decision: "deny",
    reason: "Blocked",
  })
  expect(
    wire({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } })
  ).toEqual({ decision: "ask" })
  expect(wire({ decision: "block", reason: "Already ran" }, "postToolUse")).toEqual({})
})
