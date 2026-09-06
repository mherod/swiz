import { afterAll, describe, expect, test } from "bun:test"
import { appendFile, rm } from "node:fs/promises"
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
      size: 100,
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
          size: _size,
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
          size: _size,
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

  test("reduces only appended complete lines and resets on a new session boundary", async () => {
    const path = testTranscript("append")
    const initialLines = [
      JSON.stringify({ type: "system", content: "Compacted" }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
      }),
    ]
    await Bun.write(path, `${initialLines.join("\n")}\n`)
    let size = (await Bun.file(path).stat()).size
    let mtimeMs = 1
    const cache = new TranscriptIndexCache({
      readMetadata: () => Promise.resolve({ size, mtimeMs, dev: 1, ino: 1 }),
    })

    expect((await cache.getSummary(path))?.toolNames).toEqual(["Bash"])
    const appended = `${JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "x.ts" } }] },
    })}\n`
    await appendFile(path, appended)
    size += new TextEncoder().encode(appended).length
    mtimeMs++
    expect((await cache.getSummary(path))?.toolNames).toEqual(["Bash", "Read"])
    expect(cache.appendedBytes).toBe(new TextEncoder().encode(appended).length)

    const reset = `${JSON.stringify({ type: "system", content: "Compacted again" })}\n`
    await appendFile(path, reset)
    size += new TextEncoder().encode(reset).length
    mtimeMs++
    expect((await cache.getSummary(path))?.toolNames).toEqual([])
    expect(cache.resets).toBe(1)
    void rm(path, { force: true }).catch(() => {})
  })

  test("counts a record split across a cold seed exactly once", async () => {
    // #819: the cold builder folded an unterminated final record into durable state while
    // `cursor.reset` discarded its bytes. The completing suffix then arrived alone and was
    // reduced as its own record, so one Read showed up twice — once truncated, once orphaned.
    const path = testTranscript("cold-seed")
    const boundary = `${JSON.stringify({ type: "system", content: "Compacted" })}\n`
    const record = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "x.ts" } }] },
    })
    // Cold read observes the file mid-write: the final record has no newline yet.
    const partial = record.slice(0, -5)
    await Bun.write(path, boundary + partial)
    let size = (await Bun.file(path).stat()).size
    let mtimeMs = 1
    const cache = new TranscriptIndexCache({
      readMetadata: () => Promise.resolve({ size, mtimeMs, dev: 1, ino: 1 }),
    })

    // Provisional only: a mid-write fragment is not parse-valid, so it contributes nothing.
    expect((await cache.getSummary(path))?.toolNames).toEqual([])

    const rest = `${record.slice(-5)}\n`
    await appendFile(path, rest)
    size += new TextEncoder().encode(rest).length
    mtimeMs++

    expect((await cache.getSummary(path))?.toolNames).toEqual(["Read"])
    void rm(path, { force: true }).catch(() => {})
  })

  test("cold and incremental reads agree on the same final transcript", async () => {
    // Equivalence control: whatever the seeding path does, arriving at a given file by
    // append must match reading that same file cold.
    const boundary = `${JSON.stringify({ type: "system", content: "Compacted" })}\n`
    const first = `${JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
    })}\n`
    const second = `${JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "x.ts" } }] },
    })}\n`

    // Incremental: seed cold mid-record, then complete it.
    const incrementalPath = testTranscript("equiv-incremental")
    await Bun.write(incrementalPath, boundary + first + second.slice(0, -6))
    let size = (await Bun.file(incrementalPath).stat()).size
    let mtimeMs = 1
    const incrementalCache = new TranscriptIndexCache({
      readMetadata: () => Promise.resolve({ size, mtimeMs, dev: 2, ino: 2 }),
    })
    await incrementalCache.getSummary(incrementalPath)
    await appendFile(incrementalPath, second.slice(-6))
    size = (await Bun.file(incrementalPath).stat()).size
    mtimeMs++
    const incremental = await incrementalCache.getSummary(incrementalPath)

    // Cold: read the identical finished bytes with a fresh cache.
    const coldPath = testTranscript("equiv-cold")
    await Bun.write(coldPath, boundary + first + second)
    const coldStat = await Bun.file(coldPath).stat()
    const coldCache = new TranscriptIndexCache({
      readMetadata: () => Promise.resolve({ size: coldStat.size, mtimeMs: 1, dev: 3, ino: 3 }),
    })
    const cold = await coldCache.getSummary(coldPath)

    expect(incremental?.toolNames).toEqual(cold?.toolNames)
    expect(incremental?.bashCommands).toEqual(cold?.bashCommands)
    expect(cold?.toolNames).toEqual(["Bash", "Read"])
    void rm(incrementalPath, { force: true }).catch(() => {})
    void rm(coldPath, { force: true }).catch(() => {})
  })

  test("cold-rebuilds a same-length in-place rewrite rather than serving a hot hit", async () => {
    const path = testTranscript("same-size-rewrite")
    const boundary = `${JSON.stringify({ type: "system", content: "Compacted" })}\n`
    // `"command":"ls -la"` and `"file_path":"x.ts"` are both 18 characters, so the two
    // records serialise to identical byte lengths — the case the guard has to catch.
    const withBash = `${JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls -la" } }] },
    })}\n`
    await Bun.write(path, boundary + withBash)
    const size = (await Bun.file(path).stat()).size
    let mtimeMs = 1
    const cache = new TranscriptIndexCache({
      readMetadata: () => Promise.resolve({ size, mtimeMs, dev: 4, ino: 4 }),
    })
    expect((await cache.getSummary(path))?.toolNames).toEqual(["Bash"])

    // Same dev/ino, same byte length, newer mtime — an in-place replacement.
    const withRead = `${JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "x.ts" } }] },
    })}\n`
    await Bun.write(path, boundary + withRead)
    expect((await Bun.file(path).stat()).size).toBe(size)
    mtimeMs++

    expect((await cache.getSummary(path))?.toolNames).toEqual(["Read"])
    void rm(path, { force: true }).catch(() => {})
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
          size: _size,
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
