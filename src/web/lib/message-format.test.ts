import { describe, expect, test } from "bun:test"
import { splitUserMessage } from "./message-format.ts"

describe("ambient browser transcript context", () => {
  test("separates ambient page state from the user request", () => {
    const parts = splitUserMessage(
      [
        '<in-app-browser-context source="ambient-ui-state">',
        "This block is automatically supplied ambient UI state, not part of the user's request.",
        "# In app browser:",
        "- The user has the in-app browser open with 2 tabs.",
        "- Current URL: http://localhost:3100/admin/calendars?market=France",
        "</in-app-browser-context>",
        "",
        "## My request:",
        "Show calendar coverage.",
      ].join("\n")
    )

    expect(parts.visibleText).toBe("## My request:\nShow calendar coverage.")
    expect(parts.metadataBlocks).toEqual([
      {
        title: "Ambient browser context",
        details: [
          { label: "source", value: "ambient-ui-state" },
          { label: "tabs", value: "2" },
          {
            label: "current URL",
            value: "http://localhost:3100/admin/calendars?market=France",
          },
        ],
        notes: ["Automatically supplied page state; separate from the user request."],
        kind: "ambientBrowser",
      },
    ])
  })
})
