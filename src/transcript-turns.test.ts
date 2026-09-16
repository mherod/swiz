import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { TMP_ROOT } from "./temp-paths.ts"
import type { TranscriptArgs } from "./transcript-args.ts"
import { loadSessionContent } from "./transcript-turns.ts"
import type { Session } from "./transcript-utils.ts"

const TEST_DIR = join(TMP_ROOT, "swiz-transcript-turns-tests")

function transcriptArgs(overrides: Partial<TranscriptArgs>): TranscriptArgs {
  return {
    sessionQuery: null,
    targetDir: TEST_DIR,
    listOnly: false,
    headCount: undefined,
    tailCount: undefined,
    hours: undefined,
    since: undefined,
    until: undefined,
    autoReply: false,
    includeDebug: false,
    userOnly: false,
    allAgents: false,
    explicitAgents: [],
    ...overrides,
  }
}

describe("loadSessionContent", () => {
  test.each([
    { userOnly: true },
    { userOnly: true, headCount: 2 },
    { userOnly: true, tailCount: 2 },
  ])("reads mixed Codex user formats once with %j", async (options) => {
    const directory = await mkdtemp(join(TMP_ROOT, "swiz-codex-user-turns-"))
    try {
      const path = join(directory, "session.jsonl")
      const messages = ["First request", "Second request"]
      const lines = messages.flatMap((message, index) => {
        const timestamp = `2026-09-16T01:0${index}:00.000Z`
        return [
          {
            type: "response_item",
            timestamp,
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: message }],
            },
          },
          { type: "event_msg", timestamp, payload: { type: "user_message", message } },
          {
            type: "response_item",
            timestamp,
            payload: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Reply" }],
            },
          },
        ].map((entry) => JSON.stringify(entry))
      })
      await Bun.write(path, lines.join("\n"))
      const session: Session = { id: "codex", path, mtime: Date.now(), format: "codex-jsonl" }
      const { turns } = await loadSessionContent(session, transcriptArgs(options), {}, false)

      expect(turns.map((turn) => turn.entry.message?.content)).toEqual(messages)
      const filtered = await loadSessionContent(
        session,
        transcriptArgs(options),
        { from: Date.parse("2026-09-16T01:01:00Z") },
        true
      )
      expect(filtered.turns.map((turn) => turn.entry.message?.content)).toEqual(["Second request"])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("tails JSONL transcript turns without requiring full-file parsing", async () => {
    await rm(TEST_DIR, { recursive: true, force: true })
    await mkdir(TEST_DIR, { recursive: true })
    const path = join(TEST_DIR, "session.jsonl")
    const lines = [
      JSON.stringify({ type: "user", message: { content: "old" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "mid" }] } }),
      JSON.stringify({ type: "user", message: { content: "new" } }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "latest" }] },
      }),
    ]
    await Bun.write(path, lines.join("\n"))

    const session: Session = { id: "session", path, mtime: Date.now(), format: "jsonl" }
    const { turns } = await loadSessionContent(session, transcriptArgs({ tailCount: 2 }), {}, false)

    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant"])
    expect(turns.map((turn) => turn.entry.message?.content)).toEqual([
      "new",
      [{ type: "text", text: "latest" }],
    ])
  })
})
