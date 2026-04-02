import { afterAll, describe, expect, test } from "bun:test"
import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { TranscriptIndexCache } from "./transcript-index-cache.ts"

const TEST_TRANSCRIPT = join("/tmp", `test-transcript-${Date.now()}.jsonl`)

function cleanup() {
  try {
    rmSync(TEST_TRANSCRIPT, { force: true })
  } catch {}
}

describe("TranscriptIndexCache", () => {
  afterAll(cleanup)

  test("correctly handles transcripts with compaction boundary", async () => {
    const lines = [
      JSON.stringify({ type: "user", message: { content: "Hello" } }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
      }),
      JSON.stringify({ type: "system", content: "Compacted" }), // Compaction boundary
      JSON.stringify({ type: "user", message: { content: "Next" } }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Bash", input: { command: "git status" } }],
        },
      }),
    ]
    writeFileSync(TEST_TRANSCRIPT, lines.join("\n"))

    const cache = new TranscriptIndexCache()
    const index = await cache.get(TEST_TRANSCRIPT)

    expect(index).not.toBeNull()
    if (index) {
      // Should only include tools after the compaction boundary
      expect(index.summary.toolNames).toEqual(["Bash"])
      expect(index.summary.bashCommands).toEqual(["git status"])
      expect(index.summary.sessionLines.length).toBe(0) // Should be stripped in cache
    }
  })

  test("correctly identifies blocked tool use IDs", async () => {
    const lines = [
      JSON.stringify({ type: "system", content: "Compacted" }),
      JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "You must act on this now: error",
            },
          ],
        },
      }),
    ]
    writeFileSync(TEST_TRANSCRIPT, lines.join("\n"))

    const cache = new TranscriptIndexCache()
    const index = await cache.get(TEST_TRANSCRIPT)

    expect(index).not.toBeNull()
    if (index) {
      expect(index.blockedToolUseIds).toEqual(["tool-1"])
    }
  })

  test("handles missing file gracefully", async () => {
    const cache = new TranscriptIndexCache()
    const index = await cache.get("/tmp/non-existent-transcript.jsonl")
    expect(index).toBeNull()
  })
})
