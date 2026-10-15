import { expect, test } from "bun:test"
import { sessionTitleFromMessages } from "./session-title.ts"
import type { SessionMessage } from "./utils.ts"

test("titles skip injected context and use the first readable user prompt", () => {
  const messages: SessionMessage[] = [
    { role: "user", timestamp: null, text: "# AGENTS.md instructions for /project\nRules" },
    { role: "user", timestamp: null, text: "<environment_context>cwd</environment_context>" },
    {
      role: "user",
      timestamp: null,
      text: '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>',
    },
    { role: "user", timestamp: null, text: "<recommended_plugins>Plugins</recommended_plugins>" },
    { role: "assistant", timestamp: null, text: "I will investigate" },
    {
      role: "user",
      timestamp: null,
      text: "  Build [SwizBuzz](https://example.test)   for macOS\nMore detail",
    },
  ]
  expect(sessionTitleFromMessages(messages)).toBe("Build SwizBuzz for macOS")
})

test("titles are bounded and missing user prompts retain the client fallback", () => {
  expect(
    sessionTitleFromMessages([{ role: "user", timestamp: null, text: "a".repeat(150) }])
  ).toHaveLength(96)
  expect(
    sessionTitleFromMessages([{ role: "assistant", timestamp: null, text: "Tool output" }])
  ).toBeUndefined()
})
