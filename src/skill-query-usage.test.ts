import { describe, expect, it } from "bun:test"
import { extractSkillNameFromSkillQuery, extractSkillQueryNames } from "./skill-query-usage.ts"
import {
  collectCurrentSessionUsageEvents,
  computeSummaryFromSessionLines,
  getRecentSkillsUsedForCurrentSession,
  getSuccessfulToolCalls,
  hasAgentDirectlyReadOrInvokedSkill,
  toolLoadsSkill,
} from "./transcript-summary.ts"

const NOW = Date.parse("2026-09-11T12:00:00Z")
const TOOL = "mcp__swiz__SkillQuery"

function codexCall(name: string, input: object | string, now = NOW): string {
  const payload =
    typeof input === "string"
      ? { type: "custom_tool_call", input }
      : { type: "function_call", arguments: JSON.stringify(input) }
  return JSON.stringify({
    type: "response_item",
    timestamp: new Date(now).toISOString(),
    payload: { ...payload, call_id: "skill-call", name },
  })
}

function source(lines: string[]) {
  return { _transcriptSummary: computeSummaryFromSessionLines(lines) }
}

describe("SkillQuery read recognition", () => {
  it.each([
    "SkillQuery",
    TOOL,
    "mcp__swiz.SkillQuery",
    "functions.SkillQuery",
    `functions.${TOOL}`,
  ])("recognizes the provider tool name %s", (toolName) => {
    expect(extractSkillNameFromSkillQuery(toolName, { name: " commit " })).toBe("commit")
    expect(extractSkillNameFromSkillQuery(toolName, { action: "read", name: "push" })).toBe("push")
  })

  it.each([
    {},
    { query: "commit" },
    { action: "list" },
    { action: "list", name: "commit" },
    { action: "lookup", name: "commit" },
    { action: "read" },
    { name: "   " },
    { name: "commit", query: "commit" },
    { name: "commit", offset: 0 },
    { name: "commit", limit: 5 },
  ])("does not credit browsing or invalid read input %j", (input) => {
    expect(extractSkillNameFromSkillQuery(TOOL, input)).toBeNull()
  })

  it("does not confuse unrelated tools with SkillQuery", () => {
    expect(extractSkillNameFromSkillQuery("OtherSkillQuery", { name: "commit" })).toBeNull()
    expect(extractSkillNameFromSkillQuery("mcp__other__SkillQuery", { name: "commit" })).toBeNull()
  })

  it("recognizes batched literal exec reads with quoted keys and deduplicates names", () => {
    const code = `await Promise.all([
      tools.mcp__swiz__SkillQuery({ name: "commit", args: ["fix: braces }"], }),
      tools["mcp__swiz__SkillQuery"]({ 'action': 'read', 'name': 'push', noFrontMatter: true }),
      tools.mcp__swiz__SkillQuery({name: "commit"}),
      tools.mcp__swiz__SkillQuery({action: "lookup", name: "unused"})
    ]);`
    expect(extractSkillQueryNames("functions.exec", { code })).toEqual(["commit", "push"])
    expect(extractSkillQueryNames("exec", { input: code })).toEqual(["commit", "push"])
  })

  it.each([
    "const example = \"tools.mcp__swiz__SkillQuery({name: 'commit'})\";",
    '// tools.mcp__swiz__SkillQuery({name: "commit"})',
    '/* tools.mcp__swiz__SkillQuery({name: "commit"}) */',
    "tools.mcp__swiz__SkillQuery({name: variable})",
    'tools.mcp__swiz__SkillQuery({name: "commit", action: variable})',
    'tools.mcp__swiz__SkillQuery({name: "commit", ...options})',
    "tools.mcp__swiz__SkillQuery({name: `commit-${suffix}`})",
    'tools.mcp__swiz__SkillQuery({name: "commit"}',
  ])("does not infer a read from quoted or ambiguous code %s", (code) => {
    expect(extractSkillQueryNames("exec", { code })).toEqual([])
  })
})

describe("SkillQuery transcript usage", () => {
  it.each([
    JSON.stringify({
      type: "assistant",
      timestamp: new Date(NOW).toISOString(),
      message: { content: [{ type: "tool_use", name: TOOL, input: { name: "commit" } }] },
    }),
    codexCall(TOOL, { name: "commit" }),
    codexCall("functions.exec", 'text(await tools.mcp__swiz__SkillQuery({name:"commit"}));'),
    codexCall("exec", { code: 'text(await tools.mcp__swiz__SkillQuery({name:"commit"}));' }),
  ])("feeds summaries, recency and loaded-skill context across providers", async (line) => {
    const payload = source([line])
    expect(payload._transcriptSummary.skillInvocations).toEqual(["commit"])
    expect(
      collectCurrentSessionUsageEvents([line]).filter((event) => event.kind === "skill")
    ).toMatchObject([{ value: "commit", source: "agent", timestamp: new Date(NOW).toISOString() }])
    expect(await getRecentSkillsUsedForCurrentSession(payload, { nowMs: NOW })).toEqual(["commit"])
    expect(hasAgentDirectlyReadOrInvokedSkill(payload, "commit")).toBe(true)
  })

  it("keeps metadata lookups out of summaries and context", async () => {
    const payload = source([codexCall(TOOL, { action: "lookup", name: "commit" })])
    expect(payload._transcriptSummary.skillInvocations).toEqual([])
    expect(await getRecentSkillsUsedForCurrentSession(payload, { nowMs: NOW })).toEqual([])
    expect(hasAgentDirectlyReadOrInvokedSkill(payload, "commit")).toBe(false)
  })

  it("expires reads outside the time or turn window", async () => {
    const expired = source([codexCall(TOOL, { name: "commit" }, NOW - 21 * 60_000)])
    expect(await getRecentSkillsUsedForCurrentSession(expired, { nowMs: NOW })).toEqual([])
    const turns = Array.from({ length: 31 }, () =>
      JSON.stringify({ type: "user", message: { content: "Continue" } })
    )
    const oldTurn = source([
      codexCall(TOOL, { name: "commit" }),
      ...turns,
      codexCall("Read", { file_path: "/project/README.md" }),
    ])
    expect(await getRecentSkillsUsedForCurrentSession(oldTurn, { nowMs: NOW })).toEqual([])
  })

  it.each([
    TOOL,
    "functions.exec",
  ])("strict prerequisites still require a successful %s result", (name) => {
    const input =
      name === TOOL
        ? { name: "update-memory" }
        : 'text(await tools.mcp__swiz__SkillQuery({name:"update-memory"}));'
    const call = codexCall(name, input)
    const loads = (lines: string[]) =>
      getSuccessfulToolCalls(lines, {}, { nowMs: NOW }).some((block) =>
        toolLoadsSkill(block.name ?? "", block.input, "update-memory", null)
      )
    const result = (isError: boolean) =>
      JSON.stringify({
        type: "response_item",
        payload: {
          type: name === TOOL ? "function_call_output" : "custom_tool_call_output",
          call_id: "skill-call",
          output: JSON.stringify({ isError }),
        },
      })
    expect(loads([call])).toBe(false)
    expect(loads([call, result(true)])).toBe(false)
    expect(loads([call, result(false)])).toBe(true)
  })

  it("does not let a successful metadata lookup prove a skill load", () => {
    expect(toolLoadsSkill(TOOL, { action: "lookup", name: "commit" }, "commit", null)).toBe(false)
    expect(
      toolLoadsSkill(
        "functions.exec",
        {
          code: 'await tools.mcp__swiz__SkillQuery({action:"lookup",name:"commit"})',
        },
        "commit",
        null
      )
    ).toBe(false)
  })
})
