import { describe, expect, test } from "bun:test"
import {
  codexPostToolUseInputSchema,
  codexPreToolUseInputSchema,
  postToolUseHookInputSchema,
  toolHookInputSchema,
} from "./schemas.ts"

describe.each([
  ["Codex pre-tool", codexPreToolUseInputSchema],
  ["Codex post-tool", codexPostToolUseInputSchema],
  ["canonical pre-tool", toolHookInputSchema],
  ["canonical post-tool", postToolUseHookInputSchema],
] as const)("%s argument validation", (_name, schema) => {
  test.each(
    [123, "command", true, [], ["command"]].map((value) => [value])
  )("rejects non-object tool_input %j", (tool_input) => {
    expect(schema.safeParse({ tool_name: "Read", tool_input }).success).toBe(false)
  })

  test("accepts absent arguments and preserves nested extension fields", () => {
    expect(schema.safeParse({ tool_name: "Read" }).success).toBe(true)
    const tool_input = { command: "ｅｃｈｏ", nested: { flags: [true, null, 1] } }
    expect(schema.parse({ tool_name: "Bash", tool_input }).tool_input).toEqual({
      command: "echo",
      nested: { flags: [true, null, 1] },
    })
  })
})
