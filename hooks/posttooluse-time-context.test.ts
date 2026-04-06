import { describe, expect, test } from "bun:test"
import { runHook } from "../src/utils/test-utils.ts"

describe("posttooluse-time-context", () => {
  test("emits the current time with descriptor and moon phase", async () => {
    const result = await runHook("hooks/posttooluse-time-context.ts", {
      tool_name: "Read",
      tool_input: { file_path: "/tmp/example.txt" },
      cwd: "/tmp",
    })

    expect(result.exitCode).toBe(0)
    expect(result.json?.hookSpecificOutput?.hookEventName).toBe("PostToolUse")
    expect(result.json?.hookSpecificOutput?.additionalContext).toMatch(
      /^Current time: [A-Za-z]{3,9} \d{1,2}, \d{4} at \d{1,2}:\d{2}:\d{2} [AP]M — (morning ☀️|afternoon 🌤️|evening 🌆|night 🌙) — Moon (🌑|🌒|🌓|🌔|🌕|🌖|🌗|🌘)$/
    )
  })
})
