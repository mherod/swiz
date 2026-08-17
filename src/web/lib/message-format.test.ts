import { describe, expect, test } from "bun:test"
import { splitAssistantMessage, splitUserMessage } from "./message-format.ts"

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

describe("inline skill links", () => {
  test("turns a matching local skill link into structured skill use beside ambient context", () => {
    const parts = splitUserMessage(
      [
        '<in-app-browser-context source="ambient-ui-state">',
        "This block is automatically supplied ambient UI state, not part of the user's request.",
        "# In app browser:",
        "- The user has the in-app browser open with 1 tab.",
        "- Current URL: http://localhost:7943/?view=transcript",
        "</in-app-browser-context>",
        "",
        "## My request:",
        "[$push](/Users/me/.agents/skills/push/SKILL.md)",
      ].join("\n")
    )

    expect(parts.visibleText).toBe("## My request:")
    expect(parts.attachedSkills).toEqual({
      title: "Skill use",
      skills: [{ name: "push", path: "/Users/me/.agents/skills/push/SKILL.md" }],
      notes: [],
    })
    expect(parts.metadataBlocks[0]?.kind).toBe("ambientBrowser")
  })

  test("merges valid skill links with manually attached skills", () => {
    const parts = splitUserMessage(
      [
        "<manually_attached_skills>",
        "Skill Name: commit",
        "Path: /Users/me/.agents/skills/commit/SKILL.md",
        "</manually_attached_skills>",
        "",
        "Use [$push](/Users/me/.agents/skills/push/SKILL.md) and",
        "[$apply-a11y](/Users/me/.agents/skills/apply-a11y/SKILL.md).",
      ].join("\n")
    )

    expect(parts.visibleText).toBe("Use $push and\n$apply-a11y.")
    expect(parts.attachedSkills).toEqual({
      title: "Skills (3)",
      skills: [
        { name: "commit", path: "/Users/me/.agents/skills/commit/SKILL.md" },
        { name: "push", path: "/Users/me/.agents/skills/push/SKILL.md" },
        { name: "apply-a11y", path: "/Users/me/.agents/skills/apply-a11y/SKILL.md" },
      ],
      notes: [],
    })
  })

  test("leaves ordinary, mismatched, remote, and code-quoted links as user text", () => {
    const text = [
      "[push](/Users/me/.agents/skills/push/SKILL.md)",
      "[$push](https://example.com/skills/push/SKILL.md)",
      "[$push](/Users/me/.agents/skills/commit/SKILL.md)",
      "[$push](/Users/me/.agents/skills/push/README.md)",
      "`[$push](/Users/me/.agents/skills/push/SKILL.md)`",
      "```md",
      "[$push](/Users/me/.agents/skills/push/SKILL.md)",
      "```",
    ].join("\n")

    const parts = splitUserMessage(text)

    expect(parts.visibleText).toBe(text)
    expect(parts.attachedSkills).toBeNull()
  })

  test("does not classify a skill-looking link inside hook context", () => {
    const parts = splitUserMessage(
      [
        "Ship the change.",
        "<hook_context>",
        "[$push](/Users/me/.agents/skills/push/SKILL.md)",
        "</hook_context>",
      ].join("\n")
    )

    expect(parts.visibleText).toBe("Ship the change.")
    expect(parts.attachedSkills).toBeNull()
  })
})

const validMemoryCitation = [
  "<oai-mem-citation>",
  "<citation_entries>",
  "MEMORY.md:133-137|note=[located the prior OPS-023 requirements rollout]",
  "rollout_summaries/2026-08-15T11-02-27-61tl-admin_requirements_contract_pr_166.md:24-35|note=[OPS-023 history and atomic requirements validation context]",
  "</citation_entries>",
  "<rollout_ids>",
  "01a00516-6155-74a0-a90b-4dfcda82376f",
  "</rollout_ids>",
  "</oai-mem-citation>",
].join("\n")

describe("assistant memory citations", () => {
  test("separates a valid trailing memory citation from assistant prose", () => {
    const parts = splitAssistantMessage(
      ["Committed all remaining changes.", "", validMemoryCitation].join("\n")
    )

    expect(parts.visibleText).toBe("Committed all remaining changes.")
    expect(parts.memoryCitation).toEqual({
      entries: [
        {
          path: "MEMORY.md",
          lineStart: 133,
          lineEnd: 137,
          note: "located the prior OPS-023 requirements rollout",
        },
        {
          path: "rollout_summaries/2026-08-15T11-02-27-61tl-admin_requirements_contract_pr_166.md",
          lineStart: 24,
          lineEnd: 35,
          note: "OPS-023 history and atomic requirements validation context",
        },
      ],
      rolloutIds: ["01a00516-6155-74a0-a90b-4dfcda82376f"],
    })
  })

  test("allows an empty rollout id section", () => {
    const withoutRollout = validMemoryCitation.replace("01a00516-6155-74a0-a90b-4dfcda82376f\n", "")

    expect(splitAssistantMessage(withoutRollout).memoryCitation?.rolloutIds).toEqual([])
  })

  test("keeps malformed or unsafe memory citations visible", () => {
    const fence = String.fromCharCode(96).repeat(3)
    const malformedVariants = [
      validMemoryCitation.replace("MEMORY.md", "/Users/me/MEMORY.md"),
      validMemoryCitation.replace("01a00516-6155-74a0-a90b-4dfcda82376f", "not-a-rollout"),
      validMemoryCitation.replace("133-137", "137-133"),
      `${validMemoryCitation}\nFollow-up prose.`,
      [`${fence}xml`, validMemoryCitation, fence].join("\n"),
    ]

    for (const text of malformedVariants) {
      const parts = splitAssistantMessage(text)
      expect(parts.memoryCitation).toBeNull()
      expect(parts.visibleText).toContain("<oai-mem-citation>")
    }
  })
})
