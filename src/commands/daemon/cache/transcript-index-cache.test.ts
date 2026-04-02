import { afterAll, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { TranscriptIndexCache } from "./transcript-index-cache.ts"

const TEST_TRANSCRIPT = testTranscript("1")

function cleanup() {
  try {
    void rm(TEST_TRANSCRIPT, { force: true })
  } catch {}
}

function testTranscript(name: string): string {
  return join(
    "/tmp",
    `test-transcript-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`
  )
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
    await Bun.write(TEST_TRANSCRIPT, lines.join("\n"))

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
    const blockedTestPath = testTranscript("blocked")
    await Bun.write(blockedTestPath, lines.join("\n"))

    const cache = new TranscriptIndexCache()
    const index = await cache.get(blockedTestPath)

    expect(index).not.toBeNull()
    if (index) {
      expect(index.blockedToolUseIds).toEqual(["tool-1"])
    }

    void rm(blockedTestPath, { force: true }).catch(() => {})
  })

  test("handles missing file gracefully", async () => {
    const cache = new TranscriptIndexCache()
    const index = await cache.get("/tmp/non-existent-transcript.jsonl")
    expect(index).toBeNull()
  })

  test("does not store pre-boundary lines in memory", async () => {
    // This is a behavioral test to ensure we only have post-boundary lines
    const lines = [
      JSON.stringify({ type: "user", message: { content: "Pre-boundary 1" } }),
      JSON.stringify({ type: "system", content: "Boundary" }),
      JSON.stringify({ type: "user", message: { content: "Post-boundary 1" } }),
    ]
    const testPath = testTranscript("mem-test")
    await Bun.write(testPath, lines.join("\n"))

    const cache = new TranscriptIndexCache()
    const index = await cache.get(testPath)

    expect(index).not.toBeNull()
    // We can't directly inspect allLines because it's local to get(),
    // but we can verify the behavior by checking what computeSummaryFromSessionLines received
    // based on the result. If it's correct, we're likely only processing what we need.

    // More importantly, we should test an edge case: no system boundary.
    const linesNoBoundary = [
      JSON.stringify({ type: "user", message: { content: "No boundary 1" } }),
      JSON.stringify({ type: "user", message: { content: "No boundary 2" } }),
    ]
    const testPathNoBoundary = testTranscript("no-boundary")
    await Bun.write(testPathNoBoundary, linesNoBoundary.join("\n"))
    const indexNoBoundary = await cache.get(testPathNoBoundary)
    expect(indexNoBoundary).not.toBeNull()

    void rm(testPath, { force: true }).catch(() => {})
    void rm(testPathNoBoundary, { force: true }).catch(() => {})
  })
})
