import { describe, expect, test } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
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
