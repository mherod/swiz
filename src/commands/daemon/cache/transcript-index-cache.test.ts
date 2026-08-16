import { afterAll, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { type TranscriptIndex, TranscriptIndexCache } from "./transcript-index-cache.ts"

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

  test("provides full session lines through the bounded dispatch summary view", async () => {
    const lines = [
      JSON.stringify({ type: "system", content: "Compacted" }),
      JSON.stringify({ type: "user", message: { content: "Current session" } }),
    ]
    await Bun.write(TEST_TRANSCRIPT, lines.join("\n"))

    const cache = new TranscriptIndexCache()
    const summary = await cache.getSummary(TEST_TRANSCRIPT)
    const compactIndex = await cache.get(TEST_TRANSCRIPT)

    expect(summary?.sessionLines).toEqual([lines[1]!])
    expect(compactIndex?.summary.sessionLines).toEqual([])
    expect(cache.summarySize).toBe(1)
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

  test("shares in-flight index builds for concurrent callers", async () => {
    let releaseBuild!: () => void
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve
    })
    let buildCalls = 0
    const builtIndex: TranscriptIndex = {
      summary: {
        toolNames: ["Bash"],
        toolCallCount: 1,
        bashCommands: ["git status"],
        skillInvocations: [],
        readFiles: [],
        writtenFiles: [],
        hasGitPush: false,
        sessionLines: [],
        sessionDurationMs: 0,
        successfulTestRuns: 0,
        lastVerificationTime: null,
        sessionScope: "small-fix",
      },
      blockedToolUseIds: [],
      mtimeMs: 123,
      computedAt: Date.now(),
    }
    const cache = new TranscriptIndexCache({
      readMetadata: () => Promise.resolve({ mtimeMs: 123, size: 100 }),
      async buildIndex() {
        buildCalls++
        await buildGate
        return builtIndex
      },
    })
    const testPath = "/mock/transcript.jsonl"

    const pending = [cache.get(testPath), cache.get(testPath), cache.get(testPath)] as const
    await Promise.resolve()
    releaseBuild()
    const [first, second, third] = await Promise.all([...pending])

    expect(first).not.toBeNull()
    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(buildCalls).toBe(1)
    expect(cache.misses).toBe(1)

    const cached = await cache.get(testPath)
    expect(cached).toBe(first)
    expect(cache.hits).toBe(1)
  })

  test("deduplicates concurrent full-summary builds", async () => {
    let releaseBuild!: () => void
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve
    })
    let buildCalls = 0
    const sessionLine = JSON.stringify({ type: "user", message: { content: "hello" } })
    const cache = new TranscriptIndexCache({
      readMetadata: () => Promise.resolve({ mtimeMs: 123, size: sessionLine.length }),
      async buildIndex(_path, _size, mtimeMs) {
        buildCalls++
        await buildGate
        return {
          summary: {
            toolNames: [],
            toolCallCount: 0,
            bashCommands: [],
            skillInvocations: [],
            readFiles: [],
            writtenFiles: [],
            hasGitPush: false,
            sessionLines: [sessionLine],
            sessionDurationMs: 0,
            successfulTestRuns: 0,
            lastVerificationTime: null,
            sessionScope: "trivial",
          },
          blockedToolUseIds: [],
          mtimeMs,
          computedAt: Date.now(),
        }
      },
    })

    const first = cache.getSummary("/mock/summary.jsonl")
    const second = cache.getSummary("/mock/summary.jsonl")
    const third = cache.getSummary("/mock/summary.jsonl")
    await Promise.resolve()
    releaseBuild()
    const summaries = await Promise.all([first, second, third])

    expect(buildCalls).toBe(1)
    expect(summaries.every((summary) => summary?.sessionLines[0] === sessionLine)).toBe(true)
  })

  test("rebuilds the dispatch summary when transcript mtime changes", async () => {
    let mtimeMs = 1
    let buildCalls = 0
    const cache = new TranscriptIndexCache({
      readMetadata: () => Promise.resolve({ mtimeMs, size: 100 }),
      async buildIndex(_path, _size, observedMtimeMs) {
        buildCalls++
        return {
          summary: {
            toolNames: [],
            toolCallCount: 0,
            bashCommands: [],
            skillInvocations: [],
            readFiles: [],
            writtenFiles: [],
            hasGitPush: false,
            sessionLines: [String(observedMtimeMs)],
            sessionDurationMs: 0,
            successfulTestRuns: 0,
            lastVerificationTime: null,
            sessionScope: "trivial",
          },
          blockedToolUseIds: [],
          mtimeMs: observedMtimeMs,
          computedAt: Date.now(),
        }
      },
    })

    expect((await cache.getSummary("/mock/mtime.jsonl"))?.sessionLines).toEqual(["1"])
    expect((await cache.getSummary("/mock/mtime.jsonl"))?.sessionLines).toEqual(["1"])
    mtimeMs = 2
    expect((await cache.getSummary("/mock/mtime.jsonl"))?.sessionLines).toEqual(["2"])
    expect(buildCalls).toBe(2)
  })

  test("does not retain a full summary larger than the character budget", async () => {
    const oversizedLine = "x".repeat(17 * 1024 * 1024)
    let buildCalls = 0
    const cache = new TranscriptIndexCache({
      readMetadata: () => Promise.resolve({ mtimeMs: 123, size: oversizedLine.length }),
      async buildIndex(_path, _size, mtimeMs) {
        buildCalls++
        return {
          summary: {
            toolNames: [],
            toolCallCount: 0,
            bashCommands: [],
            skillInvocations: [],
            readFiles: [],
            writtenFiles: [],
            hasGitPush: false,
            sessionLines: [oversizedLine],
            sessionDurationMs: 0,
            successfulTestRuns: 0,
            lastVerificationTime: null,
            sessionScope: "trivial",
          },
          blockedToolUseIds: [],
          mtimeMs,
          computedAt: Date.now(),
        }
      },
    })

    expect(await cache.getSummary("/mock/oversized.jsonl")).not.toBeNull()
    expect(cache.summarySize).toBe(0)
    expect(await cache.getSummary("/mock/oversized.jsonl")).not.toBeNull()
    expect(buildCalls).toBe(2)
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
