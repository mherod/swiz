import { describe, expect, test } from "bun:test"
import { parseAntigravityJsonlEntries } from "./transcript-analysis-parse-part2.ts"

describe("parseAntigravityJsonlEntries", () => {
  test("parses user, assistant, tool-use, and tool-result records", () => {
    const transcript = [
      JSON.stringify({
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-08-01T21:00:00Z",
        content: "<USER_REQUEST>Inspect this file</USER_REQUEST>",
      }),
      JSON.stringify({
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        created_at: "2026-08-01T21:00:01Z",
        content: "I will inspect it.",
        tool_calls: [{ name: "read_file", args: '{"path":"src/index.ts"}' }],
      }),
      JSON.stringify({
        step_index: 2,
        source: "MODEL",
        type: "TOOL_RESPONSE",
        created_at: "2026-08-01T21:00:02Z",
        content: "export const ready = true",
      }),
    ].join("\n")

    expect(parseAntigravityJsonlEntries(transcript)).toEqual([
      {
        type: "user",
        timestamp: "2026-08-01T21:00:00Z",
        message: { role: "user", content: "Inspect this file" },
      },
      {
        type: "assistant",
        timestamp: "2026-08-01T21:00:01Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I will inspect it." },
            {
              type: "tool_use",
              id: "call_1_1",
              name: "read_file",
              input: { path: "src/index.ts" },
            },
          ],
        },
      },
      {
        type: "user",
        timestamp: "2026-08-01T21:00:02Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1_1",
              content: "export const ready = true",
            },
          ],
        },
      },
    ])
  })

  test("ignores malformed and unsupported records", () => {
    const transcript = [
      "not-json",
      JSON.stringify({ source: "MODEL", type: "PLANNER_RESPONSE", content: "" }),
      JSON.stringify({ source: "SYSTEM", type: "STATUS", content: "working" }),
    ].join("\n")

    expect(parseAntigravityJsonlEntries(transcript)).toEqual([])
  })
})
