import { describe, expect, it } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { TMP_ROOT } from "../temp-paths.ts"
import { appendJsonlEntry, readJsonlFileUntyped, writeJsonlFile } from "./jsonl.ts"

describe("JSONL locking", () => {
  it("should prevent concurrent write corruption", async () => {
    const testDir = join(TMP_ROOT, "swiz-jsonl-lock-test")
    await mkdir(testDir, { recursive: true })
    const filePath = join(testDir, "concurrent.jsonl")

    // Initialize
    await writeJsonlFile(filePath, [])

    const numWorkers = 5
    const iterationsPerWorker = 20
    const totalExpected = numWorkers * iterationsPerWorker

    const workers = Array.from({ length: numWorkers }).map(async (_, workerId) => {
      for (let i = 0; i < iterationsPerWorker; i++) {
        await appendJsonlEntry(filePath, { workerId, iteration: i })
        // Small random delay to increase chance of overlap
        await Bun.sleep(Math.random() * 50)
      }
    })

    await Promise.all(workers)

    const entries = await readJsonlFileUntyped(filePath)
    expect(entries.length).toBe(totalExpected)

    // Ensure all entries are present and unique
    const counts: Record<number, number> = {}
    for (const entry of entries as any[]) {
      counts[entry.workerId] = (counts[entry.workerId] || 0) + 1
    }

    for (let i = 0; i < numWorkers; i++) {
      expect(counts[i]).toBe(iterationsPerWorker)
    }

    // Cleanup
    await rm(testDir, { recursive: true, force: true })
  })

  it("should handle lock timeouts gracefully", async () => {
    // This is harder to test without mocking, but we can verify that
    // it eventually succeeds if the lock is released.
    const testDir = join(TMP_ROOT, "swiz-jsonl-timeout-test")
    await mkdir(testDir, { recursive: true })
    const filePath = join(testDir, "timeout.jsonl")

    // Create a fake lock file to block acquisition
    const { getLockPathForFile } = await import("./file-lock.ts")
    const lockFile = getLockPathForFile(filePath)
    await Bun.write(lockFile, "999999") // Fake PID

    // Start a write that should be blocked
    const writePromise = appendJsonlEntry(filePath, { test: "blocked" })

    // Wait a bit, then delete the lock
    await Bun.sleep(1000)
    await rm(lockFile, { force: true })

    await writePromise
    const entries = await readJsonlFileUntyped(filePath)
    expect(entries).toEqual([{ test: "blocked" }])

    // Cleanup
    await rm(testDir, { recursive: true, force: true })
  })

  it("creates parent directories for atomic append targets", async () => {
    const testDir = join(TMP_ROOT, "swiz-jsonl-parent-dir-test")
    const filePath = join(testDir, "nested", "dir", "entries.jsonl")

    await appendJsonlEntry(filePath, { id: 1 })

    const entries = await readJsonlFileUntyped(filePath)
    expect(entries).toEqual([{ id: 1 }])

    await rm(testDir, { recursive: true, force: true })
  })
})
