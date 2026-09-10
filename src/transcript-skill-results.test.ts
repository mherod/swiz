import { describe, expect, test } from "bun:test"
import { getSuccessfulToolCalls, toolLoadsSkill } from "./transcript-summary.ts"

const skillPath = "/project/.skills/update-memory/SKILL.md"
const timestamp = new Date().toISOString()
const source = { session_id: "current", cwd: "/project" }
const encode = (entries: unknown[]) => entries.map((entry) => JSON.stringify(entry))

function codex(
  output: unknown,
  name = "functions.exec_command",
  input: unknown = { cmd: `cat '${skillPath}'` }
) {
  return [
    {
      type: "response_item",
      timestamp,
      payload: { type: "function_call", call_id: "read", name, arguments: JSON.stringify(input) },
    },
    { type: "response_item", payload: { type: "function_call_output", call_id: "read", output } },
  ]
}

describe("successful skill transcript evidence", () => {
  test.each([
    "Exit code: 0\nOutput: instructions",
    JSON.stringify({ exit_code: 0, output: "instructions" }),
  ])("accepts completed Codex shell reads", (output) => {
    const calls = getSuccessfulToolCalls(encode(codex(output)), source)
    expect(calls).toHaveLength(1)
    expect(toolLoadsSkill(calls[0]!.name!, calls[0]!.input, "update-memory", skillPath)).toBe(true)
  })

  test.each([
    "Exit code: 127\nOutput: runtime unavailable",
    "Process exited with code 1",
    JSON.stringify({ exit_code: 1, output: "analyzer unavailable" }),
    JSON.stringify({ isError: true, content: [] }),
  ])("rejects unsuccessful Codex results", (output) => {
    expect(getSuccessfulToolCalls(encode(codex(output)), source)).toEqual([])
  })

  test("recognises a successful Codex custom exec wrapper read", () => {
    const code = `text(await tools.exec_command({cmd: "cat '${skillPath}'"}));`
    const entries = [
      {
        type: "response_item",
        timestamp,
        payload: { type: "custom_tool_call", call_id: "exec", name: "functions.exec", input: code },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "exec",
          output: JSON.stringify({ exit_code: 0, output: "instructions" }),
        },
      },
    ]
    const calls = getSuccessfulToolCalls(encode(entries), source)
    expect(calls).toHaveLength(1)
    expect(toolLoadsSkill(calls[0]!.name!, calls[0]!.input, "update-memory", skillPath)).toBe(true)
  })

  test("rejects pre-compaction, old-turn and context-mismatched calls", () => {
    const entries = codex("Exit code: 0")
    expect(getSuccessfulToolCalls(encode([...entries, { type: "compacted" }]), source)).toEqual([])
    expect(
      getSuccessfulToolCalls(
        encode([
          ...entries,
          ...Array.from({ length: 31 }, () => ({ type: "user", message: { content: "next" } })),
        ]),
        source
      )
    ).toEqual([])
    expect(
      getSuccessfulToolCalls(
        encode([{ type: "turn_context", payload: { cwd: "/other" } }, ...entries]),
        source
      )
    ).toEqual([])
    expect(
      getSuccessfulToolCalls(
        encode([{ type: "session_meta", payload: { id: "other" } }, ...entries]),
        source
      )
    ).toEqual([])
  })

  test("does not treat quoted error examples in successful Read content as errors", () => {
    const entries = [
      {
        type: "assistant",
        timestamp,
        message: {
          content: [
            { type: "tool_use", id: "read", name: "Read", input: { file_path: skillPath } },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "read",
              is_error: false,
              content: 'Examples: {"isError": true} and {"exit_code": 1}',
            },
          ],
        },
      },
    ]
    expect(getSuccessfulToolCalls(encode(entries), source)).toHaveLength(1)
  })

  test("mere file mentions and lookalike paths are not reads", () => {
    expect(toolLoadsSkill("Write", { file_path: skillPath }, "update-memory", skillPath)).toBe(
      false
    )
    expect(
      toolLoadsSkill("Bash", { command: `echo '${skillPath}'` }, "update-memory", skillPath)
    ).toBe(false)
    expect(
      toolLoadsSkill("Read", { file_path: `${skillPath}.bak` }, "update-memory", skillPath)
    ).toBe(false)
  })
})
